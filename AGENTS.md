# AGENTS.md

Frameyard is a local-first framework for deterministic, parameterized videos authored with HTML, CSS, and native JavaScript. The v0.1 design is implemented: composition contracts, browser runtime and preview, `init`/`dev`/`check`/`still`/`render`, `tts`/`transcribe`/`doctor`, Chromium capture, FFmpeg output, provenance manifests, transcript validation, and the official agent skill.

## Read first

- **Before changing public composition, props, audio, CLI, or JSON contracts**: read `docs/v0.1-design.md`, then `GLOSSARY.md` for domain terms.
- **Before changing determinism or rendering architecture**: read `docs/adr/0002-make-frame-and-props-the-only-animation-state.md`, `docs/adr/0003-render-browser-frames-offline.md`, and the reproducibility guarantee in `docs/v0.1-design.md` §3.
- **Before adding authoring APIs or asset-production features**: read `docs/adr/0001-keep-composition-authoring-web-native.md` and `docs/adr/0004-produce-local-ai-assets-outside-rendering.md`.
- **For usage and project layout**: read `README.md`.

## Commands

Use pnpm. The browser runtime is served from `dist/`, so build before starting the preview or running a single server/browser test.

```sh
pnpm install
pnpm exec playwright install chromium   # once per environment
pnpm build
pnpm typecheck
pnpm typecheck:test                    # typechecks test/*.ts
pnpm lint                              # oxlint
pnpm format:check                      # oxfmt --check
pnpm format                            # rewrite formatting with oxfmt
pnpm test                              # builds first, then runs the full suite
pnpm vitest run test/contracts.test.ts # one test file
pnpm bench                             # seek/capture/encode/full-render timings
```

`pnpm install` installs the local git hooks: pre-commit runs lint, formatting checks, typecheck, test typecheck, and unit tests; pre-push runs the full suite. Lint and formatting use `oxlint` and `oxfmt`; configuration lives in `.oxlintrc.json` and `.oxfmtrc.json`.

Releases are tag-driven. Read `RELEASING.md` before publishing. `pnpm set-version <version>` updates the package, runtime, and skill versions together; `pnpm set-version --check` verifies they agree.

Reference project:

```sh
node dist/cli.js check demo --project examples/demo
node dist/cli.js dev --project examples/demo
node dist/cli.js still demo --frame 240 --project examples/demo --out still.png
node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json --out demo.mp4
node dist/cli.js doctor
```

Documentation command examples: runnable examples in `README.md`, `skill/`, the `init` scaffold, and `init --json` `next` use `npx frameyard`; repository-internal commands (this file, `examples/demo/README.md`, and README's `Development` section) use `node dist/cli.js` after `pnpm build`. Command reference tables and `--help` usage lines keep the bare `frameyard` name. `test/docs.test.ts` enforces the user-facing rule, including the generated scaffold markdown in `src/scaffold.ts`.

A full 30-second demo render is sequential; run `pnpm bench` for current timings on the reference machine. The test fixtures render tiny compositions. TTS and transcription tests use fake `qwen-tts` and `whisper-cli` executables; real-model tests are opt-in.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/contracts.ts` | Shared composition, metadata, props, audio, and transcript requirement contract |
| `src/transcript.ts` | Canonical transcript validation and SRT/VTT formatting (browser-safe) |
| `src/runtime/` | Browser-only lifecycle, frame clock, deterministic randomness, diagnostics |
| `src/preview/` | Browser preview client: loading, scrubbing, playback, audio sync |
| `src/server/` | Node preview/static server and injected import map |
| `src/renderer/` | Node Chromium session, audio/transcript inspection, FFmpeg pipeline |
| `src/assets/` | TTS/transcription wrappers, executable resolution, atomic publishing, provenance |
| `src/doctor.ts` | Environment, integration, and manifest inspection |
| `src/project.ts` | `video.config.js` loading and explicit composition discovery |
| `src/scaffold.ts` | `init` scaffold templates: project config, props, composition, README, and agent guide |
| `src/cli.ts` | Argument parsing, command execution, human/JSON results |
| `skill/` | Official host-neutral agent skill and references |
| `examples/demo/` | 30-second reference composition |
| `test/` | Public-seam tests |

Per-frame path: `src/renderer/index.ts` loop (`seek` → `capture` → `writeFrame`) → `browser.ts` `seek()`/`capture()` (CDP `Page.captureScreenshot`) → `ffmpeg.ts` `writeFrame()` (stdin pipe) → `finish()`.

`src/contracts.ts`, `src/transcript.ts`, and `src/runtime/` ship to the browser. Keep them free of `node:` imports. Node-only code belongs in `src/project.ts`, `src/server/`, `src/renderer/`, `src/assets/`, `src/doctor.ts`, `src/scaffold.ts`, or `src/cli.ts`.

## Non-negotiable invariants

### Determinism

- A frame's visual state derives only from the integer `frame`, immutable `props`, and data/assets loaded before frame production.
- `update({ frame, props })` is synchronous and seek-safe. It must not depend on previously visited frames.
- `mount()` may await loading work; `dispose()` releases resources.
- Animation drivers are `update()` plus runtime-seeked CSS/Web Animations. `Math.random()`, `Date.now()`, `performance.now()`, timers, and independent `requestAnimationFrame` loops are not animation inputs. Use `random("stable:key")` from `frameyard/runtime`.
- The runtime seeks CSS animations and the Web Animations API inside the composition container. CSS transitions are diagnosed as non-deterministic in preview.
- The preview and production renderer must use the same composition bundle, runtime, and server. Production differs only in driving the clock explicitly and capturing frames.
- Verify determinism at the capture boundary: compare captured PNG pixels or `still` output, not MP4 hashes. Encoded bytes are not a reproducibility guarantee; see `docs/v0.1-design.md` §3.
- Remote data, fonts, and images belong in the loading phase before the first frame. After loading, `browser.ts` blocks network requests; a fetch from `update()` is a bug.
- Do not add a load hook or props-dependent metadata without revising the design baseline first. `width`, `height`, `fps`, and `durationInFrames` are fixed.

### Authoring contract

- Project compositions are native JavaScript ES modules; no transpilation.
- `video.config.js` explicitly maps IDs to entry modules. There is no directory scanning.
- Composition code imports bare `frameyard` and `frameyard/runtime`; the preview server injects the import map. Keep those specifiers stable.
- Composition props are plain JSON, deep-frozen, and merged shallowly over `defaultProps`.
- Composition functions are invoked on a frozen definition. Keep mutable state in module-scope variables, not on `this`.
- Audio clips use composition frames for placement and seconds for source trimming. Audio is mixed offline with FFmpeg; no time-stretching or automatic duration changes.
- Transcript requirements are project-relative canonical JSON. `words: true` requires measured word timings; never interpolate segment timings.
- Compositions are trusted local developer code. Do not claim sandboxing or untrusted execution.

### Generated assets

- Speech synthesis and transcription are explicit operations outside rendering. Never invoke them from `mount()`, `update()`, or frame production.
- Use the `tts` and `transcribe` wrappers; never call `qwen-tts` or `whisper-cli` directly from framework code or the agent skill.
- Outputs are written atomically. Failed or cancelled operations leave no apparently valid artifact and no manifest entry.
- Existing generated assets are replaced only with `--force`.
- The provenance manifest records artifact hashes, generator details, model identities, parameters, and source identity for transcription.
- Executable resolution order is explicit option, environment variable, then `PATH`.

### CLI and outputs

- Non-interactive commands support `--json`. With `--json`, stdout contains only the structured result/error envelope; progress and human diagnostics go to stderr.
- Keep error envelopes stable: `{ ok: false, command, error: { code, message } }`. Usage failures emitted before a command is known still produce an envelope with `command: null`.
- Failures exit nonzero. A render never publishes a partial file; it writes a temporary output and publishes atomically.
- Existing outputs are replaced only with `--overwrite` (stills/renders) or `--force` (generated assets).
- Preserve exact frame counts in FFmpeg (`-frames:v`) and bounded audio (`-t`).
- `check` must inspect every frame and report audio/transcript durations and warnings without capturing or encoding.
- `still` uses the production capture path, not a separate renderer path.
- `doctor` exits nonzero when required checks fail but does not throw away the structured findings.

### Scope

The current implementation still excludes built-in subtitle rendering, automatic caption burn-in, qwentts.cpp voice cloning/VoiceDesign, long-text chunking/streaming, automatic model downloads or environment repair, parallel rendering, frame caches, general image sequences, plugin APIs, and hosted/agent-only runtimes.

## Change map

- **Contracts, props, metadata, audio, transcripts** → `src/contracts.ts`, `src/transcript.ts`, `src/index.ts`; extend `test/contracts.test.ts` and `test/transcript.test.ts`.
- **Runtime seeking, randomness, diagnostics, transcript requirements** → `src/runtime/`; extend `test/preview-runtime.test.ts` through real Chromium.
- **Preview behavior/UI** → `src/preview/main.ts`, `src/server/preview-html.ts`; extend the preview browser test.
- **Server routes, static serving, import map** → `src/server/server.ts`; extend `test/project-server.test.ts`.
- **Chromium capture, audio/transcript inspection, FFmpeg encoding** → `src/renderer/`; extend `test/cli-e2e.test.ts` and verify artifacts with FFprobe.
- **TTS, transcription, provenance, executable resolution** → `src/assets/`; extend `test/assets-e2e.test.ts` with fake executables.
- **Doctor checks** → `src/doctor.ts`, `src/cli.ts`; extend `test/assets-e2e.test.ts`.
- **CLI flags, result schemas, exit behavior** → `src/cli.ts`; extend `test/cli-e2e.test.ts`.
- **Documentation command examples** → `README.md`, `skill/`, and `src/scaffold.ts`; extend `test/docs.test.ts` and the `init` case in `test/cli-e2e.test.ts`.
- **Init scaffold content** → `src/scaffold.ts` (package manifest and pinned scripts, project config, props, composition, README, agent guide, and `next`); keep the agent guide aligned with `skill/`; extend `test/scaffold.test.ts`, `test/docs.test.ts`, and the `init` case. When the scaffold file set changes, also update the `README.md` command table, `docs/v0.1-design.md` §6, and the scaffold README/agent guide.
- **Agent skill contract** → `skill/`, `package.json`; extend `test/skill.test.ts`.
- **Reference behavior** → `examples/demo/`; keep its README commands working.
- **Performance benchmarks** → `scripts/bench-render.mjs`, `bench/fixtures/`; keep `pnpm bench` representative of the production capture path.
- **Lint and formatting** → `.oxlintrc.json`, `.oxfmtrc.json`, `package.json`, `.githooks/pre-commit`, and the CI/release workflows; run `pnpm lint` and `pnpm format:check`.

## Testing

Test at public seams, not private helpers:

- `test/contracts.test.ts`: composition metadata, props, JSON serialization, audio clips, transcript requirements.
- `test/transcript.test.ts`: canonical transcript validation, word requirements, SRT/VTT formatting.
- `test/random.test.ts`: frame time and deterministic randomness.
- `test/project-server.test.ts`: config loading, static routes, import map, ranges, traversal rejection.
- `test/preview-runtime.test.ts`: real Chromium loading, props, seeking, CSS animation, Canvas, determinism, diagnostics, preview UI, transcript declarations.
- `test/cli-e2e.test.ts`: real CLI with Chromium and FFmpeg, JSON envelopes, missing assets, deterministic stills, MP4/audio output, overwrite behavior, `dev`, `init`.
- `test/assets-e2e.test.ts`: `tts`/`transcribe`/`doctor` with fake upstream executables, normalization, word timings, exports, manifests, cancellation, transcript validation.
- `test/agent-workflow.test.ts`: source preservation, check/still/render reporting, and failure reporting through the CLI.
- `test/real-integrations.test.ts`: opt-in real-model checks enabled by `FRAMEYARD_REAL_INTEGRATIONS=1` and explicit model paths.
- `test/skill.test.ts`: skill contents, API version, package inclusion, thin wrapper.
- `test/docs.test.ts`: user-facing command examples use `npx frameyard` in `README.md`, `skill/`, and the `init` scaffold; the scaffold's markdown is checked for fenced and inline commands, and README's `Development` section may use the local build.
- `test/scaffold.test.ts`: scaffold file generation, package manifest, and project-name normalization.

Prefer one failing public-behavior test, then the minimal implementation. Use real Chromium and FFmpeg for production-path behavior; mock only external model executables. Run `pnpm test` before finishing. Browser/CLI tests are intentionally sequential (`fileParallelism: false`).

## Before finishing

- `pnpm lint` passes.
- `pnpm format:check` passes.
- `pnpm typecheck` passes.
- `pnpm typecheck:test` passes.
- `pnpm test` passes after a build.
- If capture, encoding, or audio changed, render a small fixture and verify the artifact with FFprobe; render `examples/demo` when its composition changed.
- If public behavior changed, update `README.md` and, for contract changes, the design baseline or an ADR.
- Confirm failures still exit nonzero and leave no published partial output.

## Gotchas

- **Rebuild before browser work**: the server serves `/__frameyard/framework/*` from `dist/`.
- **Preview loads are serialized** through a queue. Add work through `api.load` / `enqueue`; do not call the internal load path directly.
- **Errors cross the Playwright boundary** as `[CODE] message`; `src/renderer/browser.ts` parses that tag back into a `FrameyardError`. Preserve the tag and stable codes.
- **Session close calls the runtime's `dispose()`** before closing the browser. Do not bypass that cleanup.
- **Network is blocked after loading** with `page.route`. Asset URLs must resolve during mount or `networkidle`; later requests fail the render.
- **FFmpeg capability checks** run before rendering (`libx264`, `aac`). Keep the actionable error path.
- **Diagnostics are best-effort**: preview mode wraps common forbidden clocks/randomness and warns on CSS transitions, but does not police third-party libraries perfectly.
- **`project.json` is derived from explicit config**, not scanning. New composition files must be listed in `video.config.js`.
- **Path containment** is lexical throughout the server, project loader, and audio resolver. The preview server binds loopback by default; treat project roots as trusted.
- **Point new docs at the environment** (`package.json` scripts, `--help`) for exhaustive option lists; keep this guide focused on workflow and unwritten conventions.
