# Changelog

All notable changes to Frameyard are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Frameyard uses `0.x` versions until the composition, configuration, CLI,
JSON-result, transcript, and skill contracts stabilize. Before `1.0.0`, a
contract change may ship in a minor release and is called out explicitly below.

## [Unreleased]

### Changed

- The CLI now uses `citty` for command and argument parsing and generated
  usage, `@clack/prompts` for the interactive `init` project-name prompt and
  the Fontsource search spinner, and `picocolors` for human-readable output.
  Flags may appear before the command, `help <command>` and
  `<command> --help` work without the command's positionals, and colored
  output is limited to terminals (or `FORCE_COLOR`), honors `NO_COLOR`, and
  never enters `--json` stdout.
- `check` and `render` now paint a single live progress line on a terminal
  with a bar, percentage, frame count, elapsed time, throughput, ETA, and
  completed timeline segments. Compositions and timelines report every frame,
  including inside timeline segments, and parallel timeline renders sum
  completed segment work so the bar advances with real work instead of jumping
  to the highest playhead frame. Phase changes use a spinner for `Capturing`,
  `Encoding`, `Muxing`, and `Finalizing`; piped and CI runs log a line every ten
  percent and one line per phase. `--no-progress` suppresses progress,
  cancellation clears the live line, and progress stays on stderr so `--json`
  stdout is unchanged.

### Added

- `frameyard add recipe <recipe-id> --id <project-id>` installs a complete
  recipe bundle with a composition, timeline, props, and README, then prints the
  exact `fy.config.js` registration entries. `frameyard add --list` now includes
  the recipe manifest. The initial recipes are `lower-third`, `title-card`,
  `captions`, `audio-visualizer`, `countdown`, `stat-card`, `product-showcase`,
  `logo-sting`, `split-screen`, and `slideshow`.
- Compositions can declare a `data-fy="props-schema"` block with a pragmatic
  subset of JSON Schema: `type`, `properties`, `required`, `default`, `enum`,
  `description`, and `items`. `check`, `still`, and `render` validate resolved
  props before Chromium with `PROPS_SCHEMA_INVALID` or
  `PROPS_SCHEMA_INVALID_SCHEMA`; schema defaults merge under document defaults
  and user props. `context --json` includes the parsed `propsSchema`, and the
  runtime host applies the same defaults and validation.
- Diagnostics and error envelopes can include an optional `fix` object with
  `kind`, `message`, `from`, `to`, `patch`, `command`, and `docs`. Baseline fixes
  cover binding, animation, controller, static-media, asset, timeline-overlap,
  transition-geometry, font-load, and output-conflict failures. `frameyard
  explain <code>` prints the cause, a failing example, the corrected example,
  and a docs link; `explain --list --json` lists every stable code. Fixes are
  advisory and are never applied automatically.
- `data-fy-anim-preset` adds deterministic `fade`, `fade-up`, `fade-down`,
  `slide-left`, `slide-right`, `scale-in`, and `blur-in` entrance animations.
  Presets compose with `data-fy-anim-start`, `data-fy-anim-duration`, and
  `data-fy-anim-easing`; unknown presets fail with `ANIMATION_INVALID`, and
  static compositions reject preset scheduling.
- `render` accepts `--frames <spec>` for a contiguous frame range,
  `--scale <factor>` from 0.25 to 1 for encode-time scaling, and
  `--sequence <dir>` for PNG frame output. Frame ranges trim and shift audio and
  set the output duration to the range length; sequence output requires
  `--frames` and does not encode a video. Results report `frameRange` and
  `scale`, plus `sequence` for PNG output.
- `frameyard asset add <url> --out <path> [--sha256 <hash>] [--force]`
  downloads HTTPS media into the project, verifies the hash, publishes
  atomically, and records `src`, `sha256`, `bytes`, `source`, and `fetchedAt` in
  the `assets` array of `fy.assets.json`. Loopback HTTP is allowed for tests;
  `doctor` verifies downloaded asset files and hashes.
- Preview composition elements and timeline clips open a read-only inspector
  with bindings and resolved values, frame state, clip timing and presentation
  fields, matching diagnostics, jump-to-start/end, a copyable `still` command,
  and a source link. Escape closes the panel.

## [0.10.0] - 2026-11-07

### Added

- `FRAMEYARD_TIMINGS=1` emits one JSON line per render stage to stderr without
  changing the `--json` result on stdout. `bench/summarize-timings.mjs`
  aggregates session, capture, PNG-write, FFV1, composite, concat, audio, and
  publish timings for production-path profiling,
  `bench/timeline-60min-gate.mjs` generates the 60-minute composition-only
  production gate, and `bench/timeline-60min-representative.mjs` generates the
  representative 60-minute 50/50 gate. The representative gate rendered 108,000
  frames in 16.82 minutes with eight workers, clean scratch, and video
  re-encoded rather than stream-copied. `FRAMEYARD_FFV1_THREADS` bounds the streaming FFV1 encoder.
- Composition clips now stream captured PNGs directly into FFV1 instead of
  writing a PNG sequence to scratch first. A segment with one full-frame,
  untransformed composition skips the FFV1 intermediate and the FFmpeg
  composite, encoding the capture directly to the delivery segment over the
  timeline background. See
  `docs/adr/0024-stream-composition-captures-and-skip-trivial-composites.md`.
- Independent layer captures run concurrently under a FIFO semaphore, bounded
  by `FRAMEYARD_CAPTURE_CONCURRENCY` or `min(workers * 2, 12)` by default. The
  two-layer 60-second gate fell from 59.60 s to 43.78 s. See
  `docs/adr/0025-capture-timeline-layers-in-parallel-with-a-global-limit.md`.
- The timeline renderer reuses loaded composition sessions across segments,
  keyed by entry, props, and transparency, with a bounded idle pool. The
  10-minute one-layer gate fell from 211.8 s to 192.6 s, and the 60-minute gate
  fell from 19.83 to 18.78 minutes with eight sessions instead of 360. See
  `docs/adr/0026-reuse-loaded-composition-sessions-across-segments.md`.
- A full-frame composition base and a static composition overlay (including a
  static PIP box) encode through dual image pipes into one delivery segment,
  skipping FFV1 and the separate composite. The full-frame two-layer 60-second
  workload fell from 53.27 s to 34.62 s with byte-identical output, the PIP
  60-second workload from 43.78 s to 33.90 s with pixel-identical frames, and
  the full two-layer 60-minute gates completed in 29.69 minutes (full-frame) and
  25.75 minutes (PIP) with eight workers. Windows keeps the segmented fallback. See
  `docs/adr/0027-encode-two-full-frame-layers-through-dual-pipes.md`.
- A single full-frame video with an identity transform re-encodes its source
  range directly into the delivery segment, skipping the composite filter
  graph while keeping the normal encoder settings and the RGBA color round trip
  for pixel parity. A 60-second video-only gate fell from 10.65 s to 7.61 s
  with identical decoded frames, and the representative 60-minute 50/50 gate
  fell from 16.82 to 15.57 minutes with a byte-identical file. See
  `docs/adr/0028-encode-full-frame-video-segments-directly.md`.

### Changed

- The composition and timeline preview pages share one visual language:
  ink-black surfaces, paper-white type, a single lime signal, monospace
  instrument labels, and a tick-marked progress rail. The timeline strip adds a
  frame ruler that tracks the playhead. The chrome bundles its own Figtree and
  Space Mono faces and no longer links the project font sheet; project fonts
  still apply inside compositions. See `src/server/preview-style.ts` and
  `src/preview/fonts/`.

### Fixed

- Timeline preview plays composition audio once instead of restarting it when
  the mapped clip window is longer than the source file. An embedded `<audio>`
  without `data-fy-duration` now stops at the end of the source instead of
  looping for the rest of the composition clip.
- Timeline inspection no longer reports an overrun when a composition's
  natural-duration audio ends before its mapped clip window. The clip is still
  mixed and padded with silence, while explicit trim ranges beyond the source
  keep warning.

[0.10.0]: https://github.com/vladiantio/frameyard/compare/v0.9.0...v0.10.0

## [0.9.0] - 2026-11-06

### Added

- `fy.fonts.json` records vendored font families, files, licenses, and
  SHA-256 values. `frameyard font search` filters the Fontsource catalog, and
  `font add <id>` pins a Fontsource `npmVersion`, vendors its WOFF2 files and
  license, and supports variable `wght` or explicit static weights. `font add
  --file` copies a local WOFF2/WOFF/TTF/OTF font, `font add --url` vendors an
  HTTPS source with an optional SHA-256, and `font list`/`verify`/`remove`
  manage the manifest. The server injects the generated `@font-face` sheet into
  every composition, the host fails with `FONT_LOAD_FAILED` when a used face
  does not load, and static validation warns with `FONT_REMOTE` for remote font
  URLs. See
  `docs/adr/0023-pin-fonts-as-project-assets.md`.
- `fy.policy.json` is a workspace resource policy discovered from the
  working directory upward. It gates `tts`, `transcribe`, and `render`, caps
  `still`, denies `--force`/`--overwrite`, and supports the `shared-cpu`
  profile. `FRAMEYARD_POLICY` overrides the file. See
  `docs/adr/0022-gate-heavy-operations-with-a-workspace-resource-policy.md`.
- `frameyard lint <id>` runs static validation, timeline resolution, scene and
  keyframe projection for every frame, a controller determinism scan, and media
  metadata probing without Chromium. It is the edit-loop gate; `check` remains
  the full gate.
- `frameyard context --json` prints a compact project digest with resolved
  composition metadata, prop keys and types, timeline clip summaries, unique
  assets, diagnostics, the active policy, and next commands.
- `frameyard inspect <image> --json` reports dimensions, alpha coverage, blank
  detection, background and dominant colors, a content bounding box, a coarse
  luminance grid, and edge density. `frameyard compare <a> <b> --json` reports
  pixel and 3×3 region differences and exits 1 when the images differ.
- `frameyard add --list` and `frameyard add <composition|timeline> <id>
  --template <name>` write `static-poster`, `title-card`, `lower-third`, or
  `slideshow` entries and print the exact `fy.config.js` registration
  snippet. `add local-models` and `init --local-models` install the optional
  policy, OpenCode permissions, and Pi settings. `add` never edits the config
  and never overwrites an existing entry. The skill adds a compact quick
  reference for limited-context hosts.
- `init` templates now live under `scaffolds/init/`; `src/scaffold.ts` reads
  them and renders the project-name and version placeholders.
- `pnpm eval:local` runs an opt-in local-model authoring eval against a
  llama.cpp router. It covers eight tasks, feeds `quick-reference.md` into the
  system prompt, repairs lint failures, and reports first-pass status, turns,
  tokens, wall time, sampled server CPU/RSS/GPU, and optional budgets. It never
  renders and stays outside `pnpm check`.
- `tts`, `transcribe`, and `render` accept `--dry-run`, which validates inputs
  and returns `plan`, `commandLine`, `prerequisites`, and `blockers` without
  writing outputs, loading a model, launching Chromium, or encoding.
  `--profile shared-cpu` caps timeline workers at 2 and composition concurrency
  at 1; `--low-priority` lowers process priority without the caps.
- `doctor` reports the active resource policy and basic CPU, load, and memory
  resources. Local-model host setup is opt-in through
  `scaffolds/local-models/`, which contains the `authoring` policy, OpenCode
  permissions, and Pi settings; the repository does not enable it by default.
- `tts --engine supertonic` synthesizes 31-language speech through
  `sherpa-onnx-offline-tts` and the Supertonic 3 model archive. It normalizes
  the engine output to the frozen 24 kHz mono WAV contract, records the seven
  model files in the provenance manifest, and adds `doctor --sherpa-onnx-tts`
  and `doctor --model-dir` inspection. The default engine remains `qwen`.
- Timeline clips on one video track may dissolve across their overlap through a
  timeline-level `transitions` array. The window is `to.start .. from.end`; the
  incoming clip composites above the outgoing clip with `opacity × eased
  progress`, contributed audio crossfades with equal power, and preview draws a
  read-only band. Undeclared overlap stays an error. See
  `docs/adr/0019-make-same-track-overlap-the-transition-window.md` and
  `examples/transitions/`.
- Audio clips on an audio track may crossfade through the same `transitions`
  array with `kind: "crossfade"`. The kind/track matrix is explicit: `dissolve`
  is video-only, `crossfade` is audio-only. See
  `docs/adr/0020-crossfade-audio-clips-on-audio-tracks.md` and the
  `audio-crossfade` timeline in `examples/transitions/`.
- Timeline clips animate `x`, `y`, `scale`, `rotation`, and `opacity` with
  clip-local `keyframes`, CSS easing, preview markers, and FFmpeg expressions.
  Animated opacity composes through blend modes. See
  `docs/adr/0018-animate-timeline-clips-with-keyframes.md` and
  `examples/keyframes/`.

### Changed

- `frameyard init` without a directory prompts for a project name (default
  `my-video`) on an interactive terminal and creates a directory with that
  name. Non-interactive and `--json` runs use `my-video` without prompting.
  Pass a directory to scaffold into an explicit path or the current directory.
- The project configuration file is `fy.config.js` (previously
  `video.config.js`), the assets manifest is `fy.assets.json` (previously
  `frameyard.assets.json`), and the workspace resource policy is
  `fy.policy.json` (previously `frameyard.policy.json`). Rename existing files
  in place; the loaders read only the new names. `FRAMEYARD_POLICY` keeps
  its name.

### Fixed

- Timeline preview layers pin `color-scheme: light` on the embedded document
  root. A composition that declared a dark scheme could paint an opaque canvas
  base and hide every layer beneath it, so a timeline with a transparent
  overlay composition appeared to show only the overlay.
- Rotated timeline clips keep their full corners. Keyed rotation uses a
  segment-stable diagonal bound; static rotation uses its exact rotated
  bounding box.
- Animated-opacity masks use a 2×2 FFmpeg source instead of 1×1. FFmpeg 6
  rejects a 1×1 `yuv420p` frame, which broke keyframe, transition, and example
  renders on Ubuntu 24.04 runners.

[0.9.0]: https://github.com/vladiantio/frameyard/compare/v0.8.0...v0.9.0

## [0.8.0] - 2026-11-03

### Changed

- Compositions are partial HTML fragments instead of full HTML documents.
  Authors keep one top-level `<fy-composition>` root plus top-level props,
  controller, import maps, and styles; Frameyard generates the document shell,
  import map, sizing style, format block, and host runtime. A legacy full
  document fails with `COMPOSITION_DOCUMENT_SHELL`. See ADR 0016 and
  [migration-0.8](./docs/migration-0.8.md).
- Top-level author import maps are validated and hoisted after the framework
  map; `frameyard` and `frameyard/` specifiers are reserved and invalid maps
  report `IMPORT_MAP_INVALID`.
- `<fy-composition>` makes `width`, `height`, and `fps` optional and keeps
  `duration-in-frames` required only for an animated composition. An omitted
  value is inherited from the project `format`; a declared value wins, and
  `width`/`height` must be declared together. `CompositionSourceInfo` gains
  `declaredFormat`, and `project.json`/render results keep exposing resolved
  metadata.
- A composition that declares neither `duration-in-frames` nor `fps` is static.
  It has no frame clock, is captured once, and `render` writes `out/<id>.png`.
  `fps` without `duration-in-frames` is an error. See ADR 0017 and
  [migration-0.8](./docs/migration-0.8.md).
- Static compositions are visual-only: `data-fy-anim-*`, `<video>`, `<audio>`,
  and `<fy-transcript>` are errors. The host runs `mount()` and prop validation,
  skips `update()`, leaves frame-state variables unset, pauses CSS animations at
  time 0, and reports `STATIC_UPDATE_IGNORED` and `STATIC_ANIMATION_PAUSED`.
- A static composition clip in a timeline behaves like an image clip: it
  requires `duration`, rejects nonzero `sourceIn`, contributes no audio or
  transcripts, and is captured once per composition/props pair and reused
  across segments.
- `render` results are a discriminated union with `kind: "video"` or
  `kind: "image"`. Static composition renders reject `--container`, `--codec`,
  `--encoder`, and `--concurrency`. `check` adds `kind: "animated"` or
  `kind: "static"`; a static check inspects one state and reports
  `framesChecked: 1`.
- `still` on a static composition exposes exactly frame 0; other frames fail
  with `FRAME_OUT_OF_RANGE`.
- Preview loads a static composition once, disables its transport, and keeps a
  static timeline layer loaded without seeking it.
- Rendering a composition that omits dimensions in a project without `format`
  fails with `COMPOSITION_FORMAT_UNRESOLVED` instead of a document diagnostic;
  `check`, `still`, `render`, and the preview report the same actionable error.
  See ADR 0015.

### Added

- Visual timeline clips accept a static `blend` mode with the 12 separable CSS
  modes (`normal` through `exclusion`); `hue`, `saturation`, `color`, and
  `luminosity` are rejected because they need cross-channel math. Preview
  applies `mix-blend-mode` and stacks layers by track; production uses an
  alpha-aware FFmpeg composite. Nested timelines blend as flattened groups.
  See ADR 0014 and `examples/blend/`.
- Static composition validation, host, CLI, timeline, and preview coverage.

[0.8.0]: https://github.com/vladiantio/frameyard/compare/v0.7.0...v0.8.0

## [0.7.0] - 2026-11-02

### Added

- `render --container <mp4|mov|mkv|webm>`,
  `--codec <h264|hevc|vp9>`, and
  `--encoder <auto|software|nvenc|qsv>` select the delivery container, codec,
  and encoder for composition and timeline renders. `auto` is the default and
  probes NVENC, then Quick Sync, then the codec's software encoder. MP4 with
  H.264 stays the default and WebM defaults to VP9 with Opus; HEVC keeps the
  `hvc1` sample entry in MP4/MOV, the output extension must match the
  container, timeline workers are capped at the NVENC session limit, and render
  results report the resolved `container`, `codec`, and `encoder`.
- `still --frame` accepts a frame number, an inclusive range, or a
  comma-separated list and captures up to 32 unique frames in one invocation.
  Multi-frame output writes
  `still-<id>-<frame>.png` files to a directory; all frames are captured to
  temporary files before any file is published.
- `doctor` adds optional `ffmpeg-opus-encoder` and `ffmpeg-video-encoders`
  checks. The video check proves each supported encoder opens with a one-frame
  encode and reports advertised encoders that the driver or device cannot
  open; neither optional check affects `healthy`.

### Changed

- `still` results always include `frames`; `frame` and `path` remain only when
  exactly one frame was captured. The `--frame` contract, multi-frame `--out`
  directory behavior, and the 32-frame inspection cap are documented in
  ADR 0013. Single-frame output paths and pixels are unchanged.
- Typechecking uses TypeScript 7.0.2's native compiler. The three `tsconfig`
  projects pass unchanged and emit the same JavaScript and declarations.

### Fixed

- Embedded video settles on a presented frame in both composition capture and
  timeline preview, using one shared paint barrier with animation-frame and
  timeout fallbacks.
- Preview iframes pin a light color scheme to match the production capture
  context, so transparent compositions composite over the same base color.
- Arrow and Shift+Arrow transport keys pressed inside composition and timeline
  layer iframes reach the preview transport, while text entry does not step
  frames across iframe boundaries.

[0.7.0]: https://github.com/vladiantio/frameyard/compare/v0.6.0...v0.7.0

## [0.6.0] - 2026-11-01

### Added

- JSON timelines with project-fixed format, video/audio tracks, composition,
  media, and nested-timeline clips, source ranges, per-clip props, static
  transforms, audio settings, and derived or overridden duration.
- Timeline validation: strict schema, references, composition static
  validation, media probing, frame-rate checks, source bounds, overlaps,
  nested cycles, and structured diagnostics.
- Segmented timeline rendering: Chromium captures composition and
  nested-timeline clips to alpha-preserving FFV1 intermediates; FFmpeg
  composites and encodes segments; segments are concatenated in order; audio
  is mixed once and muxed.
- Transparent composition capture and nested timeline groups with recursive
  visual, still, check, and audio handling.
- Timeline preview in `dev`: composition and timeline selectors, program
  monitor, read-only tracks and clips, playhead, playback, frame stepping, and
  one-second jumps with buttons or arrow keys, audio controls, and diagnostics.
- Timeline visual transforms accept `width`/`height` as an explicit clip box,
  mutually exclusive with `scale`.
- `render`, `check`, and `still` accept timeline IDs alongside composition
  IDs. Timeline renders add `--workers` and `--scratch`; timeline `--props`
  is a map keyed by composition clip ID.
- `video.config.js` supports an optional project `format` and explicit
  `timelines` map. `project.json` publishes `format` and `timelines`.
- Timeline-first `init` scaffold with a composition clip, timeline override
  props, and `main` commands.
- Official skill reference for timelines, clips, tracks, nested timelines,
  props overrides, commands, preview, and determinism.
- Timeline config, schema, resolution, planning, rendering, preview, and
  runtime preview tests.

### Changed

- `render` defaults to `out/<id>.mp4` for timelines and compositions.
- `check` and `still` use timeline clip capture and composite behavior for
  timeline targets.
- Timeline audio mixing pads short inputs to the full timeline duration.
- Timed timeline layers are normalized to the project frame rate before
  compositing.
- The design baseline, glossary, and architecture decision records describe
  timelines as the render unit and compositions as clip sources.

### Fixed

- Composition audio, embedded video audio, and nested timeline audio are
  trimmed and shifted by clip source ranges and groups.
- Selecting a different composition in the preview picker reloads the iframe
  instead of leaving the previous composition loaded.

[0.6.0]: https://github.com/vladiantio/frameyard/compare/v0.5.0...v0.6.0

## [0.5.0] - 2026-10-31

### Added

- `test/examples.test.ts` captures a still from every bundled example.
- `pnpm compare-stills <a.png> <b.png>` reports an exact decoded-pixel diff and
  exits nonzero on any difference, for checking determinism at the capture
  boundary.
- The benchmark adds WebGL and embedded-video fixtures, `--concurrency`, and
  bench-only `--browser-arg`/`--no-browser-arg` A/B runs. `bench/README.md`
  documents the measurement recipe.

### Changed

- `render` no longer requires `--out`. The default output is
  `out/<composition-id>.mp4` inside the project root, and scaffolded projects
  ignore `out/` in `.gitignore`.
- Production capture composites frames in software while WebGL remains on
  SwiftShader, and opens and closes parallel browser sessions concurrently.
  Sequential and `--concurrency 4` renders are substantially faster; capture
  timing and pixels can change for existing projects. Determinism remains at
  the capture boundary for the same pinned runtime and inputs. See
  [ADR 0009](./docs/adr/0009-composite-production-frames-in-software.md).
- Static validation, the composition host, and preview share one browser-safe
  composition descriptor for metadata, props, controller, animation, media, and
  transcript declarations. This is an internal refactor with no authoring
  contract change.

### Fixed

- Embedded video seeks 1 ms past the frame time so millisecond-rounded WebM
  timestamps select the intended source frame.
- Capture sessions stay hidden until the first seek, so an animated ancestor
  cannot leave the load frame on screen in the captured still.

[0.5.0]: https://github.com/vladiantio/frameyard/compare/v0.4.0...v0.5.0

## [0.4.0] - 2026-10-30

### Breaking

- **Composition authoring model:** compositions are HTML documents, not
  JavaScript modules. `video.config.js` entries point to `.html` files, and the
  public `defineComposition` authoring path is removed. The `mount → update →
  dispose` lifecycle remains only as the optional controller contract.
- **Authoring namespace:** `fy-composition`, `fy-transcript`, `data-fy-*`,
  `--fy-*`, and `text/fy-controller` replace the corresponding
  `frameyard`/`data-frameyard-*` names. Existing embedded-media attributes move
  from `data-frameyard-*` to `data-fy-*`.
- **Executable code:** only the optional controller, inline or external, may
  execute. Other executable `<script>` elements and inline `on*` handlers are
  rejected.
- **Validation and karaoke:** domain validation and subtitle/karaoke rendering
  move to the optional controller; no built-in subtitle renderer is added.
- **Diagnostics:** warnings are structured diagnostic objects with `severity`,
  `code`, `message`, and optional `details`, not plain strings. Error envelopes
  gain optional `error.details` and top-level `diagnostics`. Unsupported visual
  elements inside a composition (`iframe`, `object`, `embed`) and `javascript:`
  URLs are rejected.

### Added

- Declarative HTML composition contract: `<fy-composition>` metadata, a
  `data-fy="props"` default-props block, `data-fy-text`, `data-fy-attr-*`,
  `data-fy-class-*`, `data-fy-if`, and `data-fy-repeat` bindings.
- Frame-scheduled CSS animation with `data-fy-anim-start`,
  `data-fy-anim-duration`, and `data-fy-anim-easing`, plus `--fy-frame`,
  `--fy-time`, `--fy-progress`, `--fy-fps`, and `--fy-duration` frame-state
  variables.
- Optional composition controller, inline or external, with `mount`, `update`,
  `dispose`, and `validateProps`. Inline controllers are extracted and served
  through a virtual module URL so relative imports and `import.meta.url` work.
- Node-side static composition validation before Chromium in `check`, `still`,
  and `render`, and on load in `dev`, with source-located diagnostics.
- Binding, animation, script, event-handler, unsupported-element, and
  asset-reference validation.
- `entry`, `controller`, and top-level `diagnostics` in `check`, `still`, and
  `render` JSON results.
- Agent-facing minimal skeleton, binding table, controller examples, and
  common-mistakes guidance in the skill and scaffold.
- Injected composition host exposing `window.__fy` with metadata, resolved
  audio/transcript clips, `load`, `seek`, `settle`, and `dispose`.
- HTML `<audio>` and `<fy-transcript>` declarations for the audio timeline and
  transcript requirements.
- Same-origin iframe preview and a direct render/check/still path that share
  the host API.

### Changed

- Preview loads each composition document in a same-origin iframe; `check`,
  `still`, and `render` navigate directly to the composition URL. The separate
  preview-page render path is removed.
- Static validation and the composition host read metadata, default props,
  controller declarations, animation, media, and transcript rules through one
  browser-safe composition document reader. Controller `src` is project-relative
  in host output; the authoring value is retained as `rawSrc`.
- `check` fails fast on static errors without launching Chromium; warnings
  still allow frame evaluation. Nested `data-fy-repeat` is rejected with a
  clear diagnostic; nested data uses the controller.
- `init` scaffolds an HTML composition and no longer generates a JavaScript
  composition module.
- The agent skill, README, design baseline, and project guides document the
  HTML model. See [the 0.4 migration guide](./docs/migration-0.4.md).

### Removed

- JavaScript composition modules, `defineComposition`, and the
  `data-frameyard-*` authoring attributes.
- The preview-page composition loading path used by the renderer.

[0.4.0]: https://github.com/vladiantio/frameyard/compare/v0.3.0...v0.4.0

## [0.3.0] - 2026-10-30

### Added

- Frame-accurate embedded video: local `<video>` elements are preloaded, paused,
  and seeked from the composition frame, with `data-frameyard-start`,
  `data-frameyard-trim`, `data-frameyard-duration`, and
  `data-frameyard-volume` attributes.
- Automatic mixing of unmuted embedded-video audio into the offline FFmpeg
  timeline, mirrored in preview. `muted` or `data-frameyard-audio="off"` keeps a
  video visual-only.
- Deterministic WebGL capture for WebGL 1 and WebGL 2 canvases. Production
  sessions pin SwiftShader so pixels do not vary with the host GPU.
- Media-settle step between `seek()` and capture for embedded video decode and
  browser paint.
- Optional parallel frame capture with `render --concurrency <n>` (1-16).
  Independent browser sessions seek and capture assigned frames while one
  ordered writer feeds a single FFmpeg encoder. Sequential rendering remains the
  default.
- `render --json` reports the effective `concurrency`.
- `MEDIA_INVALID` and `MEDIA_SEEK_FAILED` error codes for embedded-media
  validation and seek failures.

### Changed

- CI and the release workflow share `pnpm check`, and `pnpm verify-release`
  preflights the tag, version locations, changelog, branch, and working tree
  before a release is pushed.

[0.3.0]: https://github.com/vladiantio/frameyard/compare/v0.2.0...v0.3.0

## [0.2.0] - 2026-10-29

### Added

- `init` scaffolds an `AGENTS.md` project guide with the determinism rules and
  the `check`, `still`, and `render` workflow for coding agents.
- `init` scaffolds a private `package.json` whose `dev`, `check`, `render`, and
  `still` scripts pin the scaffolding CLI version, so `pnpm dev` and
  `npm run dev` work without a global install. Project names are normalized to
  valid npm package names.
- `init --json` reports the additional scaffold files.

### Changed

- **Skill contract:** the official agent skill moved from `skill/` to
  `skills/frameyard/` so agent hosts discover it automatically. The npm package
  ships `skills/` instead of `skill/`. Update copied or linked installations
  from the old path.
- User-facing documentation, CLI help, and generated project guides use
  `npx frameyard`; scaffolded scripts pin `npx --yes frameyard@<version>`.
- Development tooling moved to `oxlint` and `oxfmt`, with pre-commit hooks and
  matching CI and release workflow checks.

### Fixed

- Corrected documentation links and command examples after the skill relocation,
  and enforced the `npx frameyard` convention in `test/docs.test.ts`.

[0.2.0]: https://github.com/vladiantio/frameyard/compare/v0.1.0...v0.2.0

## [0.1.0] - 2026-10-28

### Added

- Native JavaScript composition contract with fixed `width`, `height`, `fps`,
  and `durationInFrames`, JSON props, and synchronous seek-safe `update()`.
- Browser runtime with deterministic frame time, keyed `random()`, CSS and Web
  Animations seeking, and preview diagnostics for non-deterministic clocks,
  randomness, and CSS transitions.
- Interactive preview with composition selection, prop editing, frame
  scrubbing, playback, and audio synchronization.
- CLI commands: `init`, `dev`, `check`, `still`, `render`, `tts`, `transcribe`,
  and `doctor`, with `--json` result envelopes and stable error codes.
- Deterministic Chromium capture through Playwright and FFmpeg H.264/AAC
  encoding, with atomic output publication and explicit overwrite flags.
- Audio clips placed on composition frames with source trimming in seconds and
  an offline FFmpeg mix.
- Canonical transcript validation, measured word timings, and SRT/VTT
  formatting, including transcript requirements attached to compositions.
- Local `qwen-tts` speech synthesis and `whisper-cli` transcription wrappers
  with executable resolution, atomic publishing, and a versioned provenance
  manifest.
- `frameyard doctor` environment, integration, and manifest inspection without
  downloading, repairing, or modifying anything.
- Host-neutral agent skill under `skill/`, versioned with the npm package API.
- 30-second reference composition, deterministic render benchmark, public-seam
  test suite, design baseline, and architecture decision records.

[0.1.0]: https://github.com/vladiantio/frameyard/releases/tag/v0.1.0
