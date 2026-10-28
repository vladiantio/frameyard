# Frameyard

Frameyard is a local-first framework for building short, parameterized videos with HTML, CSS, and JavaScript and rendering them deterministically.

The v0.1 design is implemented: composition contracts, browser runtime and preview, `init`, `dev`, `check`, `still`, `render`, `tts`, `transcribe`, `doctor`, deterministic Chromium capture, FFmpeg output, provenance manifests, transcript validation, and the official agent skill.

## Requirements

- Node.js 22.12 or newer
- FFmpeg and FFprobe on `PATH`, built with H.264 (`libx264`) and AAC support
- The Playwright-managed Chromium build
- Optional: `qwen-tts` from [`qwentts.cpp`](https://github.com/ServeurpersoCom/qwentts.cpp) for local speech synthesis
- Optional: `whisper-cli` from [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp) for local transcription

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
```

Run `node dist/cli.js doctor` to inspect the environment without repairing or downloading anything. The wrappers target the CLI surfaces of qwentts.cpp commit `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4` and whisper.cpp commit `284029c07012d2000941a08d38a31ffb71f4734e`.

CI uses fake `qwen-tts` and `whisper-cli` executables. Real-model tests are opt-in:

```sh
FRAMEYARD_REAL_INTEGRATIONS=1 \
FRAMEYARD_REAL_TALKER=/path/to/talker.gguf \
FRAMEYARD_REAL_CODEC=/path/to/codec.gguf \
FRAMEYARD_REAL_WHISPER_MODEL=/path/to/ggml-model.bin \
FRAMEYARD_REAL_WHISPER_SOURCE=/path/to/source.wav \
pnpm vitest run test/real-integrations.test.ts
```

## Quick start

Scaffold a project:

```sh
node dist/cli.js init my-video
cd my-video
node ../dist/cli.js dev
```

`dev` prints a local preview URL. Select a composition, edit its JSON props, scrub frames, and play the composition with its audio timeline.

Validate and render:

```sh
node ../dist/cli.js doctor
node ../dist/cli.js check hello
node ../dist/cli.js render hello --props props/hello.json --out hello.mp4
node ../dist/cli.js still hello --frame 42 --out hello-frame.png
```

The 30-second reference composition lives in [`examples/demo`](./examples/demo):

```sh
node dist/cli.js check demo --project examples/demo
node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json --out demo.mp4
```

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

Preview synchronizes the timeline in the browser. Production mixes the same clips offline with FFmpeg. `check` reports clip durations and warnings when a clip extends beyond the composition. Frameyard never time-stretches audio or changes composition duration to fit it.

## Transcripts

A composition can declare canonical transcript assets that `check`, `still`, and `render` must validate:

```js
transcripts: [
  { src: "assets/voice.transcript.json", words: true },
],
```

Transcript paths are project-relative. `words: true` requires actual measured word timings for karaoke-style presentation; Frameyard fails with `TRANSCRIPT_WORDS_UNAVAILABLE` rather than interpolating them. See [subtitles and karaoke](./skill/references/subtitles-karaoke.md) for the canonical JSON shape and the seek-safe frame conversion recipe.

## Commands

| Command | Purpose |
| --- | --- |
| `frameyard init [directory]` | Scaffold a minimal project |
| `frameyard dev [--port <port>]` | Start the preview server |
| `frameyard check <id> [--props <file>]` | Validate props, assets, audio, transcripts, and every frame without capture |
| `frameyard still <id> --frame <n>` | Capture one PNG through the production path |
| `frameyard render <id> --out <video.mp4>` | Capture frames with Chromium and encode with FFmpeg |
| `frameyard tts ...` | Produce one frozen 24 kHz mono WAV with local qwentts.cpp |
| `frameyard transcribe ...` | Produce canonical transcript JSON with optional word timings and SRT/VTT exports |
| `frameyard doctor` | Inspect core requirements, optional integrations, and manifest integrity |

Common options: `--project <dir>`, `--json`, `--help`, and `--version`. `still` and `render` accept `--overwrite`; `tts` and `transcribe` accept `--force`. `init` takes the target directory as a positional argument. Output paths are relative to the current working directory.

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

`doctor --json` reports findings rather than throwing for environment problems: `ok: true` means inspection completed, while `healthy` reports whether required checks, manifest integrity, explicitly supplied models, and integration compatibility passed. See the [JSON result reference](./skill/references/json-results.md) for all command shapes.

## Local asset production

`tts` and `transcribe` wrap optional local executables. Frameyard never builds upstream tools, downloads models, or runs inference during composition loading or frame production.

```sh
# One frozen 24 kHz mono WAV. Text comes from --text-file or stdin.
node dist/cli.js tts \
  --speaker vivian \
  --talker-model models/qwen-talker-1.7b-customvoice-Q8_0.gguf \
  --codec-model models/qwen-tokenizer-12hz-Q8_0.gguf \
  --language English \
  --text-file script.txt \
  --out assets/voice.wav

# Canonical transcript with measured word timings and derived SRT/VTT.
node dist/cli.js transcribe assets/voice.wav \
  --model models/ggml-base.en.bin \
  --out assets/voice.transcript.json \
  --words --export srt,vtt
```

- Executable resolution: `--executable`, then `FRAMEYARD_QWEN_TTS` or `FRAMEYARD_WHISPER_CLI`, then `PATH`.
- `tts` supports CustomVoice only: a named speaker is required. Reference-audio cloning and VoiceDesign are deferred.
- `transcribe` normalizes the source with FFmpeg to 16 kHz mono PCM WAV before `whisper-cli`.
- Outputs are atomic. Existing assets are replaced only with `--force`.
- A partial operation leaves no apparently valid artifact and no manifest entry.
- Transcription never fabricates word timings and never executes Whisper's generated karaoke script.

### Provenance

Successful operations update `frameyard.assets.json` in the project root, or the file passed to `--manifest`. The versioned manifest records artifact SHA-256 hashes and sizes, generator command and executable, Frameyard version, integration revision, model identities, operation parameters, and (for transcription) source identity and derived exports. Commit this manifest with the project.

## Doctor

```sh
node dist/cli.js doctor
node dist/cli.js doctor --json
node dist/cli.js doctor --talker-model models/talker.gguf --codec-model models/codec.gguf
```

`doctor` checks Node, FFmpeg and required encoders, FFprobe, Playwright Chromium, manifest integrity (artifact, source, model, and derived-export hashes), explicitly supplied model readability, and optional `qwen-tts`/`whisper-cli` capabilities. It does not repair, download, or modify anything. Missing optional integrations do not fail, but a found executable with incompatible capabilities does.

## Agent skill

The optional host-neutral agent skill lives in [`skill/`](./skill). It uses the same project format and CLI as humans, documents deterministic authoring, audio assets, subtitle/karaoke recipes, JSON results, and failure recovery, and ships a thin CLI wrapper. The npm package includes the skill files matching its API version. See [`skill/README.md`](./skill/README.md) for host-specific installation or referencing.

## Rendering and reproducibility

Production rendering:

1. Starts the same preview server and browser runtime used by `dev`.
2. Launches pinned Chromium through Playwright.
3. Seeks explicitly to each frame and waits for composition updates.
4. Captures the viewport through the Chrome DevTools Protocol.
5. Pipes PNG frames and the offline audio mix to FFmpeg.
6. Encodes H.264 video with `yuv420p` and AAC audio into an MP4.

Rendering is sequential in v0.1. For the same composition revision, props, assets, frame, and pinned runtime/browser environment, the visual state is identical. Encoded bytes may differ across operating systems, FFmpeg builds, and font environments.

## Current limits

Deferred from this implementation slice:

- Built-in subtitle rendering, automatic caption burn-in, and karaoke rendering
- `qwentts.cpp` reference-audio voice cloning and VoiceDesign
- Automatic long-text chunking, streaming synthesis, and alternative generated-audio formats
- Automatic upstream builds, model downloads, environment repair, and hosted rendering
- Parallel rendering, frame caches, and general image-sequence output
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
- `src/cli.ts`: command-line entry point
- `skill/`: official host-neutral agent skill
- `examples/demo/`: the 30-second reference composition
- `docs/adr/`: architecture decision records

## License

MIT
