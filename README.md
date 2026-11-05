# Frameyard

Frameyard is a local-first framework for building parameterized videos with HTML, CSS, and an optional JavaScript controller, assembling them into timelines, and rendering them deterministically.

The [design baseline](./docs/v0.x-design.md) defines the full product contract, and [`GLOSSARY.md`](./GLOSSARY.md) defines the domain terms.

**Contents:** [What's implemented](#whats-implemented) · [Quick start](#quick-start) · [Examples](#examples) · [Project setup](#project-setup) · [Composition authoring](#composition-authoring) · [Timelines](#timelines) · [Media](#media) · [Rendering and reproducibility](#rendering-and-reproducibility) · [Tooling](#tooling) · [Limits and non-goals](#limits-and-non-goals) · [Development](#development) · [License](#license)

## What's implemented

The current design is implemented end to end:

- HTML composition fragments, including static compositions captured as PNGs
- JSON timelines with tracks, clips, keyframes, transitions, and nested timelines
- Static clip blend modes, declarative bindings, CSS animation scheduling, and frame-state variables
- Inline and external controllers, plus composition and timeline hosts
- Static validation with structured diagnostics and an interactive preview with a read-only timeline
- Direct composition rendering and segmented lossless timeline rendering
- Audio, transcripts, deterministic Chromium capture, and FFmpeg output
- An official agent skill

## Quick start

### Requirements

- Node.js 22.12 or newer
- FFmpeg and FFprobe on `PATH`, built with H.264 (`libx264`), AAC, HEVC (`libx265`), VP9 (`libvpx-vp9`), and Opus (`libopus`) support. The software HEVC and VP9 encoders are only used for software renders; `--encoder nvenc` and `--encoder qsv` need no software encoder for that codec.
- The Playwright-managed Chromium build

Install the Playwright Chromium build with `npx playwright install chromium`. Run the CLI with `npx frameyard`; no global install is required.

Optional local integrations (`qwen-tts`, `sherpa-onnx-offline-tts`, and `whisper-cli`) are documented in [TTS and transcription](#tts-and-transcription).

### Scaffold a project

```sh
npx frameyard init my-video
cd my-video
npx frameyard dev
```

`dev` prints a local preview URL. Preview a composition with JSON props editing, or open the timeline for a program monitor, read-only tracks and clips, scrubbing, playback, frame-by-frame stepping, one-second jumps, and diagnostics.

The scaffold includes an `AGENTS.md` guide for coding agents working in the project, covering the HTML authoring rules and the `check`, `still`, and `render` workflow. It also includes a `package.json` with `dev`, `check`, `render`, and `still` scripts pinned to the scaffolding CLI version, so `pnpm dev` or `npm run dev` works without a global install, and a `.gitignore` that ignores `out/`.

`npx frameyard` resolves the latest published version. Pin it with `npx frameyard@<version>`, or install the package locally, when a project needs a fixed CLI version.

### Validate and render

```sh
npx frameyard doctor
npx frameyard check main
npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch
npx frameyard still main --frame 42 --out main-frame.png
npx frameyard still main --frame 0,118-126 --out out/stills
```

The scaffold wraps its composition in `timelines/main.timeline.json`. `render` writes the video to `out/main.mp4` in the project by default; pass `--out <file.mp4>` to choose another path. The composition remains renderable on its own with `npx frameyard render hello --props props/hello.json`. The scaffold's `.gitignore` ignores `out/`.

Continue with [Examples](#examples) for the bundled projects, or [CLI reference](#cli-reference) for every command and option.

## Examples

The repository ships runnable example projects. Each example README has the commands for running it from a repository checkout.

| Example | What it shows |
| --- | --- |
| [`examples/demo`](./examples/demo) | The 30-second reference composition and its timeline. |
| [`examples/webgl`](./examples/webgl) | A focused WebGL shader example with an external controller. |
| [`examples/video`](./examples/video) | Embedded-video compositions plus WebM and MP4 timelines that place clips on tracks under a transparent HTML overlay. |
| [`examples/blend`](./examples/blend) | Static CSS blend modes on composition and video clips. |
| [`examples/keyframes`](./examples/keyframes) | One timeline clip animated through every presentation channel. |
| [`examples/transitions`](./examples/transitions) | Three timed chord cards dissolved across one track with an audio crossfade. |
| [`examples/nested`](./examples/nested) | Two inner timelines repeated inside an outer timeline as full-frame and transformed group clips. |
| [`examples/static`](./examples/static) | A timeless composition rendered as a PNG and reused as a timeline image. |

## CLI reference

### Commands

| Command | Purpose |
| --- | --- |
| `frameyard init [directory] [--local-models]` | Scaffold a timeline-first HTML/JSON project with an `AGENTS.md` guide and pinned scripts; optionally add the local-model host scaffold |
| `frameyard dev [--port <port>]` | Start the preview server; preview compositions or open a timeline |
| `frameyard context [--project <dir>]` | Print a compact digest of format, composition metadata, props, timelines, assets, diagnostics, policy, and next commands |
| `frameyard lint <id> [--props <file>]` | Run static validation, timeline resolution, scene/keyframe projection, and a controller determinism scan without Chromium |
| `frameyard check <id> [--props <file>]` | Run static validation, then evaluate every animated frame or the single state of a static composition without capture |
| `frameyard still <id> --frame <spec>` | Capture one or more PNGs through the production path for a composition or timeline; a static composition exposes frame 0 |
| `frameyard inspect <image>` | Report dimensions, alpha, blank detection, colors, content bbox, luminance grid, and edge density |
| `frameyard compare <first> <second>` | Compare decoded pixels and 3×3 regions; exits 1 when the images differ |
| `frameyard render <id> [--out <video.mp4>]` | Render an animated composition directly, a static composition to PNG, or a timeline through the segmented lossless pipeline; defaults to `out/<id>.<ext>` |
| `frameyard tts ...` | Produce one frozen 24 kHz mono WAV with local qwentts.cpp or sherpa-onnx Supertonic 3 |
| `frameyard transcribe ...` | Produce canonical transcript JSON with optional word timings and SRT/VTT exports |
| `frameyard add --list` | List the built-in project templates and scaffolds |
| `frameyard add local-models` | Install the optional policy, OpenCode, and Pi scaffold into a workspace |
| `frameyard add <composition\|timeline> <id> --template <name>` | Write a template entry and print the exact `video.config.js` registration snippet |
| `frameyard font search [query]` | Search the Fontsource catalog by name, category, subset, style, or variable axis |
| `frameyard font add <fontsource-id>` | Install a pinned Fontsource family (variable `wght` by default, or static weights with `--static`) |
| `frameyard font add --file <path> --family <name>` | Vendor a local font into `assets/fonts/<id>/` and update `frameyard.fonts.json` |
| `frameyard font add --url <https-url> --family <name>` | Download and vendor a font from HTTPS (loopback HTTP for tests) |
| `frameyard font list` | List installed families, subsets, licenses, files, and status |
| `frameyard font verify` | Verify manifest paths, formats, hashes, licenses, and orphaned directories |
| `frameyard font remove <id>` | Remove a font from the manifest and delete its directory unless `--keep-files` is supplied |
| `frameyard doctor` | Inspect core requirements, optional integrations, policy, resources, and manifest integrity |

### Options

Common options: `--project <dir>`, `--json`, `--help`, and `--version`. `still` and `render` accept `--overwrite`; `tts` and `transcribe` accept `--force`; both flags are denied outside `full`.

`still --frame <spec>` accepts a frame, an inclusive range (`2-12`), or a comma list. Duplicates are removed, order is preserved, and one invocation captures at most 32 unique frames (1 in `light`, 4 in `authoring`). With one frame `--out` is a `.png`; with multiple it is a directory of `still-<id>-<frame>.png` files. A static composition exposes frame 0.

`render` accepts `--concurrency <n>` (1-16) for compositions, `--workers <n>` (1-16) and `--scratch <dir>` for timelines, and `--container`, `--codec`, and `--encoder` (see [Containers, codecs, and encoders](#containers-codecs-and-encoders)). `--out` must match the container; the default is `out/<id>.<ext>`. A static composition writes `out/<id>.png` and rejects the video flags.

For a timeline, `--props` is keyed by composition clip id; for a composition, it is the props object. `init` takes the directory positionally; `add --template <name>` selects a template and `add --list` lists them. `--out` paths are relative to the working directory. `tts`, `transcribe`, and `render` accept `--dry-run`, which prints the plan, handoff command, prerequisites, and blockers without writing, loading a model, launching Chromium, or encoding. `--profile shared-cpu` and `--low-priority` adjust caps and priority; see [Resource policy](#resource-policy).

`font search` accepts an optional query and `--category`, `--subset`, `--style`, `--variable`, and `--limit` filters. `font add <fontsource-id>` pins the Fontsource `npmVersion`, installs the variable `wght` face by default, and accepts `--static` plus `--weight`/`--style`/`--subset` lists. `font add --file` accepts `--id`, `--weight` (a number or an inclusive range), `--style normal|italic`, `--subset`, `--unicode-range`, `--license`, and `--license-file`. `font add --url` accepts the same metadata plus `--sha256`; HTTPS is required, with loopback HTTP allowed for tests. Font files are copied, hashed, and recorded in `frameyard.fonts.json`; adding another subset, style, or weight to the same family merges it into the existing entry. `--force` replaces a face or provider and is denied outside `full`.

A render fails immediately on an uncaught error, unhandled rejection, missing required asset, or invalid composition output. It writes to a temporary file and publishes only after FFmpeg succeeds; existing outputs are not replaced unless `--overwrite` is supplied.

### JSON results

Non-interactive commands support `--json`. Results go to stdout and human progress/diagnostics go to stderr:

```json
{
  "ok": true,
  "command": "check",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "metadata": { "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 900 },
  "framesChecked": 900,
  "diagnostics": []
}
```

Diagnostics carry `severity`, `code`, `message`, and optional `details` with source locations and suggestions. Errors use the same envelope with `error.details` and top-level `diagnostics`:

```json
{
  "ok": false,
  "command": "check",
  "error": { "code": "BINDING_INVALID", "message": "Unknown Frameyard attribute ..." },
  "diagnostics": [
    { "severity": "error", "code": "BINDING_INVALID", "message": "Unknown Frameyard attribute \"data-fy-txt\".", "details": { "path": "compositions/hello.html", "line": 12, "column": 5, "attribute": "data-fy-txt" } }
  ]
}
```

`doctor --json` reports findings rather than throwing: `ok: true` means inspection completed, while `healthy` reports whether required checks, manifests, models, and integrations passed. See the [JSON result reference](./skills/frameyard/references/json-results.md) for all shapes.

## Project setup

A project is ordinary HTML, CSS, JSON timelines, assets, and optional native JavaScript controller modules. `video.config.js` explicitly lists the project format, composition entry points, and timeline entry points; there is no directory scanning:

```js
export default {
  format: { width: 1920, height: 1080, fps: 30 },
  compositions: {
    hello: "./compositions/hello.html",
  },
  timelines: {
    main: "./timelines/main.timeline.json",
  },
};
```

The project `format` fixes width, height, and fps for timelines and supplies defaults for compositions that omit dimensions. A composition that declares no dimensions in a project without `format` fails with `COMPOSITION_FORMAT_UNRESOLVED`: declare `width`/`height` or add `format { width, height, fps }` to `video.config.js`. A composition-only project stays valid without `format` as long as its compositions declare their own. Fonts are independent of `video.config.js`: install them with `npx frameyard font add`, which maintains `frameyard.fonts.json` and `assets/fonts/`.

## Composition authoring

A composition is a partial HTML fragment with one top-level `<fy-composition>` root. Metadata, default props, markup, CSS, bindings, audio, transcripts, and an optional controller all live in the fragment; Frameyard generates the document shell at render time:

```html
<script type="application/json" data-fy="props">
{ "title": "Hello", "accent": "#b8f36b" }
</script>
<style>
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(24px); }
    to { opacity: 1; transform: translateY(0); }
  }
  #title { animation: fade-up 1s ease-out both; }
</style>
<fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
  <h1 id="title"
      data-fy-text="title"
      data-fy-anim-start="0"
      data-fy-anim-duration="30"></h1>
  <div id="progress" style="width: calc(var(--fy-progress) * 100%)"></div>
</fy-composition>
```

Do not add `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`; the framework owns the document shell, import map, and host runtime. Props, the controller, and import maps are top-level siblings of the root. Top-level `<style>` and `<link rel="stylesheet">` elements are hoisted into the generated head; styles inside the root stay in the body.

An optional top-level `<script type="importmap">` can add bare specifiers for controllers. Frameyard hoists it before the host module; `frameyard` and `frameyard/` specifiers are reserved.

`width`, `height`, and `fps` are optional: a missing value is inherited from the project `format`, and a declared value always wins. Declare `width` and `height` together or not at all. The same fragment above can therefore be written as `<fy-composition duration-in-frames="900">`, rendering at 1920×1080 and 30 fps because the project fixes that format. Props are JSON-serializable, deep-frozen, and merged shallowly over the `data-fy="props"` defaults. They cannot change metadata.

A composition that declares **neither** `duration-in-frames` nor `fps` is static. It has no frame clock, uses width/height only, is captured once, and renders to a PNG; `render hello` writes `out/hello.png`. Its controller may `mount()` and validate props, but `update()` is not called and frame-state variables are not set. CSS animations are paused at time 0 with a warning; `data-fy-anim-*`, `<video>`, `<audio>`, and `<fy-transcript>` are errors. Declaring `fps` without `duration-in-frames` is an error. A static composition used in a timeline behaves as an image clip: declare the clip `duration` and keep `sourceIn: 0`. See [`examples/static`](./examples/static).

### Bindings

`data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `<template data-fy-repeat>` apply props to the DOM once per load, before the controller mounts. Paths are dot-separated; missing paths warn. Primitive top-level props are also exposed as `--fy-prop-<name>` CSS custom properties. See the [bindings reference](./skills/frameyard/references/bindings.md) for repeat scope, coercion, and ordering.

### Animation

CSS `@keyframes` and the Web Animations API are the animation language. The runtime pauses and seeks every animation from the frame clock; `data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` schedule one animation per element in composition frames. Frame-state variables on `:root` are `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, and `--fy-duration-frames`. CSS transitions are not deterministic and are diagnosed. See [deterministic authoring](./skills/frameyard/references/deterministic-authoring.md#animation) for the full rules.

### Controller

An optional controller handles what HTML and CSS cannot express. Declare it exactly once, inline or as an external module:

```html
<script type="text/fy-controller">
export default {
  mount({ root, props }) { /* ... */ },
  update({ frame, props, root }) { /* ... */ },
  dispose() { /* ... */ },
  validateProps(props) { /* ... */ },
};
</script>
```

`mount()` may be asynchronous; `update()` and `validateProps()` are synchronous and seek-safe; `dispose()` releases resources. The controller is the only executable code in a composition. Inline source is served as a virtual module, so relative imports and `import.meta.url` work; escape a literal `</script>`. See the [controller reference](./skills/frameyard/references/controllers.md) for external modules, validation-only controllers, and Canvas/WebGL.

### Canvas and WebGL

WebGL 1 and WebGL 2 canvases are captured through the normal frame path. Draw the complete frame from the controller's `update()` and do not depend on the previous frame's drawing buffer; clear or redraw the scene each time. Production sessions pin software WebGL (SwiftShader) so rendered pixels do not vary with the host GPU. See [`examples/webgl`](./examples/webgl) for a complete shader example.

### Composition lifecycle

The host loads the document, applies bindings, imports the controller, calls `mount()`, prepares media, and seeks to frame 0. `check`, `still`, and `render` then seek to requested frames and wait for media and paint before evaluating or capturing. `update({ frame, props })` is synchronous and seek-safe; use `random("stable:key")` instead of `Math.random()`, timers, or wall-clock reads. `check` runs static validation before launching Chromium and reports stable diagnostic codes with source locations.

## Timelines

A timeline is a JSON document that places composition and media clips on video and audio tracks. It inherits the project format and derives its duration from the latest clip end unless it declares `durationInFrames`:

```json
{
  "version": 1,
  "tracks": [
    { "id": "v1", "kind": "video" },
    { "id": "a1", "kind": "audio" }
  ],
  "clips": [
    {
      "id": "hello",
      "track": "v1",
      "source": { "kind": "composition", "id": "hello" },
      "start": 0,
      "duration": 150
    },
    {
      "id": "music",
      "track": "a1",
      "source": { "kind": "audio", "src": "assets/music.wav" },
      "start": 0,
      "duration": 150,
      "audio": { "gain": 0.5 }
    }
  ]
}
```

- Sources are `composition` + `id`, `timeline` + `id`, or `video`/`image`/`audio` + project-relative `src`.
- `start`, `sourceIn`, and `duration` use timeline frames. Image clips and static composition clips require a duration.
- Composition clips can fix `props` and trim the source range; a static composition clip needs `sourceIn: 0`, an explicit duration, and contributes no audio. An animated composition's `fps` must match the project.
- Visual clips support static `fit`, `width`/`height`, `x`, `y`, `scale`, `rotation`, `opacity`, and `blend`, and can animate `x`, `y`, `scale`, `rotation`, and `opacity` with clip-local `keyframes`.
- Video, composition, and nested-timeline clips contribute audio automatically unless muted; timeline audio clips live on audio tracks and support `gain` and `muted`.
- Two clips on one track may overlap when a timeline-level `transitions` entry pairs them with `dissolve` or `crossfade`; undeclared overlap is an error.
- Nested timelines are groups: the parent transform, opacity, and blend mode apply to the whole nested result, and nested audio is included.

The [timeline reference](./skills/frameyard/references/timelines.md) documents every field, constraint, easing, transition geometry, and diagnostic. See the bundled examples for [keyframes](./examples/keyframes), [transitions](./examples/transitions), and [nested timelines](./examples/nested).

## Media

Compositions and timelines can use embedded video, audio, and transcripts.

### Embedded video

Declare videos in the fragment; the runtime pauses and frame-seeks them:

```html
<video
  src="assets/clip.webm"
  data-fy-start="30"
  data-fy-trim="0.5"
  data-fy-duration="4"
  data-fy-volume="0.8"
></video>
```

| Attribute | Meaning | Default |
| --- | --- | --- |
| `data-fy-start` | Composition frame where the source starts | `0` |
| `data-fy-trim` | Seconds trimmed from the source start | `0` |
| `data-fy-duration` | Optional seconds of source to use | rest of source |
| `data-fy-volume` | Embedded audio volume from `0` to `1` | `1` |

Do not call `play()`, `pause()`, or set `currentTime`. Videos must be in the light DOM, are local project-relative files, and are fully loaded before frame production; remote URLs and live streams are not supported. An unmuted video contributes its soundtrack to the mix; set `muted` or `data-fy-audio="off"` for a visual-only asset. Fade overlay layers, not a full-scene ancestor of a video. See [`examples/video`](./examples/video) and [deterministic authoring](./skills/frameyard/references/deterministic-authoring.md#embedded-video-and-audio).

### Audio

Audio clips are `<audio>` elements with `data-fy-start` (composition frames), `data-fy-trim` (source seconds), optional `data-fy-duration`, and `data-fy-volume` (0-1). Frameyard never time-stretches audio or changes composition duration to fit it; `check` reports clip durations and overrun diagnostics. Preview synchronizes in the browser and production mixes the same clips offline with FFmpeg. See [audio assets](./skills/frameyard/references/audio-assets.md#audio-timeline).

### Transcripts

Declare canonical transcripts with `<fy-transcript src="assets/voice.transcript.json" words>`. Paths resolve from the project root; `words` requires measured word timings and fails with `TRANSCRIPT_WORDS_UNAVAILABLE` rather than interpolating them. `check`, `still`, and `render` validate declared transcripts; rendering timed text is the composition's responsibility. See [subtitles and karaoke](./skills/frameyard/references/subtitles-karaoke.md).

### Fonts

Frameyard reads installed fonts from `frameyard.fonts.json` and serves one generated `@font-face` sheet to every composition. Fontsource is the default catalog:

```sh
npx frameyard font search "space grotesk" --subset latin --json
npx frameyard font add space-grotesk --subset latin
```

`font add` pins the Fontsource `npmVersion`, downloads only the requested WOFF2 subset/style/weight, vendors the package `LICENSE`, and records the SHA-256 and exact CDN URL. Variable families install the `wght` face by default; pass `--static --weight 400,700` for static files. A local or brand font uses the same manifest:

```sh
npx frameyard font add --file ./fonts/SpaceGrotesk.woff2 \
  --family "Space Grotesk" --weight 300-700 --subset latin \
  --license OFL-1.1 --license-file ./fonts/OFL.txt
```

An HTTPS URL is also accepted with `--sha256`:

```sh
npx frameyard font add --url https://example.com/Inter.woff2 \
  --family "Inter" --license OFL-1.1 --sha256 <hash>
```

A URL import without `--license` or `--license-file` is recorded as unknown, warns, and requires the `full` policy. There is no shared font cache. Use the family name in CSS as usual:

```css
.title {
  font-family: "Space Grotesk", system-ui, sans-serif;
  font-weight: 700;
}
```

`font list` and `font verify` report the installed families and integrity. The generated sheet uses `font-display: block`; the host waits for `document.fonts.ready` and fails with `FONT_LOAD_FAILED` when a used face cannot load. Remote font URLs produce a `FONT_REMOTE` warning and are not a reproducibility guarantee. Commit `frameyard.fonts.json`, `assets/fonts/`, and license files with the project. See [fonts](./skills/frameyard/references/fonts.md) for Fontsource filters, static weights, URL imports, and licensing.

## Rendering and reproducibility

Production rendering has two targets.

### Composition pipeline

A composition renders directly:

1. Static composition validation resolves metadata before launching Chromium.
2. Chromium navigates to the served composition document with the composition host.
3. For an animated composition, one session, or several when `--concurrency` is greater than 1, seeks every frame, calls the controller, seeks CSS/WAAPI animations, and waits for embedded media decode and paint. A static composition loads once and captures one PNG without seeking frames.
4. The viewport is captured through the Chrome DevTools Protocol, piped to FFmpeg, and encoded as H.264, HEVC, or VP9 with AAC or Opus audio.

### Timeline pipeline

A timeline renders through segments:

1. Static timeline validation resolves references, media, nested timelines, durations, props, audio, overlaps, and transition geometry.
2. The timeline is split at active-layer changes and a maximum segment duration.
3. In parallel workers, Chromium captures active composition and nested-timeline clips to alpha-preserving FFV1 intermediates. A static composition is captured once per props variant as a transparent PNG and reused as an image layer across segments.
4. FFmpeg applies fit, presentation keyframes, transition alpha, opacity, video/image decoding, and audio mixing, and encodes each segment as H.264, HEVC, or VP9.
5. Segments are concatenated in timeline order without re-encoding and the global audio mix is muxed into the final output.

Composition concurrency changes scheduling only. Timeline workers process independent segments; output order and captured composition frames remain deterministic. `check` and `still` use the same clip capture and composite path as their target. A multi-frame `still` captures sequentially, reuses one preview server, and its frames are pixel-identical to capturing each frame separately. A static composition render performs one capture and does not seek frames.

### Containers, codecs, and encoders

Both targets encode H.264 in MP4 by default. `--container` selects `mp4`, `mov`, `mkv`, or `webm`; `--codec` selects `h264`, `hevc`, or `vp9`; `--encoder` selects `software`, `nvenc`, `qsv`, or `auto`. WebM defaults to VP9/Opus; MP4 and MOV hold H.264/HEVC with AAC; MKV holds all three. `auto` probes NVENC, then Quick Sync, then software. Hardware encoders produce different bytes, so use `software` for reproducible A/B measurements. HEVC uses the `hvc1` tag in MP4/MOV; H.264 remains the portable default. NVENC caps timeline workers at eight.

### Determinism guarantees

For the same composition or timeline revision, props, assets, segment plan, frame, and pinned runtime/browser/FFmpeg environment, the captured composition frames and deterministic composite are identical. Encoded bytes are not a reproducibility guarantee, even on the same machine; they depend on the FFmpeg build, encoder threading, and runtime environment. Preview composites in Chromium while timeline production composites with FFmpeg, so small differences in scaling, alpha, and video color conversion are expected; parity is guaranteed at clip capture.

### Benchmarks and evals

For a repeatable local measurement of seek, capture, encode, and full-render time, run `pnpm bench`; `pnpm bench:static` compares an animated composition with the same visual rendered as a static PNG. See `bench/README.md` for the measurement recipe. For local-model authoring evals against a llama.cpp router, run `pnpm eval:local`; see `evals/README.md`. It is opt-in, never renders, and is not part of `pnpm check`. Timeline performance is tracked separately with the long-form benchmarks; the representative target and worst-case measurements are in [ADR 0012](./docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md).

## Tooling

### TTS and transcription

`tts` and `transcribe` wrap optional local executables. Frameyard never builds upstream tools, downloads models, or runs inference during composition loading or frame production.

Optional executables are `qwen-tts` from [`qwentts.cpp`](https://github.com/ServeurpersoCom/qwentts.cpp), `sherpa-onnx-offline-tts` from [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) v2.0.1 plus the Supertonic 3 model archive, and `whisper-cli` from [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp).

```sh
npx frameyard tts --speaker vivian --talker-model models/qwen-talker-1.7b-customvoice-Q8_0.gguf \
  --codec-model models/qwen-tokenizer-12hz-Q8_0.gguf --language English \
  --text-file script.txt --out assets/voice.wav

npx frameyard transcribe assets/voice.wav --model models/ggml-base.en.bin \
  --out assets/voice.transcript.json --words --export srt,vtt
```

`tts` defaults to qwentts.cpp CustomVoice; `--engine supertonic` requires `--model-dir`, a numeric `--speaker`, and a language code. Executable resolution is `--executable`, then the engine's environment variable, then `PATH`. Outputs are atomic and replaced only with `--force`; successful operations update `frameyard.assets.json` with hashes, generator details, models, parameters, and transcription source identity. Commit it with the project.

The [audio assets reference](./skills/frameyard/references/audio-assets.md) covers both engines, transcription options, the provenance manifest, regeneration rules, and pinned upstream revisions.

### Doctor

```sh
npx frameyard doctor
npx frameyard doctor --json
npx frameyard doctor --talker-model models/talker.gguf --codec-model models/codec.gguf
npx frameyard doctor --sherpa-onnx-tts /path/to/sherpa-onnx-offline-tts --model-dir models/supertonic
```

`doctor` checks Node, FFmpeg and required encoders, FFprobe, Playwright Chromium, manifest integrity (artifact, source, model, and derived-export hashes), installed fonts, explicitly supplied model readability, and optional `qwen-tts`, `sherpa-onnx-offline-tts`, and `whisper-cli` capabilities. It also reports the active resource policy and basic CPU, load, and memory resources. Pass `--talker-model`, `--codec-model`, `--model-dir`, or `--model` to inspect model readability before generation. It does not repair, download, or modify anything. Missing optional integrations do not fail, but a found executable with incompatible capabilities does.

### Context, inspect, and compare

`frameyard context --json` is a compact, read-only digest for agents and editors. It reports the project root and format, each composition's resolved metadata, prop keys and types, controller, and diagnostics; each timeline's duration, tracks, clip summaries, transitions, audio/transcript counts, and diagnostics; unique assets; installed fonts; the active policy; and a short list of next commands. It never launches Chromium.

`frameyard inspect <image> --json` decodes the first frame and reports dimensions, bytes, alpha range and coverage, blank detection, the dominant background and colors, the content bounding box, a coarse luminance grid, and edge density. `frameyard compare <first> <second> --json` reports differing pixels, percentage, maximum and mean channel delta, a bounding box, and a 3×3 region breakdown. `compare` exits 1 when the images differ; its JSON result still has `ok: true` and `identical: false`. Neither command replaces viewing a still when the host supports images.

### Templates

`frameyard add --list` lists the built-in project templates: `static-poster`, `title-card`, `lower-third`, and `slideshow`. Add writes one valid entry and prints the exact `video.config.js` registration snippet; it deliberately does not edit the config.

```sh
npx frameyard add composition intro --template lower-third
npx frameyard add timeline reel --template slideshow
npx frameyard add local-models
```

`init --local-models` installs the same optional host scaffold for a new project:

```sh
npx frameyard init my-project --local-models
```

The composition and timeline templates inherit the project `format`. The slideshow timeline expects `assets/slide-1.png` through `assets/slide-3.png`; provide them before `check`. An existing file or registered id is never overwritten.

### Resource policy

An optional `frameyard.policy.json` in the working directory or nearest ancestor gates expensive operations. It is independent of `video.config.js`, so it also applies with `--project`.

| Tier | `still` | `check` | `tts` / `transcribe` / `render` | `--force` / `--overwrite` |
| --- | --- | --- | --- | --- |
| `light` | 1 frame | blocked | blocked | denied |
| `authoring` | 4 frames | allowed at low priority | blocked | denied |
| `full` | 32 frames | allowed | allowed | allowed |

`lint`, `doctor`, `init`, `dev`, and `--dry-run` are available in every tier. `font search`, `font list`, and `font verify` are available in every tier; `font add` requires `authoring` or `full`; `font remove`, `font add --force`, and `font add --url` without `--license`/`--license-file` require `full`. A policy file can only tighten its tier; unknown fields fail with `POLICY_INVALID`. `FRAMEYARD_POLICY=light|authoring|full` overrides the file; the default is `full`. `--profile shared-cpu` caps timeline workers at 2 and composition concurrency at 1, lowers priority, and leaves the encoder at `auto`; `--low-priority` lowers priority without the caps. Values above the cap fail with `RESOURCE_PROFILE_CONFLICT`. The policy is a guardrail, not a security boundary.

Install the optional local-model scaffold with `npx frameyard add local-models`, or `npx frameyard init my-project --local-models`; see [`LOCAL-MODELS.md`](./scaffolds/local-models/LOCAL-MODELS.md). See [ADR 0022](./docs/adr/0022-gate-heavy-operations-with-a-workspace-resource-policy.md) for the full contract.

### Agent skill

The optional host-neutral agent skill lives in [`skills/frameyard/`](./skills/frameyard). It uses the same project format and CLI as humans, documents HTML authoring, bindings, controllers, static diagnostics, fonts, audio assets, subtitle/karaoke recipes, JSON results, and failure recovery, and ships a thin CLI wrapper. The npm package includes the skill files matching its API version. Install it with `npx skills add vladiantio/frameyard`, or see [`skills/frameyard/README.md`](./skills/frameyard/README.md) for host-specific installation or referencing.

## Limits and non-goals

Deferred from this implementation slice:

- Animated blend modes, filters, masks, and audio fades; GPU compositing and codecs beyond H.264, HEVC, and VP9
- Full visual timeline editing, drag-and-drop, trim handles, and undo/redo; timeline-level variables and prop overrides inside nested timelines
- Per-timeline formats and frame-rate conversion/retiming; persistent clip caches
- Built-in subtitle rendering, automatic caption burn-in, and declarative karaoke elements
- Nested `data-fy-repeat` scopes, a general template language, and declarative JSON Schema validation
- Typography roles (`--fy-font-display`, `--fy-font-body`), font-pair presets, a preview font picker, and variable axes other than `wght`
- `qwentts.cpp` voice cloning and VoiceDesign; Supertonic voice cloning and emotion selection; long-text chunking, streaming synthesis, and alternative generated-audio formats
- Exporting a fully static timeline as a PNG or recursively optimizing static nested timelines

Deliberate non-goals:

- Arbitrary executable scripts in composition HTML
- Automatic upstream builds, model downloads, environment repair, and hosted rendering
- A shared font cache or hosted font catalog; Google Fonts, Fontshare, and Bunny Fonts are not first-class providers. Fontsource is the catalog, and local/HTTPS imports cover the rest.
- Unbounded batch still capture and general image-sequence output; `still` accepts at most 32 inspection frames per invocation, and the active resource policy may cap it lower
- Audio, transcripts, or embedded video in a static composition; use a timeline. A `--video` escape hatch is not provided; use a timeline image clip.
- React or other UI-framework adapters, plugin APIs, and agent-only runtimes; TypeScript transpilation for project compositions and npm dependency optimization

See the [design baseline](./docs/v0.x-design.md) for the full product contract, [ADR 0007](./docs/adr/0007-make-html-documents-the-composition-unit.md) for the HTML authoring decision, [ADR 0010](./docs/adr/0010-make-timelines-the-render-unit.md) for timelines, [ADR 0012](./docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md) for segmented rendering, [ADR 0013](./docs/adr/0013-capture-bounded-multi-frame-stills-for-inspection.md) for bounded multi-frame stills, [ADR 0016](./docs/adr/0016-author-compositions-as-html-fragments.md) for fragment composition authoring, [ADR 0017](./docs/adr/0017-render-timeless-compositions-as-stills.md) for static composition rendering, the [0.8 migration guide](./docs/migration-0.8.md), and the [domain glossary](./GLOSSARY.md) for terminology.

## Development

### Repository layout

- `src/`: framework source, split into browser-safe contracts, composition grammar, runtime, preview, server, renderer, assets, and CLI.
- `scaffolds/`: `init` and optional `local-models` project templates.
- `skills/frameyard/`: host-neutral agent skill and references.
- `examples/`: runnable demo, WebGL, video, blend, keyframes, transitions, nested, and static projects.
- `docs/`: design baseline, ADRs, migration guides, and preview testing.
- `bench/`, `scripts/`, `test/`: benchmarks, release tooling, and the public-seam test suite.

See [AGENTS.md](./AGENTS.md) for the per-file architecture and invariants.

### Local development

From a repository checkout:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm check
node dist/cli.js doctor
```

These commands use the local build; `npx frameyard` runs the published package.

`pnpm check` runs the script syntax checks, lint, formatting checks, typechecks, and the full suite. `pnpm install` installs the repository's git hooks; pre-commit runs `pnpm check:static` and the unit tests, and pre-push runs the full suite. CI runs the same `pnpm check` on Linux with Node 22 and 24. For preview-only UI work, `pnpm check:preview` runs the static checks and the preview tests without the full suite; it does not replace `pnpm check` in CI or before pushing.

CI uses fake `qwen-tts`, `sherpa-onnx-offline-tts`, and `whisper-cli` executables. Real-model tests are opt-in: set `FRAMEYARD_REAL_INTEGRATIONS=1` plus the model paths read by `test/real-integrations.test.ts`, then run `pnpm vitest run test/real-integrations.test.ts`. Optional variables include `FRAMEYARD_REAL_TTS_DEVICE=CPU` and `FRAMEYARD_REAL_SUPERTONIC_MODEL_DIR`.

### Releases

Releases are tag-driven. See [`RELEASING.md`](./RELEASING.md) for version policy, npm trusted publishing, and the release checklist, and [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

## License

MIT
