# AGENTS.md

This project produces deterministic, parameterized video with Frameyard. This file is the local summary; the official skill has the full contract.

## Project layout

- `video.config.js` explicitly maps project IDs to sources. There is no directory scanning. It declares the project `format`, `compositions`, and `timelines`.
- `compositions/` contains HTML fragments; an optional controller lives beside the fragment as a `.controller.js` module.
- `timelines/` contains JSON timeline documents that assemble clips into one video.
- `props/hello.json` contains composition props; `props/main.json` contains timeline overrides keyed by composition clip ID.
- `out/` contains rendered files and is gitignored. `assets/` contains local media and generated assets.
- `package.json` pins the CLI in `dev`, `check`, `render`, and `still` scripts.

An animated composition declares `duration-in-frames`. A composition with neither `duration-in-frames` nor `fps` is static: it is captured once, renders to PNG, and cannot use animation, media, or transcripts. `width`, `height`, and `fps` inherit the project `format`; declare `width` and `height` together or not at all.

## Composition skeleton

A composition is a partial HTML fragment, not a full document. Keep one top-level `<fy-composition>`; props, the controller, import maps, and styles are top-level siblings. Do not add `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`.

```html
<script type="application/json" data-fy="props">{ "title": "Hello" }</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
</style>
<fy-composition width="1280" height="720" fps="30" duration-in-frames="150">
  <h1 data-fy-text="title"></h1>
</fy-composition>
```

## Timeline skeleton

`timelines/main.timeline.json` assembles clips in the project format:

```json
{
  "version": 1,
  "tracks": [{ "id": "v1", "kind": "video" }],
  "clips": [
    {
      "id": "hello",
      "track": "v1",
      "source": { "kind": "composition", "id": "hello" },
      "start": 0
    }
  ]
}
```

- `source.kind` is `composition`, `timeline`, `video`, `image`, or `audio`. `start`, `sourceIn`, and `duration` are timeline frames. Image clips require a duration.
- A static composition clip needs an explicit `duration` and `sourceIn: 0`. It contributes no audio.
- Tracks composite bottom-to-top. Same-track overlap requires a timeline `transitions` entry; see the skill for transforms, keyframes, blends, and transitions.

## Bindings and animation

- Bindings: `data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `<template data-fy-repeat>`. Primitive top-level props are also `--fy-prop-<name>` CSS variables.
- Bindings apply once, before `mount`; controller-created DOM is not re-bound.
- CSS/WAAPI animations are seeked from the frame clock. `data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` schedule one animation in frames.
- Frame state on `:root`: `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, `--fy-duration-frames`.

## Controller

Exactly one optional controller is allowed, inline or external, as a top-level sibling. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required. `mount` may be async; `update` is synchronous and seek-safe. The controller is the only executable code; other scripts and `on*` handlers are rejected. Extract large or reusable controllers to an external module.

```html
<script type="text/fy-controller">
export default {
  mount({ root, props }) {},
  update({ frame, props }) {},
};
</script>
```

## Determinism

- A frame depends only on its integer `frame`, immutable `props`, and assets loaded before frame production.
- Use `random("stable:key")` from `frameyard/runtime`; never `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions.
- Load remote data, fonts, and images before frames. Network is blocked during capture; do not `fetch()` from `update()`.
- Vendor fonts with `npx frameyard font add --file`; do not rely on a remote Google Fonts link for a deterministic render. The server injects `@font-face` rules and the host waits for `document.fonts.ready`.
- Let the runtime seek embedded video; do not play, pause, or set `currentTime`. Redraw Canvas/WebGL from the current frame.
- Do not run model inference inside `mount()`, `update()`, or frame production.

## Fonts

- `frameyard.fonts.json` records installed families, licenses, and SHA-256 values; commit it with `assets/fonts/`.
- Search Fontsource with `npx frameyard font search "<query>" --json`, then install a family with `npx frameyard font add <fontsource-id> --json`. Variable `wght` is the default; add `--static --weight 400,700` for static files.
- Use `npx frameyard font add --file <path> --family "<name>" --license <id> --license-file <path>` for a local or brand font. Use `--url` for an explicit HTTPS source with `--sha256`.
- Run `npx frameyard font list --json` and `npx frameyard font verify --json` after moving files. Do not edit manifest hashes by hand.
- `font add` requires `authoring` or `full`; `font remove`, `font add --force`, and an unlicensed `--url` import require `full`.

## Media and transcripts

- Composition audio uses `<audio>` with `data-fy-start` (frames), `data-fy-trim` (seconds), optional `data-fy-duration` (seconds), and `data-fy-volume` (0-1). Timeline audio uses frames and audio tracks.
- Media and transcript `src` values resolve from the project root; controller `src` and ordinary HTML URLs resolve from the composition URL.
- Declare transcripts with `<fy-transcript src="assets/voice.transcript.json" words>`. `words` requires measured word timings; never interpolate segment timings.
- Use Frameyard's `tts`/`transcribe` wrappers; never call `qwen-tts`, `sherpa-onnx-offline-tts`, or `whisper-cli` directly. Do not overwrite generated assets without approval. Commit `frameyard.assets.json` when present; do not edit hashes.

## Resource policy

A workspace can commit `frameyard.policy.json` to gate expensive operations. The nearest file from the working directory upward applies, independent of `video.config.js`; `FRAMEYARD_POLICY` overrides it. `light` allows one still frame and blocks `check`, `tts`, `transcribe`, and `render`; `authoring` allows four still frames and `check` at low priority and blocks the three heavy operations; `full` allows everything up to the 32-frame still cap. `--profile shared-cpu` caps timeline workers at 2 and composition concurrency at 1. `tts`, `transcribe`, and `render` accept `--dry-run`; use it and report the handoff when blocked. The policy is a guardrail, not a security boundary.

## Agent workflow

1. Read `video.config.js`, the timeline, the composition, its controller, and the props. Run `npx frameyard context --json` first.
2. Author with native HTML, CSS, SVG, Canvas, WebGL, and an optional controller. Use `npx frameyard add --list --json` for templates and merge the returned registration object into `video.config.js`.
3. Lint the edit loop with `npx frameyard lint main --json`. It does not run `validateProps` or composition runtime.
4. Run `npx frameyard check main --json` for the full gate when the policy allows it; read diagnostics and warnings.
5. Inspect with `npx frameyard still main --frame <spec> --out <dir|file.png> --json`. The policy captures at most 32 unique frames in `full` (4 in `authoring`, 1 in `light`). Use `npx frameyard inspect`/`compare` for text facts; view the PNGs when possible.
6. Render with `npx frameyard render main --props props/main.json [--workers <n>] [--scratch <dir>] --json`. If the policy blocks it, use `--dry-run` and report the handoff.
7. Report sources, props, diagnostics, still paths, inspection status, output path, and failures. Never claim success when `check` fails, a still is missing, or a render exits nonzero.

## Commands

```sh
npx frameyard dev
npx frameyard context --json
npx frameyard doctor --json
npx frameyard add --list --json
npx frameyard lint main --json
npx frameyard check main --json
npx frameyard still main --frame 42 --out main-42.png --json
npx frameyard inspect main-42.png --json
npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch --json
```

- Use `--json` for non-interactive commands. Parse stdout; keep stderr for progress and diagnostics.
- Use `--project <dir>` outside the project root. Outputs default to `out/<id>.mp4` or `out/<id>.png`.
- `--concurrency` is for animated compositions; `--workers`/`--scratch` are for timelines. `--container <mp4|mov|mkv|webm>`, `--codec <h264|hevc|vp9>`, and `--encoder <auto|software|nvenc|qsv>` select delivery; the extension must match.
- `--dry-run` validates and prints a handoff plan. `--profile shared-cpu` caps workers/concurrency and lowers priority.
- `still`/`render` replace outputs only with `--overwrite`; generated assets only with `--force`, and only with approval. The resource policy denies both outside `full`.

The official `frameyard` agent skill has the full contract. Install it with `npx skills add vladiantio/frameyard`. This project was scaffolded with frameyard {{VERSION}}; `npx frameyard` resolves the latest version, so run `npx frameyard@{{VERSION}}` when you need the scaffolding version.
