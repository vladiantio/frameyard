# Frameyard

Frameyard is a local-first framework for building parameterized videos with HTML, CSS, and an optional JavaScript controller, assembling them into timelines, and rendering them deterministically.

The 0.6 design is implemented: HTML composition documents, JSON timelines with tracks and clips, nested timelines, declarative bindings, CSS animation scheduling, frame-state variables, inline and external controllers, composition and timeline hosts, static validation with structured diagnostics, an interactive preview with a read-only timeline, direct composition rendering, segmented lossless timeline rendering, audio and transcripts, deterministic Chromium capture, FFmpeg output, and the official agent skill.

## Requirements

- Node.js 22.12 or newer
- FFmpeg and FFprobe on `PATH`, built with H.264 (`libx264`) and AAC support
- The Playwright-managed Chromium build
- Optional: `qwen-tts` from [`qwentts.cpp`](https://github.com/ServeurpersoCom/qwentts.cpp) for local speech synthesis
- Optional: `whisper-cli` from [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp) for local transcription

Install the Playwright Chromium build with `npx playwright install chromium`. Run the CLI with `npx frameyard`; no global install is required.

The wrappers target the CLI surfaces of qwentts.cpp commit `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4` and whisper.cpp commit `284029c07012d2000941a08d38a31ffb71f4734e`.

## Quick start

Scaffold a project:

```sh
npx frameyard init my-video
cd my-video
npx frameyard dev
```

`dev` prints a local preview URL. Preview a composition with JSON props editing, or open the timeline for a program monitor, read-only tracks and clips, scrubbing, playback, frame-by-frame stepping, one-second jumps, and diagnostics.

The scaffold includes an `AGENTS.md` guide for coding agents working in the project, covering the HTML authoring rules and the `check`, `still`, and `render` workflow. It also includes a `package.json` with `dev`, `check`, `render`, and `still` scripts pinned to the scaffolding CLI version, so `pnpm dev` or `npm run dev` works without a global install, and a `.gitignore` that ignores `out/`.

`npx frameyard` resolves the latest published version. Pin it with `npx frameyard@<version>`, or install the package locally, when a project needs a fixed CLI version.

Validate and render:

```sh
npx frameyard doctor
npx frameyard check main
npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch
npx frameyard still main --frame 42 --out main-frame.png
```

The scaffold wraps its composition in `timelines/main.timeline.json`. `render` writes the video to `out/main.mp4` in the project by default; pass `--out <file.mp4>` to choose another path. The composition remains renderable on its own with `npx frameyard render hello --props props/hello.json`. The scaffold's `.gitignore` ignores `out/`.

The 30-second reference composition lives in [`examples/demo`](./examples/demo), a focused WebGL shader example lives in [`examples/webgl`](./examples/webgl), and the video example in [`examples/video`](./examples/video) includes two embedded-video compositions plus WebM and MP4 timelines that place the clips on tracks under a transparent HTML overlay. Each README has the commands for running it from a repository checkout.

## Project format

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

A composition is a full HTML document with one `<fy-composition>` root. Metadata, default props, markup, CSS, bindings, audio, transcripts, and an optional controller all live in the document:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
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
  </head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
      <h1 id="title"
          data-fy-text="title"
          data-fy-anim-start="0"
          data-fy-anim-duration="30"></h1>
      <div id="progress" style="width: calc(var(--fy-progress) * 100%)"></div>
    </fy-composition>
  </body>
</html>
```

`width`, `height`, `fps`, and `duration-in-frames` are fixed. Props are JSON-serializable, deep-frozen, and merged shallowly over the `data-fy="props"` defaults. They cannot change metadata.

### Timeline

A timeline is a JSON document that places composition and media clips on video and audio tracks. It inherits the project format and derives its duration from the latest clip end unless it declares `durationInFrames`:

```json
{
  "version": 1,
  "tracks": [
    { "id": "v1", "kind": "video" },
    { "id": "v2", "kind": "video" },
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
      "id": "logo",
      "track": "v2",
      "source": { "kind": "image", "src": "assets/logo.png" },
      "start": 30,
      "duration": 60,
      "transform": { "fit": "contain", "width": 480, "height": 270, "x": 640, "y": -320, "rotation": 0, "opacity": 0.9 }
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
- `start`, `sourceIn`, and `duration` use timeline frames. Omitted durations use the rest of the source; image clips require a duration.
- Composition clips can fix `props`, trim the source range, and repeat the same composition with different settings.
- Visual clips support static `fit`, `width`/`height` (an explicit box), `x`, `y`, `scale`, `rotation`, and `opacity`. `fit` applies inside the box; `width` and `height` go together and are mutually exclusive with `scale`. No keyframes, transitions, or effects in 0.6.
- Video, composition, and nested-timeline clips contribute audio automatically unless muted. Timeline audio clips live on audio tracks.
- A composition used in a timeline must match the project fps; different sizes are fitted by the clip. Clips on one track cannot overlap.
- Nested timelines are rendered as groups, so the parent clip's opacity and transform apply to the whole nested result.

### Bindings

- `data-fy-text="path"` sets text content.
- `data-fy-attr-src="path"` (and other `data-fy-attr-*` names) sets an attribute.
- `data-fy-class-active="path"` toggles a class.
- `data-fy-if="path"` removes the element when the value is false.
- `<template data-fy-repeat="items">` clones its content for each item, with `item` and `index` in scope and `--fy-index` on each clone.
- Paths are dot-separated (`user.name`, `items.0.label`). Missing paths warn and resolve to an empty value.
- Primitive top-level props are also exposed as `--fy-prop-<name>` CSS custom properties.

Bindings apply once when a composition loads, before the controller mounts. Controller-created DOM is the controller's responsibility.

### Animation

CSS `@keyframes` and the Web Animations API are the animation language. The runtime pauses every animation and seeks it from the frame clock.

`data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` schedule one animation per element in composition frames. The CSS `animation` shorthand supplies keyframes and fill mode; the attributes override its delay and duration.

The runtime sets frame-state variables on `:root`:

| Variable | Meaning |
| --- | --- |
| `--fy-frame` | Current frame |
| `--fy-time` | Current time in seconds |
| `--fy-progress` | Progress from `0` to `1` |
| `--fy-fps` | Composition frame rate |
| `--fy-duration` | Duration in seconds |
| `--fy-duration-frames` | Duration in frames |

Use `--fy-progress` for progress bars and `--fy-frame` or `--fy-time` in `calc()` for simple computed motion. CSS transitions are not deterministic and are diagnosed.

### Controller

An optional controller handles what HTML and CSS cannot express. It is declared exactly once, either inline or as an external module:

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

```html
<script type="text/fy-controller" src="./hello.controller.js"></script>
```

- `mount()` may be asynchronous; `update()` and `validateProps()` are synchronous and seek-safe; `dispose()` releases resources.
- Inline controllers are the default for small, single-use controllers. Extract to an external module for Canvas 2D, WebGL, karaoke, reuse, tests, or a large controller.
- A validation-only controller may export just `validateProps(props)`.
- The controller is the only executable code in a composition. Other executable scripts and `on*` handlers are rejected.
- Inline source is served through a virtual module URL, so relative imports and `import.meta.url` behave like an external module. A literal `</script>` inside inline source must be escaped.

### Composition lifecycle

The composition host loads the document, applies bindings, imports the controller, calls `mount()`, prepares media, and seeks to frame 0. `check`, `still`, and `render` then seek explicitly to requested frames and wait for embedded media and browser paint before evaluating or capturing. `dispose()` runs before the host releases the document.

The controller lifecycle is `mount → update → dispose`. `update({ frame, props })` must be synchronous and seek-safe. Use `random("stable:key")` from `frameyard/runtime` instead of `Math.random()`. Independent `requestAnimationFrame` loops, timers, wall-clock reads, and CSS transitions are not deterministic animation drivers.

`check` runs static composition validation before launching Chromium. It validates metadata, the root and controller declarations, default props, bindings, animation attributes, scripts and handlers, unsupported visual elements, and asset references, then reports stable diagnostic codes with source locations.

## Embedded video and WebGL

Embedded videos are declared in the composition document and frame-seeked by the runtime:

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

The runtime pauses every video and seeks it to the frame-derived source time. Do not call `play()`, `pause()`, or set `currentTime` in a controller. Videos must be in the composition document's light DOM; shadow roots are not scanned. Video sources are local project-relative files; live streams, remote URLs, and sources that cannot be seeked are not supported. The runtime loads the complete file during the loading phase, so frame production performs no media network requests.

An unmuted `<video>` also contributes its soundtrack to the same timeline as declarative audio clips. Frameyard extracts that track with FFmpeg for production and mirrors it in preview, while keeping the video element itself silent. Set `muted` or `data-fy-audio="off"` to use a video as a visual-only asset. See [`examples/video`](./examples/video) for the same composition driven by a VP9/Opus WebM clip and an H.264/AAC MP4 clip.

Fade the overlay layers, not a full-scene ancestor of a video. Chromium can reuse the load frame in interactive preview after a large seek when an ancestor animates opacity. Production captures keep the composition hidden until the first seek, so stills resolve to the requested frame.

WebGL 1 and WebGL 2 canvases are captured through the normal frame path. Draw the complete frame from the controller's `update()` and do not depend on the previous frame's drawing buffer; clear or redraw the scene each time. Production sessions pin software WebGL (SwiftShader) so rendered pixels do not vary with the host GPU. See [`examples/webgl`](./examples/webgl) for a complete shader example.

## Audio timeline

Audio clips are `<audio>` elements:

```html
<audio src="assets/voice.wav"
       data-fy-start="30"
       data-fy-trim="0.25"
       data-fy-duration="4.2"
       data-fy-volume="0.8"></audio>
```

- Placement is in composition frames.
- Trimming is in seconds from the source.
- Audio, video, and transcript `src` values resolve from the project root.
- Frameyard never time-stretches audio or changes composition duration to fit it.
- `check` reports clip durations and overrun diagnostics.

Preview synchronizes the timeline in the browser. Production mixes the same clips offline with FFmpeg. Unmuted embedded videos contribute their audio tracks to this mix unless they opt out.

## Transcripts

A composition declares canonical transcript assets with `<fy-transcript>`:

```html
<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
```

Transcript paths resolve from the project root. `words` requires actual measured word timings for karaoke-style presentation; Frameyard fails with `TRANSCRIPT_WORDS_UNAVAILABLE` rather than interpolating them. `check`, `still`, and `render` validate declared transcripts. Visual presentation is the composition's responsibility; a controller can read the transcript JSON and render timed text or karaoke. See [subtitles and karaoke](./skills/frameyard/references/subtitles-karaoke.md) for the canonical JSON shape and the seek-safe frame conversion recipe.

## Commands

| Command | Purpose |
| --- | --- |
| `frameyard init [directory]` | Scaffold a timeline-first HTML/JSON project with an `AGENTS.md` guide and pinned scripts |
| `frameyard dev [--port <port>]` | Start the preview server; preview compositions or open a timeline |
| `frameyard check <id> [--props <file>]` | Run static validation, then evaluate every frame of a composition or timeline without capture |
| `frameyard still <id> --frame <n>` | Capture one PNG through the production path for a composition or timeline |
| `frameyard render <id> [--out <video.mp4>]` | Render a composition directly, or a timeline through the segmented lossless pipeline; defaults to `out/<id>.mp4` |
| `frameyard tts ...` | Produce one frozen 24 kHz mono WAV with local qwentts.cpp |
| `frameyard transcribe ...` | Produce canonical transcript JSON with optional word timings and SRT/VTT exports |
| `frameyard doctor` | Inspect core requirements, optional integrations, and manifest integrity |

Common options: `--project <dir>`, `--json`, `--help`, and `--version`. `still` and `render` accept `--overwrite`. Composition renders accept `--concurrency <n>` (1-16); timeline renders accept `--workers <n>` (1-16) and `--scratch <dir>`. For a timeline, `--props` is a JSON object keyed by composition clip id; for a composition, it is the props object. `tts` and `transcribe` accept `--force`. `init` takes the target directory as a positional argument. Explicit output paths passed with `--out` are relative to the current working directory; `render` defaults to `out/<id>.mp4` inside the project root.

A render fails immediately on an uncaught error, unhandled rejection, missing required asset, or invalid composition output. It writes to a temporary file and publishes only after FFmpeg succeeds. Existing outputs are not replaced unless `--overwrite` is supplied.

### JSON results

Non-interactive commands support `--json`. Results go to stdout and human progress/diagnostics go to stderr:

```json
{
  "ok": true,
  "command": "check",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "controller": { "kind": "inline" },
  "metadata": { "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 900 },
  "framesChecked": 900,
  "audio": { "clips": 1 },
  "transcripts": { "clips": 0 },
  "diagnostics": []
}
```

Diagnostics carry `severity`, `code`, `message`, and optional `details` with source locations, element or attribute names, values, and suggestions. Errors use the same envelope and may include `error.details` and top-level `diagnostics`:

```json
{
  "ok": false,
  "command": "check",
  "error": { "code": "BINDING_INVALID", "message": "Unknown Frameyard attribute ..." },
  "diagnostics": [
    {
      "severity": "error",
      "code": "BINDING_INVALID",
      "message": "Unknown Frameyard attribute \"data-fy-txt\".",
      "details": { "path": "compositions/hello.html", "line": 12, "column": 5, "attribute": "data-fy-txt" }
    }
  ]
}
```

`doctor --json` reports findings rather than throwing for environment problems: `ok: true` means inspection completed, while `healthy` reports whether required checks, manifest integrity, explicitly supplied models, and integration compatibility passed. See the [JSON result reference](./skills/frameyard/references/json-results.md) for all command shapes.

## Local asset production

`tts` and `transcribe` wrap optional local executables. Frameyard never builds upstream tools, downloads models, or runs inference during composition loading or frame production.

```sh
# One frozen 24 kHz mono WAV. Text comes from --text-file or stdin.
npx frameyard tts \
  --speaker vivian \
  --talker-model models/qwen-talker-1.7b-customvoice-Q8_0.gguf \
  --codec-model models/qwen-tokenizer-12hz-Q8_0.gguf \
  --language English \
  --text-file script.txt \
  --out assets/voice.wav

# Canonical transcript with measured word timings and derived SRT/VTT.
npx frameyard transcribe assets/voice.wav \
  --model models/ggml-base.en.bin \
  --out assets/voice.transcript.json \
  --words --export srt,vtt
```

- Executable resolution: `--executable`, then `FRAMEYARD_QWEN_TTS` or `FRAMEYARD_WHISPER_CLI`, then `PATH`.
- `tts` supports CustomVoice only: a named speaker is required. Reference-audio cloning and VoiceDesign are deferred.
- `--device CPU` forces qwentts.cpp onto the CPU when a GPU does not have enough VRAM.
- `transcribe` normalizes the source with FFmpeg to 16 kHz mono PCM WAV before `whisper-cli`.
- Outputs are atomic. Existing assets are replaced only with `--force`.
- A partial operation leaves no apparently valid artifact and no manifest entry.
- Transcription never fabricates word timings and never executes Whisper's generated karaoke script.

### Provenance

Successful operations update `frameyard.assets.json` in the project root, or the file passed to `--manifest`. The versioned manifest records artifact SHA-256 hashes and sizes, generator command and executable, Frameyard version, integration revision, model identities, operation parameters, and (for transcription) source identity and derived exports. Commit this manifest with the project.

## Doctor

```sh
npx frameyard doctor
npx frameyard doctor --json
npx frameyard doctor --talker-model models/talker.gguf --codec-model models/codec.gguf
```

`doctor` checks Node, FFmpeg and required encoders, FFprobe, Playwright Chromium, manifest integrity (artifact, source, model, and derived-export hashes), explicitly supplied model readability, and optional `qwen-tts`/`whisper-cli` capabilities. It does not repair, download, or modify anything. Missing optional integrations do not fail, but a found executable with incompatible capabilities does.

## Agent skill

The optional host-neutral agent skill lives in [`skills/frameyard/`](./skills/frameyard). It uses the same project format and CLI as humans, documents HTML authoring, bindings, controllers, static diagnostics, audio assets, subtitle/karaoke recipes, JSON results, and failure recovery, and ships a thin CLI wrapper. The npm package includes the skill files matching its API version. Install it with `npx skills add vladiantio/frameyard`, or see [`skills/frameyard/README.md`](./skills/frameyard/README.md) for host-specific installation or referencing.

## Rendering and reproducibility

Production rendering has two targets.

A composition renders directly:

1. Static composition validation resolves metadata before launching Chromium.
2. Chromium navigates to the composition document with the composition host.
3. One session, or several when `--concurrency` is greater than 1, seeks every frame, calls the controller, seeks CSS/WAAPI animations, and waits for embedded media decode and paint.
4. The viewport is captured through the Chrome DevTools Protocol, piped to FFmpeg, and encoded as H.264/AAC.

A timeline renders through segments:

1. Static timeline validation resolves references, media, nested timelines, durations, props, audio, and overlaps.
2. The timeline is split at active-layer changes and a maximum segment duration.
3. In parallel workers, Chromium captures active composition and nested-timeline clips to alpha-preserving FFV1 intermediates.
4. FFmpeg applies fit, static transforms, opacity, video/image decoding, and audio mixing, and encodes each segment as H.264.
5. Segments are concatenated in timeline order without re-encoding and the global audio mix is muxed into the final MP4.

Composition concurrency changes scheduling only. Timeline workers process independent segments; output order and captured composition frames remain deterministic. `check` and `still` use the same clip capture and composite path as their target.

For the same composition or timeline revision, props, assets, segment plan, frame, and pinned runtime/browser/FFmpeg environment, the captured composition frames and deterministic composite are identical. Encoded bytes are not a reproducibility guarantee, even on the same machine; they depend on the FFmpeg build, encoder threading, and runtime environment. Preview composites in Chromium while timeline production composites with FFmpeg, so small differences in scaling, alpha, and video color conversion are expected; parity is guaranteed at clip capture.

For a repeatable local measurement of seek, capture, encode, and full-render time, run `pnpm bench`. See `bench/README.md` for the measurement recipe. Timeline performance is tracked separately with the long-form benchmarks; the representative target and worst-case measurements are in [ADR 0012](./docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md).

## Current limits

Deferred from this implementation slice:

- Timeline transitions, effects, keyframes, blend modes, masks, and audio fades
- Full visual timeline editing, drag-and-drop, trim handles, and undo/redo
- Timeline-level variables and prop overrides inside nested timelines
- Per-timeline formats and frame-rate conversion/retiming
- Persistent clip caches; timeline scratch intermediates are cleaned after a render
- Hardware encoders, GPU compositing, and non-H.264 final output
- Built-in subtitle rendering, automatic caption burn-in, and declarative karaoke elements
- Nested `data-fy-repeat` scopes and a general template language
- Declarative JSON Schema validation
- Arbitrary executable scripts in composition HTML
- `qwentts.cpp` reference-audio voice cloning and VoiceDesign
- Automatic long-text chunking, streaming synthesis, and alternative generated-audio formats
- Automatic upstream builds, model downloads, environment repair, and hosted rendering
- Batch still capture and general image-sequence output
- React or other UI-framework adapters, plugin APIs, and agent-only runtimes
- TypeScript transpilation for project compositions and npm dependency optimization

See the [design baseline](./docs/v0.1-design.md) for the full product contract, [ADR 0007](./docs/adr/0007-make-html-documents-the-composition-unit.md) for the HTML authoring decision, [ADR 0010](./docs/adr/0010-make-timelines-the-render-unit.md) for timelines, [ADR 0012](./docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md) for segmented rendering, and the [domain glossary](./GLOSSARY.md) for terminology.

## Repository layout

- `src/contracts.ts`: shared composition, props, audio, transcript, and diagnostic contracts
- `src/bindings.ts`: browser-safe binding path and value semantics
- `src/composition/`: browser-safe composition document reader, descriptor, per-kind declarations, and adapter contract
- `src/html/`: Node-side parse5 adapter and static composition validation
- `src/transcript.ts`: canonical transcript validation and SRT/VTT formatting
- `src/runtime/`: browser host, frame clock, deterministic randomness, bindings, media, diagnostics
- `src/preview/`: interactive iframe preview client
- `src/server/`: native ES-module server, host injection, and inline-controller route
- `src/renderer/`: Chromium capture, static validation integration, audio mixing, transcript inspection, FFmpeg encoding
- `src/assets/`: local TTS/transcription wrappers, executable resolution, atomic publishing, provenance
- `src/doctor.ts`: environment, integration, and manifest inspection
- `src/scaffold.ts`: `init` scaffold templates, including the generated package manifest, project README, and agent guide
- `src/cli.ts`: command-line entry point
- `skills/`: official host-neutral agent skill
- `examples/demo/`: the 30-second reference composition
- `examples/webgl/`: the focused WebGL shader example
- `examples/video/`: embedded-video compositions and WebM/MP4 timelines with video clips under a transparent HTML overlay
- `bench/fixtures/`: controlled HTML compositions for the render benchmark
- `scripts/`: benchmark, release checks, versioning, and git-hook installation
- `docs/adr/`: architecture decision records

## Development

From a repository checkout:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm check
node dist/cli.js doctor
```

These commands use the local build; `npx frameyard` runs the published package.

`pnpm check` runs the script syntax checks, lint, formatting checks, typechecks, and the full suite. `pnpm install` installs the repository's git hooks; pre-commit runs `pnpm check:static` and the unit tests, and pre-push runs the full suite. CI runs the same `pnpm check` on Linux with Node 22 and 24.

CI uses fake `qwen-tts` and `whisper-cli` executables. Real-model tests are opt-in:

```sh
FRAMEYARD_REAL_INTEGRATIONS=1 \
FRAMEYARD_REAL_TALKER=/path/to/talker.gguf \
FRAMEYARD_REAL_CODEC=/path/to/codec.gguf \
FRAMEYARD_REAL_WHISPER_MODEL=/path/to/ggml-model.bin \
FRAMEYARD_REAL_WHISPER_SOURCE=/path/to/source.wav \
# optional, for GPUs with too little VRAM:
FRAMEYARD_REAL_TTS_DEVICE=CPU \
pnpm vitest run test/real-integrations.test.ts
```

Releases are tag-driven. See [`RELEASING.md`](./RELEASING.md) for version policy, npm trusted publishing, and the release checklist, and [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

## License

MIT
