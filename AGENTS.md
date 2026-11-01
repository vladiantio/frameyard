# AGENTS.md

Frameyard is a local-first framework for deterministic, parameterized videos authored with HTML compositions and JSON timelines. The 0.6 design is implemented: HTML composition documents, JSON timelines with tracks/clips and nested timelines, declarative bindings, CSS animation scheduling, frame-state variables, inline and external controllers, composition and timeline hosts, static validation, interactive preview with a read-only timeline, direct composition rendering, segmented lossless timeline rendering, audio and transcripts, Chromium capture, FFmpeg output, provenance manifests, and the official agent skill.

## Read first

- **Before changing public composition, props, audio, CLI, or JSON contracts**: read `docs/v0.1-design.md`, then `GLOSSARY.md` for domain terms.
- **Before changing timelines or nested timelines**: read `docs/adr/0010-make-timelines-the-render-unit.md`, `docs/adr/0011-compose-timeline-frames-in-a-live-browser-host.md` (preview-only), `docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md`, `skills/frameyard/references/timelines.md`, and the reproducibility guarantee in `docs/v0.1-design.md` §3.
- **Before changing determinism or rendering architecture**: read `docs/adr/0002-make-frame-and-props-the-only-animation-state.md`, `docs/adr/0003-render-browser-frames-offline.md`, `docs/adr/0005-keep-parallel-rendering-opt-in-and-frame-ordered.md`, `docs/adr/0009-composite-production-frames-in-software.md`, and the reproducibility guarantee in `docs/v0.1-design.md` §3.
- **Before changing authoring APIs or the HTML/controller boundary**: read `docs/adr/0001-keep-composition-authoring-web-native.md` (amended by ADR 0007), `docs/adr/0006-seek-embedded-media-from-the-frame-clock.md` (placement amended by ADR 0007), and `docs/adr/0007-make-html-documents-the-composition-unit.md`.
- **For usage and project layout**: read `README.md` and `docs/migration-0.4.md`.

## Commands

Use pnpm. The browser host and preview are served from `dist/`, so build before starting the preview or running a single server/browser test.

```sh
pnpm install
pnpm exec playwright install chromium   # once per environment
pnpm build
pnpm typecheck
pnpm typecheck:test                    # typechecks test/*.ts
pnpm typecheck:browser                 # typechecks browser-safe modules without Node types
pnpm lint                              # oxlint
pnpm format:check                      # oxfmt --check
pnpm format                            # rewrite formatting with oxfmt
pnpm check                             # scripts, lint, format, typechecks, full suite
pnpm test                              # builds first, then runs the full suite
pnpm vitest run test/contracts.test.ts # one test file
pnpm bench                             # seek/capture/encode/full-render timings
pnpm compare-stills a.png b.png        # exact decoded-pixel diff; exits nonzero on any difference
```

`pnpm install` installs the local git hooks: pre-commit runs `pnpm check:static` and the unit tests; pre-push runs the full suite. `pnpm check` is the single entry point CI, the release workflow, and local runs share; add new checks to `package.json`, not to the workflow files. Lint and formatting use `oxlint` and `oxfmt`; configuration lives in `.oxlintrc.json` and `.oxfmtrc.json`.

Releases are tag-driven. Read `RELEASING.md` before publishing. `pnpm set-version <version>` updates the package, runtime, and skill versions together; `pnpm set-version --check` verifies they agree; `pnpm retag-release <version>` recovers an unpublished tag after a failed release.

Reference project:

```sh
node dist/cli.js check demo-timeline --project examples/demo
node dist/cli.js dev --project examples/demo
node dist/cli.js still demo-timeline --frame 240 --project examples/demo --out still.png
node dist/cli.js render demo-timeline --project examples/demo --props examples/demo/props/demo.json
node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json
node dist/cli.js doctor
```

`render` defaults to `out/<id>.mp4` inside the project root; pass `--out` for another path. Timeline renders accept `--workers <n>` and `--scratch <dir>`; composition renders accept `--concurrency <n>`. The repository and scaffold ignore `out/`.

Documentation command examples: runnable examples in `README.md`, `skills/frameyard/`, the `init` scaffold, and `init --json` `next` use `npx frameyard`; repository-internal commands (this file, `examples/*/README.md`, and README's `Development` section) use `node dist/cli.js` after `pnpm build`. Command reference tables and `--help` usage lines keep the bare `frameyard` name. `test/docs.test.ts` enforces the user-facing rule, including the generated scaffold markdown in `src/scaffold.ts`; `test/examples.test.ts` enforces the example README rule.

A full 30-second demo timeline render is segmented and uses 8 workers by default; `--scratch <dir>` selects the FFV1 intermediate directory. Composition renders are sequential unless `--concurrency <n>` (1-16) is passed. Run `pnpm bench` for current composition timings; the timeline benchmark scripts under `bench/` are measurement tools, not production code; pass `--work`, `--project`, `--output`, and `--scratch` instead of editing paths. The test fixtures render tiny compositions/timelines. TTS and transcription tests use fake `qwen-tts` and `whisper-cli` executables; real-model tests are opt-in.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/contracts.ts` | Shared composition, metadata, props, audio, transcript, diagnostic, controller, and host contracts |
| `src/bindings.ts` | Browser-safe binding path validation, resolution, and value coercion |
| `src/composition/` | Browser-safe composition document reader, descriptor, per-kind declarations, adapter contract, and path rules |
| `src/html/parse.ts` | Node-only parse5 document helpers and source locations |
| `src/html/document-adapter.ts` | parse5 adapter for the composition document reader |
| `src/html/validate.ts` | Static composition validation and diagnostic extraction |
| `src/html/index.ts` | Node-only HTML validation exports |
| `src/transcript.ts` | Canonical transcript validation and SRT/VTT formatting (browser-safe) |
| `src/timeline/schema.ts` | Browser-safe timeline JSON schema, normalization, and pure validation |
| `src/timeline/resolve.ts` | Node-side timeline resolution: references, media, durations, nested timelines, cycles |
| `src/timeline/plan.ts` | Segment planning, active layers, source ranges, and ranges of nested timelines |
| `src/runtime/index.ts` | Frame/time conversion and stateless keyed deterministic randomness |
| `src/runtime/host.ts` | Browser composition host exposed as `window.__fy` |
| `src/runtime/bindings.ts` | Browser binding application and `--fy-prop-*` variables |
| `src/runtime/media.ts` | Embedded video/audio preparation, seeking, settling, and release |
| `src/runtime/diagnostics.ts` | Best-effort clock/randomness diagnostics around controller `mount`/`update` |
| `src/runtime/clock.ts` | Frame/time conversion |
| `src/runtime/random.ts` | Stateless keyed deterministic randomness |
| `src/preview/` | Composition preview client, timeline preview UI, timeline host, and playback transport |
| `src/preview/timeline-data.ts` | Serializable timeline preview data contract |
| `src/preview/timeline-host.ts` | Lazy timeline layer host: composition/nested iframes, media, seek, pool |
| `src/preview/timeline-main.ts` | Timeline preview page controller and embedded host API |
| `src/server/server.ts` | Static project server, `project.json`, HTML host injection, inline-controller route |
| `src/server/composition-html.ts` | parse5-based import map, sizing style, and host injection |
| `src/server/preview-html.ts` | Preview markup, iframe stage, diagnostics panel |
| `src/server/timeline-preview-data.ts` | Resolved timeline to preview-safe URLs, sources, and audio |
| `src/server/timeline-preview-html.ts` | Timeline preview and embedded timeline host markup |
| `src/renderer/browser.ts` | Chromium composition sessions, host loading, seek, capture, diagnostics |
| `src/renderer/index.ts` | Composition `check`, `still`, `render`, static validation integration, result schemas |
| `src/renderer/timeline.ts` | Timeline check/still/render, clip capture, segments, audio, nested timelines, atomic output |
| `src/renderer/audio.ts` | Audio timeline inspection and overrun diagnostics |
| `src/renderer/transcripts.ts` | Transcript validation and inspection |
| `src/renderer/ffmpeg.ts` | FFmpeg probing, encoding, FFV1, segment/frame composite, concat, mux, and offline audio mixing |
| `src/assets/` | TTS/transcription wrappers, executable resolution, atomic publishing, provenance |
| `src/doctor.ts` | Environment, integration, and manifest inspection |
| `src/project.ts` | `video.config.js` loading: project format, explicit `.html` compositions, `.json` timelines |
| `src/scaffold.ts` | `init` timeline-first scaffold: composition, timeline, config, props, README, agent guide |
| `src/cli.ts` | Argument parsing, composition/timeline routing, human/JSON results, diagnostics |
| `skills/frameyard/` | Official host-neutral agent skill and references |
| `examples/demo/` | 30-second reference HTML composition, external controller, and timeline |
| `examples/webgl/` | Focused WebGL shader example with an external controller |
| `examples/video/` | Embedded-video compositions (WebM and MP4) and WebM/MP4 timelines with video clips under a transparent HTML overlay |
| `test/` | Public-seam tests |

Per-frame path: `src/renderer/browser.ts` `openCompositionSession` navigates to the composition document, waits for `window.__fy`, calls `load`, then `seek`/`settle`/capture. `src/runtime/host.ts` applies bindings, imports the controller, mounts it, prepares media, sets frame-state variables, calls `update`, seeks animations, and settles media. `src/renderer/index.ts` merges static and runtime diagnostics into the result.

Timeline path: `src/timeline/resolve.ts` resolves the JSON and references; `src/timeline/plan.ts` splits segments and active layers; `src/renderer/timeline.ts` captures composition/nested ranges with `openCompositionSession({ transparentBackground: true })`, encodes FFV1, composites with FFmpeg, concatenates, mixes audio, publishes atomically, and cleans scratch. Preview uses `src/preview/timeline-host.ts` with a bounded lazy layer pool.

## Non-negotiable invariants

### Authoring

- A composition is a full HTML document with one `<fy-composition>` root. `video.config.js` explicitly maps IDs to `.html` entries; there is no directory scanning. JavaScript composition modules are rejected.
- Metadata (`width`, `height`, `fps`, `duration-in-frames`) is fixed on the root. Props cannot change it.
- Default props are a `data-fy="props"` JSON block. Props are JSON, deep-frozen, and merged shallowly over defaults.
- Bindings are explicit: `data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `data-fy-repeat` on `<template>`. Bindings apply once per load, before controller `mount`.
- The `fy` prefix is the authoring namespace: `fy-composition`, `fy-transcript`, `data-fy-*`, `--fy-*`, `text/fy-controller`. The package, CLI, config, manifest, server route, import specifier, and error codes remain `frameyard`.
- A composition has exactly one optional controller, inline or external. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required; `mount` and `update` are optional for validation-only controllers.
- The controller is the only executable code. Other executable `<script>` elements, `on*` handlers, `javascript:` URLs, and unsupported visual elements (`iframe`, `object`, `embed`) are rejected.
- Media and transcript `src` values resolve from the project root. The controller `src` and ordinary HTML asset URLs resolve relative to the composition document.
- `mount()` may await loading work. `update({ frame, props })` is synchronous and seek-safe. `dispose()` releases resources. Keep mutable state in module scope, not on `this`.

### Timelines

- A timeline is a versioned JSON document listed explicitly in `video.config.js`. `format` fixes width, height, and fps for every timeline; composition and timeline IDs share one namespace.
- Tracks are `video` or `audio`. Video tracks composite bottom-to-top; audio tracks mix. Clips on one track cannot overlap. No transitions or keyframes in 0.6.
- Clip sources are composition ID, nested timeline ID, or a project-relative video/image/audio path. `start`, `sourceIn`, and `duration` are project frames; image clips require a duration.
- Composition clips can fix `props` and trim the source range. Visual clips support static `fit`, `x`, `y`, `scale`, `rotation`, and `opacity`. Composition fps must match the project.
- Visual clips contribute audio automatically unless muted. Timeline audio clips live on audio tracks. Nested timelines are groups and include their audio.
- The timeline renderer is segmented: Chromium captures composition/nested ranges to alpha-preserving FFV1, FFmpeg composites and encodes segments in parallel, segments are concatenated in order, and audio is mixed once. Scratch is bounded and cleaned.

### Determinism

- A composition frame's visual state derives only from the integer `frame`, immutable `props`, and data/assets loaded before frame production. A timeline frame derives from its active clips and the same composition rules.
- Timeline composition frames are compared at clip capture; preview (Chromium composite) and production (FFmpeg composite) may differ slightly in scaling, alpha, and video color conversion.
- `update()` must not depend on previously visited frames. Declarative bindings apply once per load; controller-created DOM is not re-bound.
- Animation drivers are `update()`, runtime-seeked CSS/WAAPI, and `data-fy-anim-*` scheduling. `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, CSS transitions, and wall-clock reads are not animation inputs. Use `random("stable:key")`.
- Frame-state variables (`--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, `--fy-duration-frames`) are set on `document.documentElement` before controller `update`; animations are sought after `update`.
- Embedded `<video>` and `<audio>` are declared in the composition HTML with `data-fy-*` attributes. The host loads local files during the loading phase, pauses them, and seeks video after each `update()`; `settle()` waits for decode and paint.
- WebGL canvases must be redrawn from the current frame. Production sessions pin SwiftShader so pixels do not depend on the host GPU.
- Remote data, fonts, and images belong in the loading phase. Network requests are blocked during capture; a `fetch()` from `update()` is a bug.
- Verify determinism at the capture boundary: compare captured PNG pixels or `still` output, not MP4 hashes. Encoded bytes are not a reproducibility guarantee; see `docs/v0.1-design.md` §3.

### Static validation and diagnostics

- `src/html/validate.ts` parses composition HTML with parse5 and reports all static diagnostics in source order. It is Node-only. `src/contracts.ts`, `src/bindings.ts`, `src/composition/`, and `src/runtime/` must stay free of `node:` imports; `pnpm typecheck:browser` enforces it.
- `check`, `still`, and `render` run static validation before Chromium. Static errors fail without launching a browser; warnings allow frame evaluation. `dev` validates on composition request.
- Diagnostics carry `severity`, `code`, `message`, and optional `details` with `path`, `line`, `column`, `element`, `attribute`, `value`, and `suggestion`. Error envelopes carry optional `error.details` and top-level `diagnostics`.
- Unknown `data-fy-*` attributes, repeat misuse, controller declaration errors, executable scripts, event handlers, `javascript:` URLs, unsupported elements, and missing media/transcript references are errors. Missing binding paths and animation mismatches are warnings.
- The result schemas expose `entry`, `controller`, and top-level `diagnostics` for composition `check`, `still`, and `render`. Timeline results expose `timeline`, `format`, `tracks`, `clips`, and `diagnostics`; audio/transcript warnings are `AUDIO_WARNING`/`TRANSCRIPT_WARNING` diagnostics, not nested string arrays.
- `src/timeline/schema.ts` is browser-safe and strict: unknown fields, invalid sources, track mismatches, overlaps, and transform/audio values are errors. `src/timeline/resolve.ts` adds references, fps, media probes, source bounds, nested cycles, and props overrides.

### Host, preview, and rendering

- The preview server serves composition HTML at its real project path and injects the framework import map, sizing style, and host module only for configured composition entries.
- Inline controllers are served through the virtual URL `<composition>?__fy-controller`; the host imports either that URL or the external `src`. A composition has exactly one controller.
- `window.__fy` exposes `ready`, `metadata`, `defaultProps`, `props`, `controller`, `audioClips`, `embeddedAudioClips`, `transcriptClips`, `diagnostics`, `frame`, `load`, `seek`, `settle`, and `dispose`.
- Manual mode (`?__fy-manual`) waits for `load` and hides the root until the first successful load. Auto mode loads defaults and seeks frame 0. `load` validates props before disposing, restores the pristine DOM snapshot, re-applies bindings, remounts the controller, and prepares media.
- Preview loads the composition in a same-origin iframe and owns preview audio/playback. Props apply reuses the host `load`; composition changes reload the iframe with a unique load token. `check`, `still`, and `render` navigate directly to the composition URL and drive the same host API.
- The renderer uses static metadata for the viewport before navigation, blocks network after loading, and captures through CDP. Concurrency uses independent sessions but ordered writing; output order and pixels must match a sequential render.
- `check` exercises every frame; `still` follows the production capture path. A render writes a temporary output and publishes atomically; existing outputs are replaced only with `--overwrite`.
- Timeline preview serves `/__frameyard/timeline/<id>` and `.json`; embedded pages expose `window.__fyTimeline`. The preview host lazily loads active clips and evicts inactive layers; it is not the production compositor.
- Timeline production captures compositions with `transparentBackground: true`, preserves alpha in FFV1, and composites nested timelines as groups. `--workers` bounds segment concurrency; `--scratch` bounds intermediates. Composition rendering keeps `--concurrency`.
- Timeline `still` and `check` recurse into nested timelines; media-only frames are validated but not decoded frame-by-frame.

### Generated assets

- Speech synthesis and transcription are explicit operations outside rendering. Never invoke them from `mount()`, `update()`, or frame production.
- Use the `tts` and `transcribe` wrappers; never call `qwen-tts` or `whisper-cli` directly from framework code or the agent skill.
- Outputs are written atomically. Failed or cancelled operations leave no apparently valid artifact and no manifest entry.
- Existing generated assets are replaced only with `--force`.
- The provenance manifest records artifact hashes, generator details, model identities, parameters, and source identity for transcription.
- Executable resolution order is explicit option, environment variable, then `PATH`.

### CLI and outputs

- Non-interactive commands support `--json`. With `--json`, stdout contains only the structured result/error envelope; progress and human diagnostics go to stderr.
- Keep error envelopes stable: `{ ok: false, command, error: { code, message, details? }, diagnostics? }`. Usage failures emitted before a command is known still produce an envelope with `command: null`.
- Failures exit nonzero. A render never publishes a partial file.
- Preserve exact frame counts in FFmpeg (`-frames:v`) and bounded audio (`-t`).
- `check` must inspect every frame and report audio/transcript durations and diagnostics without capturing or encoding.
- `doctor` exits nonzero when required checks fail but does not throw away the structured findings.

## Change map

- **Contracts, props, audio, transcripts, diagnostics, host types** → `src/contracts.ts`, `src/transcript.ts`, `src/index.ts`; extend `test/contracts.test.ts`, `test/transcript.test.ts`.
- **Binding semantics** → `src/bindings.ts`, `src/runtime/bindings.ts`; extend `test/bindings.test.ts`, `test/host-runtime.test.ts`.
- **Composition document reading** → `src/composition/`, `src/html/document-adapter.ts`; extend `test/composition-document.test.ts`, `test/static-validation.test.ts`.
- **HTML parsing and static validation** → `src/html/parse.ts`, `src/html/validate.ts`; extend `test/static-validation.test.ts`, `test/server-html.test.ts`.
- **Host runtime** → `src/runtime/host.ts`, `src/runtime/media.ts`, `src/runtime/diagnostics.ts`; extend `test/host-runtime.test.ts`.
- **Timeline schema and resolution** → `src/timeline/schema.ts`, `src/timeline/resolve.ts`, `src/timeline/plan.ts`; extend `test/timeline-schema.test.ts`, `test/timeline-resolve.test.ts`, `test/timeline-plan.test.ts`.
- **Timeline rendering** → `src/renderer/timeline.ts`, `src/renderer/ffmpeg.ts`, `src/renderer/browser.ts`; extend `test/timeline-render.test.ts`, and verify artifacts with FFprobe.
- **Preview** → `src/preview/main.ts`, `src/server/preview-html.ts`; extend the HTML iframe case in `test/preview-runtime.test.ts`.
- **Timeline preview** → `src/preview/timeline-main.ts`, `src/preview/timeline-host.ts`, `src/preview/timeline-data.ts`, `src/server/timeline-preview-*.ts`; extend `test/timeline-preview.test.ts`, `test/timeline-preview-runtime.test.ts`.
- **Server routes, host injection, inline controller, `project.json`, timeline preview/data** → `src/server/server.ts`, `src/server/composition-html.ts`; extend `test/project-server.test.ts`, `test/server-html.test.ts`, `test/timeline-preview.test.ts`.
- **Chromium capture, audio/transcript inspection, FFmpeg** → `src/renderer/`; extend `test/cli-e2e.test.ts`, `test/video-determinism.test.ts`, and verify artifacts with FFprobe.
- **Static validation integration and result schemas** → `src/renderer/index.ts`, `src/renderer/timeline.ts`, `src/cli.ts`; extend `test/cli-e2e.test.ts`, `test/agent-workflow.test.ts`, `test/timeline-render.test.ts`.
- **TTS, transcription, provenance, executable resolution** → `src/assets/`; extend `test/assets-e2e.test.ts` with fake executables.
- **Doctor checks** → `src/doctor.ts`, `src/cli.ts`; extend `test/assets-e2e.test.ts`.
- **Init scaffold content** → `src/scaffold.ts` (project format, composition, timeline, config, props, README, agent guide, and `next`); keep the agent guide aligned with `skills/frameyard/`; extend `test/scaffold.test.ts`, `test/docs.test.ts`, and the `init` case. When the scaffold file set changes, update `README.md`, `docs/v0.1-design.md` §6, and the scaffold README/agent guide.
- **Agent skill contract** → `skills/frameyard/`, `package.json`; extend `test/skill.test.ts`.
- **Reference behavior** → `examples/demo/`, `examples/webgl/`, and `examples/video/`; keep their README commands working. The demo includes a timeline wrapping its composition; the video example includes WebM and MP4 timelines with video clips under a transparent overlay composition. Extend `test/examples.test.ts` when the example set or entry layout changes.
- **Performance benchmarks** → `scripts/bench-render.mjs`, `bench/fixtures/`, `bench/README.md`; keep `pnpm bench` representative of the composition capture path. Timeline benchmark scripts are temporary measurement tools; the production projection is in ADR 0012.
- **Lint and formatting** → `.oxlintrc.json`, `.oxfmtrc.json`, `package.json`, `.githooks/pre-commit`, and CI/release workflows; run `pnpm check:static`.
- **Release checks and versioning** → `scripts/set-version.mjs`, `scripts/verify-release.mjs`, `scripts/retag-release.mjs`, `RELEASING.md`, `.github/workflows/release.yml`; run `pnpm verify-release` after tagging.

## Testing

Test at public seams, not private helpers:

- `test/contracts.test.ts`: composition metadata, props, JSON serialization, audio clips, transcript requirements, diagnostics.
- `test/bindings.test.ts`: binding path syntax, resolution, repeat scope, value coercion, suggestions.
- `test/static-validation.test.ts`: HTML metadata, defaults, bindings, scripts, controllers, media, transcripts, source locations, diagnostics.
- `test/server-html.test.ts`: `.html` entries, host injection, virtual inline controller, static error pages, `project.json` diagnostics.
- `test/host-runtime.test.ts`: host bindings, repeat/if/class, animation scheduling, frame variables, inline/external controllers, props validation, load atomicity, dispose, diagnostics, auto mode, media settle.
- `test/project-server.test.ts`: config loading, static routes, import map, ranges, traversal rejection.
- `test/preview-runtime.test.ts`: HTML iframe preview, props, seeking, CSS animation, Canvas, WebGL, embedded video, determinism, diagnostics.
- `test/cli-e2e.test.ts`: real CLI with Chromium and FFmpeg, JSON envelopes, missing assets, deterministic stills across concurrent sessions, embedded video/WebGL capture and audio, MP4/audio output, overwrite behavior, HTML check/still/render, static diagnostics, `dev`, `init`.
- `test/video-determinism.test.ts`: a full-scene opacity animation over embedded video captures the requested frame, and consecutive composition frames map to consecutive source frames.
- `test/examples.test.ts`: example README commands use the repository CLI, and each bundled example captures a still.
- `test/assets-e2e.test.ts`: `tts`/`transcribe`/`doctor` with fake upstream executables, normalization, word timings, exports, manifests, cancellation, transcript validation.
- `test/agent-workflow.test.ts`: source preservation, check/still/render reporting, failure reporting through the CLI.
- `test/real-integrations.test.ts`: opt-in real-model checks enabled by `FRAMEYARD_REAL_INTEGRATIONS=1` and explicit model paths.
- `test/skill.test.ts`: skill layout discovery, frontmatter name, single skill, contents, API version, package inclusion, thin wrapper.
- `test/docs.test.ts`: user-facing command examples use `npx frameyard`; scaffold markdown commands and package scripts are real.
- `test/release.test.ts`: CI, release workflow, and pre-commit hook share `pnpm check`; release metadata verification.
- `test/scaffold.test.ts`: scaffold file generation, package manifest, project-name normalization.

Prefer one failing public-behavior test, then the minimal implementation. Use real Chromium and FFmpeg for production-path behavior; mock only external model executables. Run `pnpm test` before finishing. Browser/CLI tests are intentionally sequential (`fileParallelism: false`).

## Before finishing

- `pnpm check` passes (script syntax, lint, formatting, typechecks, then the full suite).
- If capture, encoding, or audio changed, render a small fixture and verify the artifact with FFprobe; render the example whose composition changed.
- If public behavior changed, update `README.md` and, for contract changes, the design baseline or an ADR.
- Confirm failures still exit nonzero and leave no published partial output.

## Gotchas

- **Rebuild before browser work**: the server serves `/__frameyard/framework/*` from `dist/`.
- **Iframe preview**: the parent owns preview audio/playback. Props apply reuses the host; composition changes reload the iframe with a unique `__fy-load` token. Cross-realm props are cloned into the iframe realm before `load`.
- **Host load**: validates props before disposing, restores the pristine DOM snapshot, re-applies bindings, remounts the controller, and prepares media. `seek`/`settle` before a successful load reject `COMPOSITION_NOT_READY`; `dispose` during a load rejects `COMPOSITION_DISPOSED`.
- **Errors cross the Playwright boundary** as `[CODE] message`; `src/renderer/browser.ts` parses that tag back into a `FrameyardError`. Preserve the tag and stable codes.
- **Session close calls the host's `dispose()`** before closing the browser. Do not bypass that cleanup.
- **Network is blocked after loading** with `page.route`. Asset URLs must resolve during loading; later requests fail the render.
- **FFmpeg capability checks** run before rendering (`libx264`, `aac`). Keep the actionable error path.
- **Diagnostics are best-effort**: the host wraps common forbidden clocks/randomness in `mount`/`update`, but does not police every third-party library perfectly.
- **`project.json` is derived from explicit config**, not scanning. New `.html` compositions must be listed in `video.config.js`.
- **Path containment** is lexical throughout the server, project loader, and media resolver. The preview server binds loopback by default; treat project roots as trusted.
- **Media/transcript paths** resolve from the project root. Controller `src` and ordinary HTML asset URLs resolve from the composition document.
- **Full-scene fades over video**: Chromium can reuse the load frame in interactive preview after a large seek. Fade overlay layers instead. Capture sessions keep the composition hidden until the first seek, and `test/video-determinism.test.ts` covers that path.
- **Pixel diffs**: use `pnpm compare-stills` for decoded-pixel checks; ImageMagick `compare` can report color-profile noise on identical PNGs.
- **Inline controllers** are served through `<composition>?__fy-controller`; a literal `</script>` in inline source must be escaped. Exactly one controller is allowed.
