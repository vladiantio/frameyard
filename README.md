# Frameyard

Frameyard is a local-first framework for building short, parameterized videos with HTML, CSS, and JavaScript and rendering them deterministically.

The v0.1 design is implemented: composition contracts, browser runtime and preview, `init`, `dev`, `check`, `still`, `render`, `tts`, `transcribe`, `doctor`, deterministic Chromium capture, embedded video and WebGL, FFmpeg output, provenance manifests, transcript validation, and the official agent skill.

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

`dev` prints a local preview URL. Select a composition, edit its JSON props, scrub frames, and play the composition with its audio timeline.

The scaffold includes an `AGENTS.md` guide for coding agents working in the project, covering the determinism rules and the `check`, `still`, and `render` workflow. It also includes a `package.json` with `dev`, `check`, `render`, and `still` scripts pinned to the scaffolding CLI version, so `pnpm dev` or `npm run dev` works without a global install.

`npx frameyard` resolves the latest published version. Pin it with `npx frameyard@<version>`, or install the package locally, when a project needs a fixed CLI version.

Validate and render:

```sh
npx frameyard doctor
npx frameyard check hello
npx frameyard render hello --props props/hello.json --out hello.mp4
npx frameyard still hello --frame 42 --out hello-frame.png
```

The 30-second reference composition lives in [`examples/demo`](./examples/demo). Its README has the commands for running the demo from a repository checkout.

## Project format

A project is ordinary HTML, CSS, assets, and native JavaScript ES modules. `video.config.js` explicitly lists composition entry points; there is no directory scanning:

```js
export default {
  compositions: {
    hello: "./compositions/hello.js",
  },
};
```

A composition default-exports a definition. `defineComposition` is optional but gives early metadata validation and editor types:

```js
import { defineComposition } from "frameyard";
import { random } from "frameyard/runtime";

let title;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 900,
  defaultProps: { title: "Hello" },
  validateProps(props) {
    return typeof props.title === "string" ? [] : ["title must be a string"];
  },
  audio: [{ src: "assets/hit.wav", startFrame: 15, volume: 0.8 }],

  mount({ container }) {
    container.innerHTML = "<h1 id='title'></h1>";
    title = container.querySelector("#title");
  },

  update({ frame, props }) {
    title.textContent = props.title;
    title.style.transform = `translateX(${random("title:" + frame) * 40}px)`;
  },

  dispose() {
    title = undefined;
  },
});
```

The runtime supplies an import map for `frameyard` and `frameyard/runtime`, so project code needs no bundling step and no `node_modules` import.

### Composition lifecycle

- `mount({ container, props })` creates the visual structure once and may finish asynchronous work.
- `update({ frame, props })` makes that structure represent the frame. It must be synchronous and seek-safe.
- `dispose()` releases resources after the last frame.

The only animation inputs are the integer frame and immutable props. Metadata (`width`, `height`, `fps`, `durationInFrames`) is fixed and validated before mounting. Props are JSON-serializable, deep-frozen, and merged shallowly over `defaultProps`.

Use `random("stable:key")` instead of `Math.random()`. The runtime pauses CSS animations and the Web Animations API inside the composition container and seeks them to the current frame. Independent `requestAnimationFrame` loops, timers, transitions, and wall-clock reads are not deterministic animation drivers.

## Embedded video and WebGL

Embedded videos are frame-seeked by the runtime. Place a `<video>` element in `mount()` and describe its place on the composition timeline with data attributes:

```html
<video
  src="assets/clip.webm"
  data-frameyard-start="30"
  data-frameyard-trim="0.5"
  data-frameyard-duration="4"
  data-frameyard-volume="0.8"
></video>
```

| Attribute | Meaning | Default |
| --- | --- | --- |
| `data-frameyard-start` | Composition frame where the source starts | `0` |
| `data-frameyard-trim` | Seconds trimmed from the source start | `0` |
| `data-frameyard-duration` | Optional seconds of source to use | rest of source |
| `data-frameyard-volume` | Embedded audio volume from `0` to `1` | `1` |

The runtime pauses every video and seeks it to the frame-derived source time. Do not call `play()`, `pause()`, or set `currentTime` in `update()`. Create video elements and set these attributes in `mount()`: a video added or changed during `update()` cannot be prepared without network access and is rejected. Videos must be in the composition container's light DOM; shadow roots are not scanned. Video sources are project-relative local files; live streams, remote URLs, and sources that cannot be seeked are not supported. The runtime loads the complete file during the loading phase, so frame production performs no media network requests.

An unmuted `<video>` also contributes its soundtrack to the same timeline as declarative `audio` clips. Frameyard extracts that track with FFmpeg for production and mirrors it in preview, while keeping the video element itself silent. Set `muted` or `data-frameyard-audio="off"` to use a video as a visual-only asset. The attributes above also control where its audio enters the mix.

WebGL 1 and WebGL 2 canvases are captured through the normal frame path. Draw the complete frame from `update()` and do not depend on the previous frame's drawing buffer; clear or redraw the scene each time. Production sessions pin software WebGL (SwiftShader) so rendered pixels do not vary with the host GPU.

## Audio timeline

Audio clips are declarative:

```js
audio: [
  {
    src: "assets/voice.wav", // project-relative local file
    startFrame: 30,          // composition timeline position
    trimStart: 0.25,         // seconds trimmed from the source
    trimDuration: 4.2,       // optional seconds to use
    volume: 0.8,             // 0..1
  },
];
```

Preview synchronizes the timeline in the browser. Production mixes the same clips offline with FFmpeg. Unmuted embedded videos contribute their audio tracks to this mix unless they opt out. `check` reports clip durations and warnings when a clip extends beyond the composition. Frameyard never time-stretches audio or changes composition duration to fit it.

## Transcripts

A composition can declare canonical transcript assets that `check`, `still`, and `render` must validate:

```js
transcripts: [
  { src: "assets/voice.transcript.json", words: true },
],
```

Transcript paths are project-relative. `words: true` requires actual measured word timings for karaoke-style presentation; Frameyard fails with `TRANSCRIPT_WORDS_UNAVAILABLE` rather than interpolating them. See [subtitles and karaoke](./skills/frameyard/references/subtitles-karaoke.md) for the canonical JSON shape and the seek-safe frame conversion recipe.

## Commands

| Command | Purpose |
| --- | --- |
| `frameyard init [directory]` | Scaffold a minimal project, including an `AGENTS.md` agent guide and pinned `package.json` scripts |
| `frameyard dev [--port <port>]` | Start the preview server |
| `frameyard check <id> [--props <file>]` | Validate props, assets, audio, transcripts, and every frame without capture |
| `frameyard still <id> --frame <n>` | Capture one PNG through the production path |
| `frameyard render <id> --out <video.mp4>` | Capture frames with Chromium and encode with FFmpeg, optionally in parallel |
| `frameyard tts ...` | Produce one frozen 24 kHz mono WAV with local qwentts.cpp |
| `frameyard transcribe ...` | Produce canonical transcript JSON with optional word timings and SRT/VTT exports |
| `frameyard doctor` | Inspect core requirements, optional integrations, and manifest integrity |

Common options: `--project <dir>`, `--json`, `--help`, and `--version`. `still` and `render` accept `--overwrite`; `render` also accepts `--concurrency <n>` (1-16); `tts` and `transcribe` accept `--force`. `init` takes the target directory as a positional argument. Output paths are relative to the current working directory.

A render fails immediately on an uncaught error, unhandled rejection, missing required asset, or invalid composition output. It writes to a temporary file and publishes only after FFmpeg succeeds. Existing outputs are not replaced unless `--overwrite` is supplied.

### JSON results

Non-interactive commands support `--json`. Results go to stdout and human progress/diagnostics go to stderr:

```json
{
  "ok": true,
  "command": "render",
  "composition": "hello",
  "path": "/absolute/path/hello.mp4",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "durationInFrames": 900,
  "framesRendered": 900,
  "concurrency": 1,
  "audio": { "clips": 1, "warnings": [] },
  "transcripts": { "clips": 1, "warnings": [] }
}
```

Errors use the same envelope:

```json
{
  "ok": false,
  "command": "render",
  "error": { "code": "OUTPUT_EXISTS", "message": "Output already exists: ..." }
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

The optional host-neutral agent skill lives in [`skills/frameyard/`](./skills/frameyard). It uses the same project format and CLI as humans, documents deterministic authoring, audio assets, subtitle/karaoke recipes, JSON results, and failure recovery, and ships a thin CLI wrapper. The npm package includes the skill files matching its API version. Install it with `npx skills add vladiantio/frameyard`, or see [`skills/frameyard/README.md`](./skills/frameyard/README.md) for host-specific installation or referencing.

## Rendering and reproducibility

Production rendering:

1. Starts the same preview server and browser runtime used by `dev`.
2. Launches one pinned Chromium session, or several independent sessions when `--concurrency` is greater than 1.
3. Seeks explicitly to each frame and waits for composition updates.
4. Captures the viewport through the Chrome DevTools Protocol.
5. Pipes PNG frames in timeline order and the offline audio mix to FFmpeg.
6. Encodes H.264 video with `yuv420p` and AAC audio into an MP4.

Rendering is sequential by default. Pass `--concurrency <n>` (1-16) to seek and capture frames with up to `n` independent browser sessions; the effective value is capped by the composition's frame count. Captured frames are always encoded in timeline order, so parallel and sequential renders of the same inputs produce equivalent visual frames. Concurrency only changes scheduling: it does not change composition behavior or the determinism contract. Parallel rendering uses more CPU and memory, so choose a value appropriate for the machine.

For the same composition revision, props, assets, frame, and pinned runtime/browser environment, the visual state is identical. Encoded bytes are not a reproducibility guarantee, even on the same machine; they depend on the FFmpeg build, encoder threading, and runtime environment.

For a repeatable local measurement of seek, capture, encode, and full-render time, run `pnpm bench`. The demo and the controlled fixtures under `bench/fixtures/` are the reference workloads.

## Current limits

Deferred from this implementation slice:

- Built-in subtitle rendering, automatic caption burn-in, and karaoke rendering
- `qwentts.cpp` reference-audio voice cloning and VoiceDesign
- Automatic long-text chunking, streaming synthesis, and alternative generated-audio formats
- Automatic upstream builds, model downloads, environment repair, and hosted rendering
- Frame caches and general image-sequence output
- React or other UI-framework adapters, plugin APIs, and agent-only runtimes
- TypeScript transpilation for project compositions and npm dependency optimization

See the [v0.1 design baseline](./docs/v0.1-design.md) for the full product contract and the [domain glossary](./GLOSSARY.md) for terminology.

## Repository layout

- `src/contracts.ts`: shared composition, props, audio, and transcript requirement contracts
- `src/transcript.ts`: canonical transcript validation and SRT/VTT formatting
- `src/runtime/`: browser lifecycle, frame clock, deterministic randomness
- `src/preview/`: interactive preview client
- `src/server/`: native ES-module server and import map
- `src/renderer/`: Chromium capture, audio mixing, transcript inspection, FFmpeg encoding
- `src/assets/`: local TTS/transcription wrappers, executable resolution, atomic publishing, provenance
- `src/doctor.ts`: environment, integration, and manifest inspection
- `src/scaffold.ts`: `init` scaffold templates, including the generated package manifest, project README, and agent guide
- `src/cli.ts`: command-line entry point
- `skills/`: official host-neutral agent skill
- `examples/demo/`: the 30-second reference composition
- `bench/fixtures/`: controlled compositions for the render benchmark
- `scripts/`: benchmark, versioning, and git-hook installation
- `docs/adr/`: architecture decision records

## Development

From a repository checkout:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm lint
pnpm format:check
node dist/cli.js doctor
```

These commands use the local build; `npx frameyard` runs the published package.

`pnpm install` installs the repository's git hooks. Pre-commit runs lint, formatting checks, typecheck, test typecheck, and unit tests; pre-push runs the full suite. CI runs the same checks on Linux with Node 22 and 24.

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
