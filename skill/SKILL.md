---
name: frameyard
description: Create, validate, inspect, and render deterministic Frameyard videos authored with HTML, CSS, and native JavaScript. Use when a user asks to build or operate a Frameyard project, produce parameterized video, add a local TTS or transcription asset through Frameyard's wrappers, or diagnose a Frameyard render. Do not use for general-purpose media generation outside a Frameyard project.
frameyard-api-version: 0.1.0
---

# Frameyard

Use Frameyard's public project format and CLI. Do not introduce an agent-only runtime, a hosted service, or direct calls to `qwen-tts` or `whisper-cli`.

## First decisions

1. Find the project: look for `video.config.js` from the working directory upward, or run `frameyard init <directory>` to scaffold one.
2. Read the composition entry points listed in `video.config.js`. There is no directory scanning.
3. Read the existing props file and composition source before changing behavior.
4. If the task needs speech or transcription, confirm that inference is requested or explicitly approved before producing assets.

## Workflow

1. **Author** the composition with HTML, CSS, SVG, Canvas 2D, and native JavaScript ES modules. Keep `width`, `height`, `fps`, and `durationInFrames` fixed. Read [deterministic authoring](references/deterministic-authoring.md).
2. **Provide props** as JSON. Validate domain-specific requirements with `validateProps()`.
3. **Produce optional assets** with `frameyard tts` and `frameyard transcribe`, never with the upstream executables. Read [audio assets](references/audio-assets.md). Do not overwrite or regenerate existing generated assets without permission.
4. **Validate** with `frameyard check <id> --json`. It evaluates every frame, checks audio and declared transcripts, and does not encode.
5. **Inspect** representative frames with `frameyard still <id> --frame <n> --out <file.png> --json`. View the PNGs when the host supports image viewing. If visual inspection is impossible, say so explicitly.
6. **Render** with `frameyard render <id> --out <file.mp4> [--props <file>] --json`.
7. **Report** the project path, composition entry, props, generated assets, provenance manifest, validation results, still paths and inspection status, final video path, and any failures.

Never claim success when `check` fails, a still is missing, a render exits nonzero, or visual inspection was skipped. A partial or unpublished render is not a successful result.

## Command rules

- Use `--json` for every non-interactive command. Parse stdout as the structured result; treat stderr as progress and diagnostics.
- Keep the current output files unless the user explicitly approves replacement. Use `--force` only with that approval.
- Use `--project <dir>` when not running from the project root.
- Use `frameyard doctor --json` before reporting an environment problem. It inspects without repairing or downloading.
- Read [JSON results](references/json-results.md) for result and error shapes, and [failure recovery](references/failure-recovery.md) for actionable error codes.

## Determinism guardrails

- A frame may depend only on its integer `frame`, immutable `props`, and assets loaded before frame production.
- Use `random("stable:key")` from `frameyard/runtime`; never use `Math.random()`.
- Never use `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions as animation inputs.
- Finish remote data, fonts, and image loading during `mount()` or before the first frame. Network requests are blocked during frame capture.
- Keep `update({ frame, props })` synchronous and seek-safe. Do not carry state between frames.
- Do not run model inference inside `mount()`, `update()`, or frame production.

## Subtitle and karaoke rule

Use canonical transcripts produced by `frameyard transcribe`. Convert integer source-relative milliseconds to composition frames with the audio clip's `startFrame`, `trimStart`, and the composition `fps`. Karaoke highlighting requires actual `words` timings; never interpolate segment timings. Read [subtitles and karaoke](references/subtitles-karaoke.md).

## Host script

`scripts/frameyard.mjs` runs the installed package CLI with inherited stdio. It prefers the package-local `dist/cli.js`, then the `frameyard` command on `PATH`. Prefer the `frameyard` command directly; the script is a fallback for hosts that cannot resolve package binaries. When the skill is copied out of the package, set `FRAMEYARD_CLI` to the installed CLI if `frameyard` is not on `PATH`.

```sh
node scripts/frameyard.mjs check <id> --json
```
