# AGENTS.md

Frameyard is a local-first framework for deterministic, parameterized videos authored with HTML, CSS, and native JavaScript. The v0.1 core slice is implemented: composition contracts, browser runtime and preview, `init`/`dev`/`check`/`still`/`render`, Chromium capture, and FFmpeg output.

## Read first

- **Before changing public composition, props, audio, CLI, or JSON contracts**: read `docs/v0.1-design.md`, then `GLOSSARY.md` for domain terms.
- **Before changing determinism or rendering architecture**: read `docs/adr/0002-make-frame-and-props-the-only-animation-state.md` and `docs/adr/0003-render-browser-frames-offline.md`.
- **Before adding authoring APIs or asset-production features**: read `docs/adr/0001-keep-composition-authoring-web-native.md` and `docs/adr/0004-produce-local-ai-assets-outside-rendering.md`.
- **For usage and project layout**: read `README.md`.

## Commands

Use pnpm. The browser runtime is served from `dist/`, so build before starting the preview or running a single server/browser test.

```sh
pnpm install
pnpm exec playwright install chromium   # once per environment
pnpm build
pnpm typecheck
pnpm test                              # builds first, then runs the full suite
pnpm vitest run test/contracts.test.ts # one test file
```

Reference project:

```sh
node dist/cli.js check demo --project examples/demo
node dist/cli.js dev --project examples/demo
node dist/cli.js still demo --frame 240 --project examples/demo --out still.png
node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json --out demo.mp4
```

A full 30-second demo render is sequential and takes roughly 100 seconds on the reference machine. The test fixtures render tiny compositions.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/contracts.ts` | Shared composition, metadata, props, and audio contract |
| `src/runtime/` | Browser-only lifecycle, frame clock, deterministic randomness, diagnostics |
| `src/preview/` | Browser preview client: loading, scrubbing, playback, audio sync |
| `src/server/` | Node preview/static server and injected import map |
| `src/renderer/` | Node Chromium session, audio inspection/mixing, FFmpeg pipeline |
| `src/project.ts` | `video.config.js` loading and explicit composition discovery |
| `src/cli.ts` | Argument parsing, command execution, human/JSON results |
| `examples/demo/` | 30-second reference composition |
| `test/` | Public-seam tests |

`src/contracts.ts` and `src/runtime/` ship to the browser. Keep them free of `node:` imports. Node-only code belongs in `src/project.ts`, `src/server/`, `src/renderer/`, or `src/cli.ts`.

## Non-negotiable invariants

### Determinism

- A frame's visual state derives only from the integer `frame`, immutable `props`, and data/assets loaded before frame production.
- `update({ frame, props })` is synchronous and seek-safe. It must not depend on previously visited frames.
- `mount()` may await loading work; `dispose()` releases resources.
- Animation drivers are `update()` plus runtime-seeked CSS/Web Animations. `Math.random()`, `Date.now()`, `performance.now()`, timers, and independent `requestAnimationFrame` loops are not animation inputs. Use `random("stable:key")` from `frameyard/runtime`.
- The runtime seeks CSS animations and the Web Animations API inside the composition container. CSS transitions are diagnosed as non-deterministic in preview.
- The preview and production renderer must use the same composition bundle, runtime, and server. Production differs only in driving the clock explicitly and capturing frames.
- Remote data, fonts, and images belong in the loading phase before the first frame. After loading, `browser.ts` blocks network requests; a fetch from `update()` is a bug.
- Do not add a load hook or props-dependent metadata without revising the design baseline first. `width`, `height`, `fps`, and `durationInFrames` are fixed.

### Authoring contract

- Project compositions are native JavaScript ES modules; no transpilation.
- `video.config.js` explicitly maps IDs to entry modules. There is no directory scanning.
- Composition code imports bare `frameyard` and `frameyard/runtime`; the preview server injects the import map. Keep those specifiers stable.
- Composition props are plain JSON, deep-frozen, and merged shallowly over `defaultProps`.
- Composition functions are invoked on a frozen definition. Keep mutable state in module-scope variables, not on `this`.
- Audio clips use composition frames for placement and seconds for source trimming. Audio is mixed offline with FFmpeg; no time-stretching or automatic duration changes.
- Compositions are trusted local developer code. Do not claim sandboxing or untrusted execution.

### CLI and outputs

- Non-interactive commands support `--json`. With `--json`, stdout contains only the structured result/error envelope; progress and human diagnostics go to stderr.
- Keep error envelopes stable: `{ ok: false, command, error: { code, message } }`. Usage failures emitted before a command is known still produce an envelope with `command: null`.
- Failures exit nonzero. A render never publishes a partial file; it writes a temporary output and publishes atomically.
- Existing outputs are replaced only with `--overwrite`.
- Preserve exact frame counts in FFmpeg (`-frames:v`) and bounded audio (`-t`).
- `check` must inspect every frame and report audio clip durations/warnings without capturing or encoding.
- `still` uses the production capture path, not a separate renderer path.

### Scope

The current implementation intentionally excludes `tts`, `transcribe`, `doctor`, provenance manifests, transcript/karaoke support, the official agent skill, parallel rendering, frame caches, general image sequences, and plugin APIs. Implement those only when the task explicitly asks and the design baseline is revised.

## Change map

- **Contracts, props, metadata, audio validation** → `src/contracts.ts`, `src/index.ts`; extend `test/contracts.test.ts`.
- **Runtime seeking, randomness, diagnostics** → `src/runtime/`; extend `test/preview-runtime.test.ts` through real Chromium.
- **Preview behavior/UI** → `src/preview/main.ts`, `src/server/preview-html.ts`; extend the preview browser test.
- **Server routes, static serving, import map** → `src/server/server.ts`; extend `test/project-server.test.ts`.
- **Chromium capture, audio inspection, FFmpeg encoding** → `src/renderer/`; extend `test/cli-e2e.test.ts` and verify artifacts with FFprobe.
- **CLI flags, result schemas, exit behavior** → `src/cli.ts`; extend `test/cli-e2e.test.ts`.
- **Reference behavior** → `examples/demo/`; keep its README commands working.

## Testing

Test at public seams, not private helpers:

- `test/contracts.test.ts`: composition metadata, props, JSON serialization, audio clips.
- `test/random.test.ts`: frame time and deterministic randomness.
- `test/project-server.test.ts`: config loading, static routes, import map, ranges, traversal rejection.
- `test/preview-runtime.test.ts`: real Chromium loading, props, seeking, CSS animation, Canvas, determinism, diagnostics, preview UI.
- `test/cli-e2e.test.ts`: real CLI with Chromium and FFmpeg, JSON envelopes, missing assets, deterministic stills, MP4/audio output, overwrite behavior, `dev`, `init`.

Prefer one failing public-behavior test, then the minimal implementation. Use real Chromium and FFmpeg for production-path behavior; mock only external model executables when those integrations are added. Run `pnpm test` before finishing. Browser/CLI tests are intentionally sequential (`fileParallelism: false`).

## Before finishing

- `pnpm typecheck` passes.
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
