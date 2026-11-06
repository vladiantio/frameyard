# AGENTS.md

Frameyard is a local-first framework for deterministic, parameterized videos authored with HTML compositions and JSON timelines. The 0.8 design is implemented: HTML composition fragments, static (timeless) compositions rendered as PNGs, JSON timelines with tracks/clips, nested timelines, timeline clip keyframes, clip transitions, declarative bindings, CSS animation scheduling, frame-state variables, inline and external controllers, composition and timeline hosts, static validation, interactive preview with a read-only timeline, direct composition rendering, segmented lossless timeline rendering, audio and transcripts, Chromium capture, FFmpeg output, provenance manifests, and the official agent skill.

## Read first

- **Before changing public composition, props, audio, CLI, or JSON contracts**: read `docs/v0.x-design.md`, then `GLOSSARY.md` for domain terms.
- **Before changing fonts or the generated font sheet**: read `docs/adr/0023-pin-fonts-as-project-assets.md` and `skills/frameyard/references/fonts.md`.
- **Before changing timelines or nested timelines**: read `docs/adr/0010-make-timelines-the-render-unit.md`, `docs/adr/0011-compose-timeline-frames-in-a-live-browser-host.md` (preview-only), `docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md`, `docs/adr/0018-animate-timeline-clips-with-keyframes.md`, `docs/adr/0019-make-same-track-overlap-the-transition-window.md`, `docs/adr/0020-crossfade-audio-clips-on-audio-tracks.md`, `docs/adr/0021-project-timeline-scenes-once.md`, `docs/adr/0024-stream-composition-captures-and-skip-trivial-composites.md`, `docs/adr/0025-capture-timeline-layers-in-parallel-with-a-global-limit.md`, `docs/adr/0026-reuse-loaded-composition-sessions-across-segments.md`, `docs/adr/0027-encode-two-full-frame-layers-through-dual-pipes.md`, `docs/adr/0028-encode-full-frame-video-segments-directly.md`, `skills/frameyard/references/timelines.md`, and the reproducibility guarantee in `docs/v0.x-design.md` §3.
- **Before changing determinism or rendering architecture**: read `docs/adr/0002-make-frame-and-props-the-only-animation-state.md`, `docs/adr/0003-render-browser-frames-offline.md`, `docs/adr/0005-keep-parallel-rendering-opt-in-and-frame-ordered.md`, `docs/adr/0009-composite-production-frames-in-software.md`, `docs/adr/0024-stream-composition-captures-and-skip-trivial-composites.md`, `docs/adr/0025-capture-timeline-layers-in-parallel-with-a-global-limit.md`, `docs/adr/0026-reuse-loaded-composition-sessions-across-segments.md`, `docs/adr/0027-encode-two-full-frame-layers-through-dual-pipes.md`, `docs/adr/0028-encode-full-frame-video-segments-directly.md`, and the reproducibility guarantee in `docs/v0.x-design.md` §3.
- **Before changing authoring APIs or the HTML/controller boundary**: read `docs/adr/0001-keep-composition-authoring-web-native.md` (amended by ADR 0007), `docs/adr/0006-seek-embedded-media-from-the-frame-clock.md` (placement amended by ADR 0007), and `docs/adr/0007-make-html-documents-the-composition-unit.md`.
- **Before changing static composition behavior**: read `docs/adr/0017-render-timeless-compositions-as-stills.md` and `docs/migration-0.8.md`.
- **For usage and project layout**: read `README.md`, `docs/migration-0.4.md`, and `docs/migration-0.8.md`.
- **For preview tests or browser probes**: read `docs/preview-testing.md`.

## Local-model scaffold

Local-model host setup is opt-in. The repository does not commit a root `fy.policy.json`, `.opencode/`, or `.pi/`; install `scaffolds/local-models/` with `npx frameyard add local-models`, or use `npx frameyard init <dir> --local-models` for a new project. See `scaffolds/local-models/LOCAL-MODELS.md`.

The scaffold provides an `authoring` policy with the `shared-cpu` profile, OpenCode shell/edit restrictions, Pi settings and append prompt, and a disabled Pi sandbox. Without it, the CLI defaults to `full`. The policy blocks `tts`, `transcribe`, and `render`, allows `check` at low priority, and caps `still` at four frames. Use `context` for a project digest, `lint` for the edit loop, `--dry-run` for a handoff command, and `inspect`/`compare` for text-only still checks. `add` writes a template and prints the exact `fy.config.js` registration snippet. The nearest policy file is discovered from the working directory upward, independent of `fy.config.js`; see `docs/adr/0022-gate-heavy-operations-with-a-workspace-resource-policy.md`.

The policy is a guardrail, not a security boundary. A human who intentionally runs a heavy command prefixes it with `FRAMEYARD_POLICY=full`, for example `FRAMEYARD_POLICY=full node dist/cli.js render demo-timeline --project examples/demo`. Tests and benchmarks that render through the CLI from the repository root do the same; tests that exercise the policy set `FRAMEYARD_POLICY=authoring` explicitly.

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
pnpm check                             # scripts, lint, format, build/typechecks, full suite
pnpm check:preview                     # static checks, then build + preview tests
pnpm test                              # builds first, then runs the full suite
pnpm test:built                        # runs both projects against the current dist
pnpm test:integration                  # builds first, then the browser/FFmpeg project
pnpm test:examples                     # builds first, then the bundled example stills
pnpm test:preview                      # builds first, then runs the preview test files
pnpm test:unit                         # fast parallel project used by the pre-commit hook
pnpm test test/contracts.test.ts       # one test file, builds first
pnpm bench                             # seek/capture/encode/full-render timings
pnpm bench:static                      # animated composition vs the same visual as a static PNG
pnpm eval:local --model <id> --only <task>   # opt-in local-model authoring eval; never renders
pnpm compare-stills a.png b.png        # exact decoded-pixel diff; exits nonzero on any difference
pnpm check:changelog                   # commits since the last tag touch CHANGELOG.md, declare Changelog: skip, or only change examples/
pnpm verify-package                    # packed tarball contains every required path and bin target
```

`pnpm install` installs the local git hooks: pre-commit runs `pnpm check:static` and the unit project; pre-push runs the full suite unless the exact tree already passed `pnpm check` (the stamp lives in `.git`). A commit-msg hook warns when a user-facing commit does not stage `CHANGELOG.md`. `pnpm check` remains the single entry point CI and the release workflow share; `pnpm check:preview` is a local subset for preview-only UI work, not a CI replacement. Add new checks to `package.json`, not to the workflow files. Lint and formatting use `oxlint` and `oxfmt`; configuration lives in `.oxlintrc.json` and `.oxfmtrc.json`.

Vitest runs two projects: `unit` covers source-only tests in parallel without a build, and `integration` owns the files that launch Chromium, FFmpeg, or `dist/cli.js` and runs up to three files at a time locally, scaled to core count (one on CI). `pnpm test:unit` selects the first, `pnpm test:integration` builds and selects the second, and bare `vitest run` runs both. Add a new source-only test to the unit project automatically; if it needs `dist/`, list it in `integrationTests` in `vitest.config.ts`.

Browser and CLI tests spawn `dist/cli.js`, so run one file with `pnpm test <file>`; a bare `pnpm vitest run <file>` skips the build and tests the previous binary. After edits limited to docs, the skill, or scaffold prose, `pnpm check:static` plus `pnpm vitest run test/docs.test.ts test/skill.test.ts test/scaffold.test.ts` covers the change; reserve the full `pnpm check` for the final state.

Releases are tag-driven. Read `RELEASING.md` before publishing. Feature and fix commits add a `CHANGELOG.md` entry under `## [Unreleased]` or declare `Changelog: skip`; commits that only change `examples/` are exempt. `pnpm check:changelog` and `pnpm verify-release` enforce coverage, and `[Unreleased]` must be empty at tag time. `pnpm set-version <version>` updates the package, runtime, and skill versions together; `pnpm set-version --check` verifies they agree; `pnpm verify-package` checks the packed tarball; `pnpm retag-release <version>` recovers an unpublished tag after a failed release.

Reference project:

```sh
node dist/cli.js lint demo-timeline --project examples/demo
node dist/cli.js check demo-timeline --project examples/demo
node dist/cli.js dev --project examples/demo
node dist/cli.js still demo-timeline --frame 240 --project examples/demo --out still.png
FRAMEYARD_POLICY=full node dist/cli.js render demo-timeline --project examples/demo --props examples/demo/props/demo.json
FRAMEYARD_POLICY=full node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json
node dist/cli.js check still --project examples/static
FRAMEYARD_POLICY=full node dist/cli.js render still --project examples/static --out examples/static/out/still.png
FRAMEYARD_POLICY=full node dist/cli.js render still-timeline --project examples/static
node dist/cli.js doctor
```

`render` defaults to `out/<id>.mp4` inside the project root for timelines and animated compositions, and `out/<id>.png` for static compositions; pass `--out` for another path. Timeline renders accept `--workers <n>` and `--scratch <dir>`; animated composition renders accept `--concurrency <n>`. Both video paths accept `--container <mp4|mov|mkv|webm>`, `--codec <h264|hevc|vp9>`, and `--encoder <auto|software|nvenc|qsv>`; the default is MP4/H.264 with `auto`, which probes hardware and falls back to software, WebM defaults to VP9, the output extension must match the container, and the probe is a one-frame encode. A static composition render rejects those four flags. The repository and scaffold ignore `out/`.

Documentation command examples: runnable examples in `README.md`, `skills/frameyard/`, the `init` scaffold, and `init --json` `next` use `npx frameyard`; repository-internal commands (this file, `examples/*/README.md`, and README's `Development` section) use `node dist/cli.js` after `pnpm build`. Command reference tables and `--help` usage lines keep the bare `frameyard` name. `test/docs.test.ts` enforces the user-facing rule, including the generated scaffold markdown in `src/scaffold.ts`; `test/examples.test.ts` enforces the example README rule.

A full 30-second demo timeline render is segmented and uses 8 workers by default; `--scratch <dir>` selects the FFV1 intermediate directory. Composition renders are sequential unless `--concurrency <n>` (1-16) is passed. Run `pnpm bench` for current composition timings; the timeline benchmark scripts under `bench/` are measurement tools, not production code; pass `--work`, `--project`, `--output`, and `--scratch` instead of editing paths. The test fixtures render tiny compositions/timelines. TTS and transcription tests use fake `qwen-tts`, `sherpa-onnx-offline-tts`, and `whisper-cli` executables; real-model tests are opt-in. `pnpm eval:local` is an opt-in local-model authoring eval against a llama.cpp router; it never renders and is not part of `pnpm check`. See `evals/README.md`.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/contracts.ts` | Shared composition, metadata, props, audio, transcript, diagnostic, controller, and host contracts |
| `src/bindings.ts` | Browser-safe binding path validation, resolution, and value coercion |
| `src/composition/` | Browser-safe composition grammar reader (document and fragment scopes), descriptor, declared-format resolution against the project format, per-kind declarations, adapter contract, and path rules |
| `src/html/parse.ts` | Node-only parse5 document and fragment helpers, and source locations |
| `src/html/document-adapter.ts` | parse5 adapter for the composition grammar reader |
| `src/html/validate.ts` | Static composition validation and diagnostic extraction |
| `src/html/index.ts` | Node-only HTML validation exports |
| `src/transcript.ts` | Canonical transcript validation and SRT/VTT formatting (browser-safe) |
| `src/fonts/` | Browser-safe font manifest schema, CSS generation, options, and Node-only Fontsource/local/URL installation, verification, and removal |
| `src/timeline/schema.ts` | Browser-safe timeline JSON schema, normalization, and pure validation |
| `src/timeline/easing.ts` | Browser-safe CSS timing-function parsing and evaluation |
| `src/timeline/keyframes.ts` | Browser-safe clip-local keyframe evaluation and marker helpers |
| `src/timeline/transitions.ts` | Browser-safe transition progress and equal-power gain helpers |
| `src/timeline/resolve.ts` | Node-side timeline resolution: references, media, durations, nested timelines, cycles |
| `src/timeline/scene.ts` | Browser-safe timeline scene projection: active layers, transition roles, composite order, capture modes, source ranges, and presentation defaults |
| `src/timeline/plan.ts` | Segment planning over the timeline scene projection, including ranges of nested timelines |
| `src/runtime/index.ts` | Frame/time conversion and stateless keyed deterministic randomness |
| `src/runtime/host.ts` | Browser composition host exposed as `window.__fy` |
| `src/runtime/bindings.ts` | Browser binding application and `--fy-prop-*` variables |
| `src/runtime/media.ts` | Embedded video/audio preparation, seeking, settling, and release |
| `src/runtime/video.ts` | Shared video paint barrier: `requestVideoFrameCallback` with animation-frame and timeout fallbacks |
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
| `src/renderer/timeline.ts` | Timeline check/still/render, streaming clip capture, direct delivery segments, segments, audio, nested timelines, atomic output |
| `src/renderer/audio.ts` | Audio timeline inspection and overrun diagnostics |
| `src/renderer/transcripts.ts` | Transcript validation and inspection |
| `src/renderer/ffmpeg.ts` | FFmpeg probing, encoding, FFV1, segment/frame composite, concat, mux, and offline audio mixing |
| `src/renderer/keyframe-expressions.ts` | FFmpeg keyframe expressions with the adaptive easing approximation |
| `src/assets/` | TTS (qwentts.cpp and sherpa-onnx Supertonic) and transcription wrappers, executable resolution, atomic publishing, provenance |
| `src/doctor.ts` | Environment, integration, and manifest inspection |
| `src/project.ts` | `fy.config.js` loading: project format, explicit `.html` compositions, `.json` timelines |
| `src/policy.ts` | Workspace resource policy discovery, strict validation, tiers, profiles, operation gating, and process priority |
| `src/lint.ts` | Node-only lint: static validation, timeline resolution, scene/keyframe projection, and controller determinism scanning |
| `src/context.ts` | Compact project digest: format, composition metadata, prop types, timeline clips, assets, diagnostics, policy, and next commands |
| `src/inspect.ts` | Image decoding through FFmpeg, blank/alpha/color/bbox analysis, and pixel/region comparison |
| `src/templates.ts` | Project templates for `frameyard add` |
| `fy.policy.json` | Workspace resource tier when installed; the local-model scaffold uses `authoring` + `shared-cpu` |
| `scaffolds/init/` | `init` template sources: composition, timeline, config, props, README, agent guide, package manifest |
| `src/scaffold.ts` | Reads `scaffolds/init/` and `scaffolds/local-models/`, renders placeholders, and exposes the scaffold file maps |
| `src/cli.ts` | Argument parsing, composition/timeline/lint/context/inspect/compare/add routing, policy gating, dry-run handoff, human/JSON results, diagnostics |
| `skills/frameyard/` | Official host-neutral agent skill and references |
| `scaffolds/local-models/` | Opt-in policy, OpenCode, and Pi configuration for a workspace shared with a local model |
| `evals/` | Opt-in local-model authoring eval: tasks, llama.cpp router runner, token/time/resource report |
| `examples/demo/` | 30-second reference HTML composition, external controller, and timeline |
| `examples/intro/` | 20-second intro film with four scenes, a persistent HUD overlay, three dissolves, vendored fonts, and a generated score |
| `examples/webgl/` | Focused WebGL shader example with an external controller |
| `examples/video/` | Embedded-video compositions (WebM and MP4) and WebM/MP4 timelines with video clips under a transparent HTML overlay |
| `examples/blend/` | Static CSS blend modes on composition and video timeline clips |
| `examples/nested/` | Inner timelines placed in an outer timeline as full-frame and transformed group clips |
| `test/` | Public-seam tests |

Per-frame path: `src/renderer/browser.ts` `openCompositionSession` navigates to the served composition URL, waits for `window.__fy`, calls `load`, then `seek`/`settle`/capture. `src/runtime/host.ts` applies bindings, imports the controller, mounts it, prepares media, sets frame-state variables, calls `update`, seeks animations, and settles media. A static composition stops after bindings and `mount()`, skips media preparation and frame state, pauses CSS animations at time 0, and captures one PNG. `src/renderer/index.ts` merges static and runtime diagnostics into the result.

Timeline path: `src/timeline/resolve.ts` resolves the JSON and references; `src/timeline/scene.ts` projects the active layers, transition roles, composite order, source ranges, and presentation for a frame or segment; `src/timeline/plan.ts` splits segments over that projection; `src/renderer/keyframe-expressions.ts` builds per-frame transform and opacity expressions; `src/renderer/timeline.ts` captures composition/nested ranges with `openCompositionSession({ transparentBackground: true })`, encodes FFV1, composites with FFmpeg, concatenates, mixes audio, publishes atomically, and cleans scratch. Preview serializes the resolved timeline, then uses `src/preview/timeline-host.ts` with the same scene projection and a bounded lazy layer pool.

## Non-negotiable invariants

### Authoring

- A composition is a partial HTML fragment with one top-level `<fy-composition>` root. `fy.config.js` explicitly maps IDs to `.html` entries; there is no directory scanning. JavaScript composition modules are rejected.
- The framework generates the document shell (`<!doctype>`, `<html>`, `<head>`, `<body>`, charset, title, import map, sizing style, format block, and host module). Authors must not declare those elements. Props blocks, the controller, and import maps are top-level siblings; top-level `<style>` and `<link rel="stylesheet">` are hoisted into the generated head. The reserved `data-fy-host` attribute and `data-fy="format"` block are framework-only.
- Metadata (`width`, `height`, `fps`, `duration-in-frames`) is fixed on the root. `width`, `height`, and `fps` are optional and inherit the project `format` when absent (declared values win, `width`/`height` are declared together). `duration-in-frames` is optional only for a static composition. Props cannot change metadata.
- A static composition declares neither `duration-in-frames` nor `fps`. It has no frame clock, is captured once, and renders to a PNG. `fps` without `duration-in-frames` is an error. A static composition is visual-only: `data-fy-anim-*`, `<video>`, `<audio>`, and `<fy-transcript>` are errors. Its controller may `mount()` and validate props, but `update()` is not called, frame-state variables are not set, CSS animations are paused at time 0, and `STATIC_UPDATE_IGNORED`/`STATIC_ANIMATION_PAUSED` are warnings.
- The resolved format is part of the immutable frame environment. A composition that omits dimensions in a project without `format` fails with `COMPOSITION_FORMAT_UNRESOLVED`.
- Default props are a `data-fy="props"` JSON block. Props are JSON, deep-frozen, and merged shallowly over defaults.
- Bindings are explicit: `data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `data-fy-repeat` on `<template>`. Bindings apply once per load, before controller `mount`.
- The `fy` prefix is the authoring namespace: `fy-composition`, `fy-transcript`, `data-fy-*`, `--fy-*`, `text/fy-controller`. The package, CLI, config, manifest, server route, import specifier, and error codes remain `frameyard`.
- A composition has exactly one optional controller, inline or external. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required; `mount` and `update` are optional for validation-only controllers.
- The controller is the only executable code. Other executable `<script>` elements, `on*` handlers, `javascript:` URLs, and unsupported visual elements (`iframe`, `object`, `embed`) are rejected.
- Media and transcript `src` values resolve from the project root. The controller `src` and ordinary HTML asset URLs resolve relative to the composition URL.
- `mount()` may await loading work. `update({ frame, props })` is synchronous and seek-safe. `dispose()` releases resources. Keep mutable state in module scope, not on `this`.

### Timelines

- A timeline is a versioned JSON document listed explicitly in `fy.config.js`. `format` fixes width, height, and fps for every timeline; composition and timeline IDs share one namespace.
- Tracks are `video` or `audio`. Video tracks composite bottom-to-top; audio tracks mix. Clips on one track cannot overlap unless a timeline-level `transitions` entry pairs them. `dissolve` is a visual fade on a video track that also crossfades contributed audio; `crossfade` is an equal-power gain ramp on an audio track. A transition's window is the overlap `to.start .. from.end`; the incoming clip composites above the outgoing clip with `opacity × eased progress` during a dissolve. Blend modes are static per visual clip.
- Visual clips may animate `x`, `y`, `scale`, `rotation`, and `opacity` with a clip-local `keyframes` object. Keys hold before the first and after the last key, never extend the clip, use a CSS timing function on the interval after each key, and cannot also be explicit scalars in `transform`. `keyframes.scale` is mutually exclusive with a `transform.width`/`height` box. `opacity` and `scale` are clamped after easing.
- Clip sources are composition ID, nested timeline ID, or a project-relative video/image/audio path. `start`, `sourceIn`, and `duration` are project frames; image clips and static composition clips require a duration.
- Composition clips can fix `props` and trim the source range. A static composition clip must use `sourceIn: 0`, has no intrinsic source duration, and contributes no audio or transcripts; the renderer captures one transparent PNG per composition/props pair and reuses it as an image layer. Visual clips support a static transform, clip keyframes, and a static CSS blend mode; see `skills/frameyard/references/timelines.md` for the fields. Animated composition fps must match the project.
- Visual clips contribute audio automatically unless muted. Timeline audio clips live on audio tracks. Nested timelines are groups and include their audio.
- The timeline renderer is segmented: Chromium captures composition/nested ranges to alpha-preserving FFV1, FFmpeg composites and encodes segments in parallel, segments are concatenated in order, and audio is mixed once. Scratch is bounded and cleaned.

### Determinism

- A composition frame's visual state derives only from the integer `frame`, immutable `props`, and data/assets loaded before frame production. A timeline frame derives from its active clips and the same composition rules. A static composition has one state; it is captured after `mount()` with animations paused at time 0 and does not seek or run `update()`.
- Timeline clip keyframes derive from the clip-local integer frame and declared easing. Production evaluates them against absolute timeline frames, so segment boundaries do not change values. Preview evaluates the CSS timing function exactly; production generates FFmpeg expressions and approximates the curve within the documented budget. Animated opacity uses an alpha mask; animated scale rotates before scaling and uses a zero-safe scale expression. Rotation expands the filter output to a segment-stable bound so corners are not clipped. `check` evaluates every keyframe channel at every timeline frame.
- Timeline composition frames are compared at clip capture; preview (Chromium composite) and production (FFmpeg composite) may differ slightly in scaling, alpha, subpixel keyframe motion, and video color conversion.
- `update()` must not depend on previously visited frames. Declarative bindings apply once per load; controller-created DOM is not re-bound.
- Animation drivers are `update()`, runtime-seeked CSS/WAAPI, and `data-fy-anim-*` scheduling. `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, CSS transitions, and wall-clock reads are not animation inputs. Use `random("stable:key")`.
- Frame-state variables (`--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, `--fy-duration-frames`) are set on `document.documentElement` before controller `update`; animations are sought after `update`.
- Embedded `<video>` and `<audio>` are declared in the composition fragment with `data-fy-*` attributes. The host loads local files during the loading phase, pauses them, and seeks video after each `update()`; `settle()` waits for decode and paint.
- WebGL canvases must be redrawn from the current frame. Production sessions pin SwiftShader so pixels do not depend on the host GPU.
- Remote data, fonts, and images belong in the loading phase. Network requests are blocked during capture; a `fetch()` from `update()` is a bug. Project fonts are vendored with `font add`, served as generated `@font-face` rules, and verified by hash before capture.
- Verify determinism at the capture boundary: compare captured PNG pixels or `still` output, not MP4 hashes. Encoded bytes are not a reproducibility guarantee; see `docs/v0.x-design.md` §3.

### Static validation and diagnostics

- `src/html/validate.ts` parses composition fragments with parse5 (and detects legacy document shells) and reports all static diagnostics in source order. It is Node-only. `src/contracts.ts`, `src/bindings.ts`, `src/composition/`, and `src/runtime/` must stay free of `node:` imports; `pnpm typecheck:browser` enforces it. It also warns with `FONT_REMOTE` for remote font URLs in inline or local linked CSS and for remote stylesheet links.
- `check`, `still`, and `render` run static validation before Chromium. Static errors fail without launching a browser; warnings allow frame evaluation. `dev` validates on composition request.
- A composition that omits dimensions in a project without `format` is not a fragment error: validation reports `formatUnresolved`, and the command fails with `COMPOSITION_FORMAT_UNRESOLVED`.
- A composition with neither `duration-in-frames` nor `fps` is static. Static validation rejects `fps` without `duration-in-frames`, `data-fy-anim-*`, media, and transcripts. A static composition can still inherit `width`/`height` from the project `format`.
- Diagnostics carry `severity`, `code`, `message`, and optional `details` with `path`, `line`, `column`, `element`, `attribute`, `value`, and `suggestion`. Error envelopes carry optional `error.details` and top-level `diagnostics`.
- Unknown `data-fy-*` attributes, repeat misuse, controller declaration errors, executable scripts, event handlers, `javascript:` URLs, unsupported elements, and missing media/transcript references are errors. Missing binding paths and animation mismatches are warnings.
- The result schemas expose `entry`, `controller`, and top-level `diagnostics` for composition `check`, `still`, and `render`. Composition `render` is a union with `kind: "video"` or `kind: "image"`; composition `check` is a union with `kind: "animated"` or `kind: "static"`. A static image result has no fps, duration, frames, codec, container, encoder, audio, or transcripts. Timeline results expose `timeline`, `format`, `tracks`, `clips`, `transitions`, and `diagnostics`; audio/transcript warnings are `AUDIO_WARNING`/`TRANSCRIPT_WARNING` diagnostics, not nested string arrays.
- `src/timeline/schema.ts` is browser-safe and strict: unknown fields, invalid sources, track mismatches, overlaps, transform/blend/audio/keyframe values, transition entries, and cross-channel transform conflicts are errors. `src/timeline/resolve.ts` adds references, fps, media probes, source bounds, keyframe duration bounds, transition geometry, nested cycles, and props overrides.

### Host, preview, and rendering

- The preview server serves configured composition fragments at their real project path, wraps them in the fixed document shell, hoists top-level import maps and styles, and injects the framework import map, sizing style, and host module.
- Inline controllers are served through the virtual URL `<composition>?__fy-controller`; the host imports either that URL or the external `src`. A composition has exactly one controller.
- `window.__fy` exposes `ready`, `metadata`, `defaultProps`, `props`, `controller`, `audioClips`, `embeddedAudioClips`, `transcriptClips`, `diagnostics`, `frame`, `load`, `seek`, `settle`, and `dispose`.
- Manual mode (`?__fy-manual`) waits for `load` and hides the root until the first successful load. Auto mode loads defaults and seeks frame 0. `load` validates props before disposing, restores the pristine DOM snapshot, re-applies bindings, remounts the controller, and prepares media. For a static composition it stops after `mount()` and asset loading: no `update()`, media preparation, animation seek, or frame state. `seek()` is a no-op and `settle()` resolves.
- Preview loads the composition in a same-origin iframe and owns preview audio/playback. Props apply reuses the host `load`; composition changes reload the iframe with a unique load token. `check`, `still`, and `render` navigate directly to the composition URL and drive the same host API.
- The renderer uses static metadata for the viewport before navigation, blocks network after loading, and captures through CDP. Concurrency uses independent sessions but ordered writing; output order and pixels must match a sequential render.
- `check` exercises every animated frame and inspects a static composition once; `still` follows the production capture path and exposes only frame 0 for a static composition. A render writes a temporary output and publishes atomically; existing outputs are replaced only with `--overwrite`. A static composition render captures one PNG and does not use FFmpeg.
- Timeline preview serves `/__frameyard/timeline/<id>` and `.json`; embedded pages expose `window.__fyTimeline`. The preview host lazily loads active clips and evicts inactive layers; it is not the production compositor.
- Timeline production captures compositions with `transparentBackground: true`, preserves alpha in FFV1, and composites nested timelines as groups. A static composition is captured once as a transparent PNG per props variant and enters the composite as an image layer; the cache is shared across segments and workers. `--workers` bounds segment concurrency; `--scratch` bounds intermediates. Animated composition rendering keeps `--concurrency`; static composition rendering is a single capture and rejects it. `--container`, `--codec`, and `--encoder` select the delivery pair and encoder for video paths; FFV1 intermediates remain lossless and software-encoded, HEVC keeps the `hvc1` tag in MP4/MOV, VP9 pairs with Opus, NVENC caps timeline workers at eight sessions, and encoded bytes are not a reproducibility guarantee.
- Timeline `still` and `check` recurse into nested timelines; media-only frames are validated but not decoded frame-by-frame.

### Generated assets

- Speech synthesis and transcription are explicit operations outside rendering. Never invoke them from `mount()`, `update()`, or frame production.
- Use the `tts` and `transcribe` wrappers; never call `qwen-tts`, `sherpa-onnx-offline-tts`, or `whisper-cli` directly from framework code or the agent skill.
- Outputs are written atomically. Failed or cancelled operations leave no apparently valid artifact and no manifest entry.
- Existing generated assets are replaced only with `--force`.
- The provenance manifest records artifact hashes, generator details, model identities, parameters, and source identity for transcription.
- Executable resolution order is explicit option, environment variable, then `PATH`.

### CLI and outputs

- Non-interactive commands support `--json`. With `--json`, stdout contains only the structured result/error envelope; progress and human diagnostics go to stderr.
- Keep error envelopes stable: `{ ok: false, command, error: { code, message, details? }, diagnostics? }`. Usage failures emitted before a command is known still produce an envelope with `command: null`.
- Failures exit nonzero. A render never publishes a partial file.
- Output directories are created during preflight, before Chromium starts; the CLI removes a directory it created when the invocation publishes nothing.
- `elapsedMs` measures from static validation and preflight through publication; CLI argument parsing is excluded.
- Preserve exact frame counts in FFmpeg (`-frames:v`) and bounded audio (`-t`).
- `check` must inspect every animated frame and report audio/transcript durations and diagnostics without capturing or encoding. A static composition has one state and reports `kind: "static"` with `framesChecked: 1`.
- `doctor` exits nonzero when required checks fail but does not throw away the structured findings.

## Change map

- **Contracts, props, audio, transcripts, diagnostics, host types** → `src/contracts.ts`, `src/transcript.ts`, `src/index.ts`; extend `test/contracts.test.ts`, `test/transcript.test.ts`.
- **Binding semantics** → `src/bindings.ts`, `src/runtime/bindings.ts`; extend `test/bindings.test.ts`, `test/host-runtime.test.ts`.
- **Composition grammar reading** → `src/composition/`, `src/html/document-adapter.ts`; extend `test/composition-document.test.ts`, `test/static-validation.test.ts`.
- **HTML parsing and static validation** → `src/html/parse.ts`, `src/html/validate.ts`; extend `test/static-validation.test.ts`, `test/server-html.test.ts`.
- **Static composition model** → `src/contracts.ts`, `src/composition/descriptor.ts`, `src/composition/format.ts`, `src/html/validate.ts`, `src/runtime/host.ts`; keep `ADR 0017` and `docs/migration-0.8.md` in step. Extend `test/static-validation.test.ts` and `test/host-runtime.test.ts` with the metadata matrix, media/animation rejection, static load, and warning cases.
- **Host runtime** → `src/runtime/host.ts`, `src/runtime/media.ts`, `src/runtime/diagnostics.ts`; extend `test/host-runtime.test.ts`.
- **Timeline scene projection** → `src/timeline/scene.ts`; extend `test/timeline-scene.test.ts`. The projection owns active-layer selection, transition pairing and roles, composite order, frame-to-source mapping, capture modes (`frames | still | video | image | nested`), natural source sizes, and presentation defaults. `plan.ts`, `renderer/timeline.ts`, and the preview host consume it; capture sessions, audio mapping, and both compositors stay outside. Nested timelines project one level and recurse at capture. See ADR 0021.
- **Timeline schema and resolution** → `src/timeline/schema.ts`, `src/timeline/resolve.ts`, `src/timeline/scene.ts`, `src/timeline/plan.ts`, `src/timeline/easing.ts`, `src/timeline/keyframes.ts`, `src/timeline/transitions.ts`; extend `test/timeline-schema.test.ts`, `test/timeline-resolve.test.ts`, `test/timeline-scene.test.ts`, `test/timeline-plan.test.ts`, `test/timeline-keyframes.test.ts`. Static composition clips are image-like: explicit duration, `sourceIn: 0`, no intrinsic duration, no audio. A transition is declared as `{ from, to, kind: "dissolve" | "crossfade", easing? }`, its window is the overlap `to.start .. from.end`, geometry is `from.start < to.start < from.end < to.end`, and undeclared overlap stays an error. `dissolve` is video-track only; `crossfade` is audio-track only. Document contract fields in `skills/frameyard/references/timelines.md`; other docs link to it.
- **Timeline rendering** → `src/renderer/timeline.ts`, `src/renderer/ffmpeg.ts`, `src/renderer/keyframe-expressions.ts`, `src/renderer/browser.ts`; extend `test/timeline-render.test.ts` with per-frame mapping coverage for every affected layer kind (video, composition, nested timeline, static composition image), keyframed channels, animated opacity with blend modes, transition alpha and equal-power audio, segment independence, and preview/still parity; verify artifacts with FFprobe. Composition captures stream PNG buffers into FFV1 through `startFfv1Encoder`; a single full-frame composition with no presentation work uses `startDirectSegmentEncoder` and skips the intermediate/composite. Independent layer captures run concurrently under the `createSemaphore` limit; keep result ordering and the global limit intact. `CompositionSessionPool` reuses loaded sessions keyed by entry, props, and transparency; discard a session on error and close the pool before the server. A full-frame composition base plus a static composition overlay (including a static PIP box) encodes through `startDualPipeSegmentEncoder` (fd 3); keep the Windows fallback and the `FRAMEYARD_DISABLE_DUAL_PIPE` escape hatch. A single full-frame video with an identity transform uses `encodeVideoSegmentDirect`; keep the re-encode and the `FRAMEYARD_DISABLE_VIDEO_DIRECT` escape hatch rather than stream-copying. `TimelineCompositeLayer.input` is the FFmpeg artifact mode (`sequence | image | video`), built by `sceneLayerToCompositeLayer`; do not reuse it as a source kind.
- **Preview** → `src/preview/main.ts`, `src/preview/timeline-host.ts`, `src/preview/timeline-main.ts`, `src/server/preview-html.ts`, `src/server/timeline-preview-html.ts`; extend the HTML iframe case in `test/preview-runtime.test.ts` and the timeline keyframe/marker/transition cases in `test/timeline-preview-runtime.test.ts`.
- **Timeline preview** → `src/preview/timeline-main.ts`, `src/preview/timeline-host.ts`, `src/preview/timeline-data.ts`, `src/server/timeline-preview-*.ts`; extend `test/timeline-preview.test.ts`, `test/timeline-preview-runtime.test.ts`; keep `docs/preview-testing.md` in step with the embedded host API. The payload is a serialized resolved timeline with URLs replacing absolute paths; the host calls `projectScene` on every seek instead of maintaining a parallel preview clip model.
- **Server routes, document shell generation, inline controller, `project.json`, timeline preview/data** → `src/server/server.ts`, `src/server/composition-html.ts`; extend `test/project-server.test.ts`, `test/server-html.test.ts`, `test/timeline-preview.test.ts`.
- **Chromium capture, audio/transcript inspection, FFmpeg** → `src/renderer/`; extend `test/cli-stills.test.ts`, `test/cli-render.test.ts`, `test/video-determinism.test.ts`, and verify artifacts with FFprobe.
- **CLI commands, flags, and their result contracts** → `src/cli.ts`; update `README.md` (commands table, options, non-goals), `docs/v0.x-design.md` §5-§6 and non-goals, `GLOSSARY.md`, `skills/frameyard/SKILL.md` and its references (`json-results`, `diagnostics`, `failure-recovery`, `common-mistakes`, `deterministic-authoring`, `timelines`), `src/scaffold.ts`, and `CHANGELOG.md`; extend `test/cli-render.test.ts`, `test/cli-stills.test.ts`, and `test/docs.test.ts`.
- **Resource policy, lint, and dry-run handoff** → `src/policy.ts`, `src/lint.ts`, `src/cli.ts`, `scaffolds/local-models/`; update ADR 0022, README, design baseline §6-§7, GLOSSARY, skill references, scaffold, and CHANGELOG; extend `test/policy.test.ts`, `test/cli-render.test.ts`, `test/docs.test.ts`, `test/skill.test.ts`, and `test/scaffold.test.ts`.
- **Project context, image inspection, and templates** → `src/context.ts`, `src/inspect.ts`, `src/templates.ts`, `src/cli.ts`; add the `context`, `inspect`, `compare`, and `add` commands; update README, design baseline §6, GLOSSARY, skill quick reference and references, scaffold, and CHANGELOG; extend `test/context.test.ts`, `test/inspect.test.ts`, `test/templates.test.ts`, `test/cli-render.test.ts`, `test/docs.test.ts`, and `test/skill.test.ts`.
- **Fonts** → `src/fonts/`, `src/project.ts`, `src/server/server.ts`, `src/server/composition-html.ts`, `src/html/validate.ts`, `src/runtime/host.ts`, `src/context.ts`, `src/doctor.ts`, `src/policy.ts`, `src/cli.ts`; update ADR 0023, README, design baseline §4/§6, GLOSSARY, skill `fonts.md` and references, scaffold, and CHANGELOG; extend `test/fonts.test.ts`, `test/fonts-e2e.test.ts`, `test/fontsource-e2e.test.ts`, `test/server-html.test.ts`, `test/context.test.ts`, `test/policy.test.ts`, `test/host-runtime.test.ts`, `test/docs.test.ts`, `test/skill.test.ts`, and `test/scaffold.test.ts`. `src/fonts/fontsource.ts` owns the Fontsource API/CDN mapping; `src/fonts/install.ts` merges a family record and publishes payloads atomically; local, Fontsource, and URL adapters build the same `FontFamily` + payload shape.
- **Static validation integration and result schemas** → `src/renderer/index.ts`, `src/renderer/timeline.ts`, `src/cli.ts`; extend `test/cli-stills.test.ts`, `test/cli-render.test.ts`, `test/agent-workflow.test.ts`, `test/timeline-render.test.ts`.
- **TTS, transcription, provenance, executable resolution** → `src/assets/`; extend `test/assets-e2e.test.ts` with fake executables. `tts --engine supertonic` resolves the seven Supertonic files from `--model-dir`, records them in the manifest, and normalizes the engine output to 24 kHz mono.
- **Doctor checks** → `src/doctor.ts`, `src/cli.ts`; extend `test/assets-e2e.test.ts`.
- **Init scaffold content** → `scaffolds/init/` (project format, composition, timeline, config, props, README, agent guide, and package manifest) plus `src/scaffold.ts` for placeholder rendering and `next`; keep the agent guide aligned with `skills/frameyard/`; extend `test/scaffold.test.ts`, `test/docs.test.ts`, and the `init` case. When the scaffold file set changes, update `README.md`, `docs/v0.x-design.md` §6, and the scaffold README/agent guide.
- **Agent skill contract** → `skills/frameyard/`, `package.json`; extend `test/skill.test.ts`.
- **Reference behavior** → `examples/demo/`, `examples/intro/`, `examples/webgl/`, `examples/video/`, `examples/blend/`, `examples/keyframes/`, `examples/transitions/`, `examples/nested/`, and `examples/static/`; keep their README commands working. The demo includes a timeline wrapping its composition; the intro example renders a 20-second film from four scene compositions, a persistent HUD overlay, three 30-frame dissolves, vendored Figtree/Space Mono/Instrument Serif fonts, a deterministic Canvas 2D tunnel, and a procedurally generated score; the video example includes WebM and MP4 timelines with video clips under a transparent overlay composition; the blend example sequences static blend modes on composition and video clips; the keyframes example animates one timeline clip through every presentation channel; the transitions example dissolves three timed chord cards across one video track and crossfades their audio, and its `audio-crossfade` timeline places the chords directly on an audio track; the nested example places two inner timelines in an outer timeline as full-frame and transformed group clips with nested audio; the static example renders a timeless composition to PNG and reuses it as a timeline image. Extend `test/examples.test.ts` when the example set or entry layout changes.
- **Performance benchmarks** → `scripts/bench-render.mjs`, `bench/fixtures/`, `bench/keyframe-timeline.mjs`, `bench/README.md`; keep `pnpm bench` representative of the composition capture path and the keyframe timeline script representative of the animated composite path. Timeline benchmark scripts are temporary measurement tools; the production projection is in ADR 0012.
- **Local-model evals** → `evals/runner.mjs`, `evals/tasks.mjs`, `evals/README.md`; keep the eight tasks small, keep `lint`/`check`/`still`/`inspect` as the gates, keep the harness outside `pnpm check`, and keep resource sampling opt-in. The system prompt reads `skills/frameyard/references/quick-reference.md`; update both together.
- **Lint and formatting** → `.oxlintrc.json`, `.oxfmtrc.json`, `package.json`, `.githooks/pre-commit`, `.githooks/commit-msg`, and CI/release workflows; run `pnpm check:static`.
- **Release checks and versioning** → `scripts/set-version.mjs`, `scripts/verify-release.mjs`, `scripts/check-changelog.mjs`, `scripts/verify-package.mjs`, `scripts/check-stamp.mjs`, `scripts/retag-release.mjs`, `RELEASING.md`, `.github/workflows/release.yml`; run `pnpm verify-release` after tagging.

## Testing

Test at public seams, not private helpers:

- `test/contracts.test.ts`: composition metadata, props, JSON serialization, audio clips, transcript requirements, diagnostics.
- `test/bindings.test.ts`: binding path syntax, resolution, repeat scope, value coercion, suggestions.
- `test/static-validation.test.ts`: fragment metadata, static metadata matrix, static media/animation rejection, defaults, bindings, scripts, controllers, import maps, document-shell rejection, media, transcripts, source locations, diagnostics.
- `test/server-html.test.ts`: `.html` entries, fragment wrapping and head ordering, virtual inline controller, static error pages, `project.json` diagnostics.
- `test/host-runtime.test.ts`: host bindings, repeat/if/class, animation scheduling, frame variables, inline/external controllers, props validation, load atomicity, dispose, diagnostics, auto mode, media settle, and static load (mount-only, no frame state, paused CSS animations, `update()`/media warnings and errors).
- `test/random.test.ts`: frame/time conversion and stateless keyed deterministic randomness.
- `test/timings.test.ts`: opt-in stage timing gating and JSONL event shape.
- `test/concurrency.test.ts`: render semaphore limits, FIFO waiters, and slot transfer.
- `test/session-pool.test.ts`: capture-session reuse, discard, idle budget, and close.
- `test/policy.test.ts`: workspace policy discovery, env precedence, strict schema and tighten-only limits, tier gates, still limits, profile caps, and priority selection.
- `test/context.test.ts`: project digest composition metadata, prop types, timeline clip summaries, fonts, policy, next commands, and the CLI context result.
- `test/fonts.test.ts`: font manifest schema, CSS generation, option parsing, local installation, merge/force, license warnings, hash/license/orphan verification, and removal.
- `test/fonts-e2e.test.ts`: local font CLI installation, list/verify/context results, generated font CSS route, composition injection, deterministic stills, hash preflight, invalid manifest, and policy gates.
- `test/fontsource-e2e.test.ts`: fake Fontsource API/CDN, catalog search filters, variable/static installation, pinned license and version, loopback URL import, SHA-256 checks, and unlicensed URL policy.
- `test/inspect.test.ts`: RGBA analysis, blank/alpha/color/bbox facts, pixel and region comparison, and the inspect/compare CLI results.
- `test/templates.test.ts`: unique template names, valid composition and timeline templates, and registration snippets.
- `test/evals.test.ts`: local-model eval task names, targets, seed configs, composition validity, and timeline schema validity.
- `test/project-server.test.ts`: config loading, static routes, import map, ranges, traversal rejection.
- `test/timeline-config.test.ts`: `fy.config.js` timeline entries, format requirements, timeline-only projects, and duplicate or missing entries.
- `test/preview-runtime.test.ts`: HTML iframe preview, props, seeking, transport keys, CSS animation, Canvas, WebGL, embedded video, determinism, diagnostics, and static composition preview without a transport.
- `test/timeline-preview-runtime.test.ts`: timeline preview UI and embedding, scrubbing, frame/one-second stepping, seek coalescing, keyboard forwarding, layer sizing, keyframe presentation and markers, transition alpha and the read-only band, blend layering and preview/still parity, video frame presentation, and static layers that stay loaded without seeking.
- `test/timeline-keyframes.test.ts`: CSS easing parsing and boundary semantics, keyframe evaluation, hold/extrapolation, clamping, marker frames, and the production easing approximation budget.
- `test/timeline-scene.test.ts`: active-layer selection, transition roles, composite order, frame-to-source mapping, capture modes, natural source sizes, presentation defaults, and the shared visual/audio transition pairing.
- `test/timeline-plan.test.ts`: segment splitting at visual clip boundaries, maximum segment length, gaps with no layers, and nested-timeline ranges.
- `test/timeline-render.test.ts`: segmented rendering, transform boxes, alpha and blend-mode compositing, media/audio, nested timelines, static composition capture reuse, keyframed position/scale/rotation/opacity, clip dissolves and equal-power audio crossfades, expanded rotation bounds including a full 360-degree sweep, animated opacity with blend modes, segment independence, and per-frame barcode mapping for video, composition, and nested-timeline layers.
- `test/encoders.test.ts`: codec and container matrix, encoder name mapping, encoder arguments, HEVC tags, and NVENC session limits.
- `test/cli-stills.test.ts`: real CLI with Chromium and FFmpeg for `check`/`still`, JSON envelopes, missing assets, deterministic stills across concurrent sessions, embedded video/WebGL capture, frame ranges and caps, preflight/failure atomicity, HTML/static check/still/render, static diagnostics, and format inheritance.
- `test/cli-render.test.ts`: real CLI renders and workflow: container/codec/audio output, media audio, overwrite behavior, `dev`, `init`, resource policy, lint, templates, doctor, and the local-model scaffold.
- `test/video-determinism.test.ts`: a full-scene opacity animation over embedded video captures the requested frame, and consecutive composition frames map to consecutive source frames.
- `test/examples.test.ts`: example README commands use the repository CLI, and each bundled example captures a still, including the static composition and its timeline.
- `test/assets-e2e.test.ts`: `tts`/`transcribe`/`doctor` with fake upstream executables, normalization, word timings, exports, manifests, cancellation, transcript validation.
- `test/agent-workflow.test.ts`: source preservation, check/still/render reporting, failure reporting through the CLI.
- `test/real-integrations.test.ts`: opt-in real-model checks enabled by `FRAMEYARD_REAL_INTEGRATIONS=1` and explicit model paths.
- `test/skill.test.ts`: skill layout discovery, frontmatter name, single skill, contents, API version, package inclusion, thin wrapper.
- `test/docs.test.ts`: user-facing command examples use `npx frameyard`; scaffold markdown commands and package scripts are real; the still frame cap matches `src/cli.ts`; every test file is listed in this section.
- `test/release.test.ts`: CI, release workflow, and hooks share `pnpm check`; changelog coverage, empty `[Unreleased]`, package contents, runner pinning, release metadata verification, and the pre-push stamp.
- `test/scaffold.test.ts`: scaffold file generation, package manifest, project-name normalization.

Prefer one failing public-behavior test, then the minimal implementation. Every behavior named in a commit message needs a test that fails without the change. Use real Chromium and FFmpeg for production-path behavior; mock only external model executables. Run the verification command scoped by `Before finishing`. Browser/CLI tests are intentionally sequential (`fileParallelism: false`).

## Before finishing

- Verify proportionally to the change:
  - Preview-only UI (`src/preview/`, `src/server/preview-html.ts`, `src/server/timeline-preview-*.ts`, and their tests): run `pnpm check:preview` (static checks plus the preview test files). Do not run the full `pnpm check` unless the change also reaches shared code.
  - Anything else, including contracts, runtime, renderer, CLI, timelines, determinism, release configuration, or docs consumed by those: run `pnpm check`.
  - Before pushing or publishing, `pnpm check` must pass regardless; the pre-push hook runs the full suite when the tree did not already pass `pnpm check`.
- If capture, encoding, or audio changed, render a small fixture and verify the artifact with FFprobe; render the example whose composition changed.
- If public behavior changed, update `README.md` and, for contract changes, the design baseline or an ADR.
- If the output format or container changed, grep the docs for the old format noun (`final MP4`, `partial MP4`) before finishing.
- Confirm failures still exit nonzero and leave no published partial output.

## Gotchas

- **Rebuild before browser work**: the server serves `/__frameyard/framework/*` from `dist/`, and a running `dev` keeps the `dist/` modules it loaded. Restart `dev` after a rebuild.
- **Iframe preview**: the parent owns preview audio/playback. Props apply reuses the host; composition changes reload the iframe with a unique `__fy-load` token. Cross-realm props are cloned into the iframe realm before `load`.
- **Transport keys cross the stage iframe**: the preview stage is an iframe, so parent `keydown` listeners do not see keys while it has focus. The composition preview attaches the transport handler to `stageFrame.contentDocument`; the timeline host forwards layer `keydown` events via `setKeyHandler`. Keep both paths wired when adding shortcuts.
- **Host load**: validates props before disposing, restores the pristine DOM snapshot, re-applies bindings, remounts the controller, and prepares media. `seek`/`settle` before a successful load reject `COMPOSITION_NOT_READY`; `dispose` during a load rejects `COMPOSITION_DISPOSED`.
- **Errors cross the Playwright boundary** as `[CODE] message`; `src/renderer/browser.ts` parses that tag back into a `FrameyardError`. Preserve the tag and stable codes.
- **Session close calls the host's `dispose()`** before closing the browser. Do not bypass that cleanup.
- **Network is blocked after loading** with `page.route`. Asset URLs must resolve during loading; later requests fail the render.
- **FFmpeg capability checks** run before rendering (`libx264`, `aac`). Keep the actionable error path.
- **Diagnostics are best-effort**: the host wraps common forbidden clocks/randomness in `mount`/`update`, but does not police every third-party library perfectly.
- **`project.json` is derived from explicit config**, not scanning. New `.html` compositions must be listed in `fy.config.js`.
- **Path containment** is lexical throughout the server, project loader, and media resolver. The preview server binds loopback by default; treat project roots as trusted.
- **Media/transcript paths** resolve from the project root. Controller `src` and ordinary HTML asset URLs resolve from the composition URL.
- **Full-scene fades over video**: Chromium can reuse the load frame in interactive preview after a large seek. Fade overlay layers instead. Capture sessions keep the composition hidden until the first seek, and `test/video-determinism.test.ts` covers that path.
- **Pixel diffs**: use `pnpm compare-stills` for decoded-pixel checks; ImageMagick `compare` can report color-profile noise on identical PNGs.
- **Legacy full documents** fail with `COMPOSITION_DOCUMENT_SHELL`; keep the migration guide and its suggestion in sync with the shell rules. The wrapper hoists top-level import maps after the framework map and top-level styles after the host style, so authors can still override the host sizing style.
- **Inline controllers** are served through `<composition>?__fy-controller`; a literal `</script>` in inline source must be escaped. Exactly one controller is allowed.
