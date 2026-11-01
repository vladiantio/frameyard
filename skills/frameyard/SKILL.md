---
name: frameyard
description: Create, validate, inspect, and render deterministic Frameyard videos authored with HTML compositions and JSON timelines. Use when a user asks to build or operate a Frameyard project, produce parameterized video, assemble clips into a timeline, add a local TTS or transcription asset through Frameyard's wrappers, or diagnose a Frameyard render. Do not use for general-purpose media generation outside a Frameyard project.
frameyard-api-version: 0.6.0
---

# Frameyard

Use Frameyard's public project format and CLI. Do not introduce an agent-only runtime, a hosted service, or direct calls to `qwen-tts` or `whisper-cli`.

## First decisions

1. Find the project: look for `video.config.js` from the working directory upward, or run `npx frameyard init <directory>` to scaffold one.
2. Read the `format`, `compositions`, and `timelines` maps in `video.config.js`. Entries are explicit `.html` and `.json` documents; there is no directory scanning.
3. Read the timeline JSON, the referenced composition HTML, its optional controller, and the props files before changing behavior.
4. If the task needs speech or transcription, confirm that inference is requested or explicitly approved before producing assets.

## Workflow

1. **Author compositions** as full HTML documents with one `<fy-composition>` root. Put metadata, default props, markup, CSS animation, bindings, audio, and transcripts in the document. Use an optional controller for Canvas 2D, WebGL, karaoke, or per-frame computation CSS cannot express. Read [deterministic authoring](references/deterministic-authoring.md), [bindings](references/bindings.md), and [controllers](references/controllers.md).
2. **Assemble the timeline** in JSON: project format, video/audio tracks, composition, media, and nested-timeline clips, source ranges, static transforms, and audio. Read [timelines](references/timelines.md).
3. **Provide props** as JSON. Composition props merge over defaults; timeline render props are a map keyed by composition clip ID. Validate domain-specific requirements with a controller's `validateProps()`.
4. **Produce optional assets** with `npx frameyard tts` and `npx frameyard transcribe`, never with the upstream executables. Read [audio assets](references/audio-assets.md). Do not overwrite or regenerate existing generated assets without permission.
5. **Validate** with `npx frameyard check <id> --json`, where `<id>` is a timeline or composition. Static validation runs before Chromium; then every frame is evaluated. Read the structured `diagnostics` array. Read [diagnostics](references/diagnostics.md) and [common mistakes](references/common-mistakes.md).
6. **Inspect** representative frames with `npx frameyard still <id> --frame <n> --out <file.png> --json`. View the PNGs when the host supports image viewing. If visual inspection is impossible, say so explicitly.
7. **Render** with `npx frameyard render <id> [--out <file.mp4>] [--props <file>] --json`. Composition renders accept `--concurrency <n>`; timeline renders accept `--workers <n>` and `--scratch <dir>`. The default output is `out/<id>.mp4` in the project root.
8. **Report** the project path, timeline and composition entries, controller, props, generated assets, provenance manifest, validation results, diagnostics, still paths and inspection status, final video path, and any failures.

Never claim success when `check` fails, a still is missing, a render exits nonzero, or visual inspection was skipped. A partial or unpublished render is not a successful result.

## Command rules

- Use `--json` for every non-interactive command. Parse stdout as the structured result; treat stderr as progress and diagnostics.
- Keep the current output files unless the user explicitly approves replacement. Use `--force` only with that approval.
- Use `--project <dir>` when not running from the project root.
- `render` writes to `out/<id>.mp4` in the project root unless `--out` is passed. Explicit `--out` paths are relative to the current working directory.
- Use `--concurrency <n>` only for composition renders; the default is `1` and the maximum is `16`. Use `--workers <n>` for timeline renders; the default is `8`. Timeline renders also accept `--scratch <dir>` for FFV1 intermediates.
- For a timeline, `--props` is a JSON object keyed by top-level composition clip ID. For a composition, it is the props object.
- Use `npx frameyard doctor --json` before reporting an environment problem. It inspects without repairing or downloading.
- Read [JSON results](references/json-results.md) for result and error shapes, and [failure recovery](references/failure-recovery.md) for actionable error codes.

## Authoring rules

- A composition is a full HTML document with one `<fy-composition width height fps duration-in-frames>` root and a `data-fy="props"` default-props block.
- A timeline is a versioned JSON document with explicit tracks and clips. Sources are composition IDs, nested timeline IDs, or local video/image/audio paths. Timeline frames, sourceIn, and duration are integer frames. No remote URLs.
- Bindings are explicit: `data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `data-fy-repeat` on `<template>`. Primitive top-level props are also `--fy-prop-<name>` CSS variables.
- CSS `@keyframes` and the Web Animations API are seeked from the frame clock. `data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` schedule one animation per element in frames.
- Frame-state variables on `:root`: `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, and `--fy-duration-frames`.
- A composition has exactly one optional controller, inline or external. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required. Use inline for small controllers; extract to an external module for Canvas 2D, WebGL, karaoke, reuse, tests, or a large controller.
- The controller is the only executable code. Other executable scripts and `on*` handlers are rejected.
- Media and transcript `src` values resolve from the project root. The controller `src` and ordinary HTML asset URLs resolve relative to the composition document.
- Embedded video/audio use `data-fy-start` (frames), `data-fy-trim` (seconds), optional `data-fy-duration` (seconds), and `data-fy-volume` (0-1). Transcripts use `<fy-transcript src words>`.

## Determinism guardrails

- A composition frame may depend only on its integer `frame`, immutable `props`, and assets loaded before frame production. A timeline frame derives from its active clips and the same composition rules.
- Use `random("stable:key")` from `frameyard/runtime`; never use `Math.random()`.
- Never use `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions as animation inputs.
- Finish remote data, fonts, and image loading during the loading phase. Network requests are blocked during frame capture.
- Keep `update({ frame, props })` synchronous and seek-safe. Do not carry state between frames.
- Let the runtime seek embedded `<video>` elements. Do not play, pause, or set `currentTime` in `update()`.
- Redraw WebGL canvases from the current frame. Production pins software WebGL; do not depend on GPU-specific results or the previous frame's drawing buffer.
- Do not run model inference inside `mount()`, `update()`, or frame production.

## Diagnostics rule

`check`, `still`, and `render` run static composition validation before Chromium. Errors fail before a browser starts; warnings allow frame evaluation. Every diagnostic has a stable `code`, a `message`, and optional `details` with source locations and suggestions. Treat warnings as actionable. Do not ignore `BINDING_PATH_MISSING`, `ANIMATION_NOT_FOUND`, `ANIMATION_MULTIPLE`, or `DETERMINISM_WARNING`.

## Subtitle and karaoke rule

Use canonical transcripts produced by `npx frameyard transcribe`. Declare them with `<fy-transcript src="assets/voice.transcript.json" words>`. Convert integer source-relative milliseconds to composition frames with the audio clip's start frame, trim start, and the composition `fps`. Karaoke highlighting requires actual `words` timings; never interpolate segment timings. Read [subtitles and karaoke](references/subtitles-karaoke.md).

## CLI invocation

Use `npx frameyard` (or an installed `frameyard` binary) directly. `scripts/frameyard.mjs` is a fallback for hosts that cannot resolve package binaries: it prefers the package-local `dist/cli.js`, then the `frameyard` command on `PATH`. When the skill is copied out of the package, set `FRAMEYARD_CLI` to an installed CLI path if that command is unavailable.

```sh
npx frameyard check <id> --json
node scripts/frameyard.mjs check <id> --json   # fallback
```

When the CLI version differs from `frameyard-api-version`, pin it with `npx frameyard@<version>`.

## References

- [Timelines](references/timelines.md)
- [Deterministic HTML authoring](references/deterministic-authoring.md)
- [Bindings](references/bindings.md)
- [Controllers](references/controllers.md)
- [Diagnostics](references/diagnostics.md)
- [Common mistakes](references/common-mistakes.md)
- [Audio and generated assets](references/audio-assets.md)
- [Subtitles and karaoke](references/subtitles-karaoke.md)
- [JSON results](references/json-results.md)
- [Failure recovery](references/failure-recovery.md)
