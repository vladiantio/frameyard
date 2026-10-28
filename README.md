# Frameyard

Frameyard is a local-first framework for building short, parameterized videos with HTML, CSS, and JavaScript and rendering them deterministically.

The v0.1 design is accepted. This repository implements the core end-to-end slice: composition contracts, the browser runtime and preview, the `init`, `dev`, `check`, `still`, and `render` commands, deterministic Chromium frame capture, and FFmpeg output. Local speech synthesis, transcription, `doctor`, and the official agent skill are not implemented yet.

## Requirements

- Node.js 22.12 or newer
- FFmpeg and FFprobe on `PATH`, built with H.264 (`libx264`) and AAC support
- The Playwright-managed Chromium build

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
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

## Commands

| Command | Purpose |
| --- | --- |
| `frameyard init [directory]` | Scaffold a minimal project |
| `frameyard dev [--port <port>]` | Start the preview server |
| `frameyard check <id> [--props <file>]` | Validate props, assets, audio, and every frame without capture |
| `frameyard still <id> --frame <n>` | Capture one PNG through the production path |
| `frameyard render <id> --out <video.mp4>` | Capture frames with Chromium and encode with FFmpeg |

Common options: `--project <dir>`, `--json`, `--help`, and `--version`. `still` and `render` also accept `--overwrite`, and `init` takes the target directory as a positional argument. Output paths are relative to the current working directory.

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
  "audio": { "clips": 1, "warnings": [] }
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

- `tts`, `transcribe`, `doctor`, provenance manifests, and the official agent skill
- Built-in subtitle rendering, karaoke, and transcript validation
- Parallel rendering, frame caches, and general image-sequence output
- React or other UI-framework adapters, plugin APIs, and hosted rendering
- TypeScript transpilation for project compositions and npm dependency optimization

See the [v0.1 design baseline](./docs/v0.1-design.md) for the full product contract and the [domain glossary](./GLOSSARY.md) for terminology.

## Repository layout

- `src/contracts.ts`: shared composition, props, and audio contracts
- `src/runtime/`: browser lifecycle, frame clock, deterministic randomness
- `src/preview/`: interactive preview client
- `src/server/`: native ES-module server and import map
- `src/renderer/`: Chromium capture, audio mixing, FFmpeg encoding
- `src/cli.ts`: command-line entry point
- `examples/demo/`: the 30-second reference composition
- `docs/adr/`: architecture decision records

## License

MIT
