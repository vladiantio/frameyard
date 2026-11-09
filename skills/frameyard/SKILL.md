---
name: frameyard
description: Create, validate, inspect, and render deterministic Frameyard videos authored with HTML compositions and JSON timelines. Use when a user asks to build or operate a Frameyard project, produce parameterized video, assemble clips into a timeline, search or install project fonts, add a local TTS or transcription asset through Frameyard's wrappers, or diagnose a Frameyard render. Do not use for general-purpose media generation outside a Frameyard project.
frameyard-api-version: 0.12.0
---

# Frameyard

Use the public project format and CLI. Do not add an agent-only runtime, a hosted service, or direct calls to `qwen-tts`, `sherpa-onnx-offline-tts`, or `whisper-cli`.

## First moves

1. Find `fy.config.js` from the working directory upward, or run `npx frameyard init <directory>`.
2. Run `npx frameyard context --json`; read `format`, `compositions`, `timelines`, `fonts`, the target, its props, and its controller before editing.
3. Confirm that speech or transcription is requested or explicitly approved before producing assets.
4. If context is small, read [quick reference](references/quick-reference.md) first. Router: static/card → quick reference; timelines → [timelines](references/timelines.md); fonts → [fonts](references/fonts.md); captions → [subtitles and karaoke](references/subtitles-karaoke.md); failures → [diagnostics](references/diagnostics.md) and [failure recovery](references/failure-recovery.md); Canvas/WebGL → [controllers](references/controllers.md).

## Workflow

1. **Author** one `<fy-composition>` fragment. Props, the controller, import maps, and styles are top-level siblings; never add a document shell. Omit `duration-in-frames` and `fps` only for a static composition, which renders to PNG and cannot use animation/media/transcripts. Use a controller only for Canvas, WebGL, karaoke, or per-frame math. Read [deterministic authoring](references/deterministic-authoring.md).
2. **Assemble** a version-1 timeline with explicit tracks and clips. Sources are composition IDs, nested timeline IDs, or local media. `start`, `sourceIn`, and `duration` are integer frames; no remote URLs. Read [timelines](references/timelines.md).
3. **Provide props** as JSON. Composition props merge over defaults; timeline overrides are keyed by composition clip ID. Use `validateProps()` for domain rules.
4. **Lint** with `npx frameyard lint <id> --json`. It validates the document/timeline, resolves references, projects every timeline scene/keyframe channel, scans controller determinism, and probes media metadata without Chromium. It is the edit loop, not the full gate.
5. **Check** with `npx frameyard check <id> --json`. Every animated frame is evaluated, or a static composition once. Read `diagnostics` and `kind`; treat warnings as actionable.
6. **Inspect** with `npx frameyard still <id> --frame <spec> --out <path> --json`. A spec is a frame, an inclusive range, or a comma-separated list. The policy allows at most 32 unique frames in `full` (4 in `authoring`, 1 in `light`). One frame uses a `.png` file; multiple frames use a directory. Use `npx frameyard inspect`/`compare` for text facts, and view the PNGs when the host supports it; if not, say so.
7. **Render** with `npx frameyard render <id> [--out <file>] [--props <file>] --json`. Composition renders accept `--concurrency`; timeline renders accept `--workers` and `--scratch`; `--container`, `--codec`, and `--encoder` select delivery. `--frames` limits video to a contiguous range, `--scale` (0.25-1) captures compositions and timeline stages at the scaled format, and `--sequence <dir>` writes PNGs for arbitrary `--frames` lists without encoding. A static composition rejects those video flags. If the policy blocks render, use `--dry-run` and hand off the command; do not claim a render.
8. **Report** the project, entries, controller, props, generated assets, validation, diagnostics, still paths and inspection status, video path, and failures. Never claim success when `check` fails, a still is missing, a render exits nonzero, or inspection was skipped.

## Authoring contract

- A composition is a partial fragment with one top-level `<fy-composition>` and a top-level `data-fy="props"` block. An optional top-level `data-fy="props-schema"` block declares prop types, required keys, enums, and defaults; schema defaults merge under document defaults and user props. Do not use `data-fy-host` or `data-fy="format"`. `width`, `height`, and `fps` inherit the project `format`; declare both dimensions together.
- A static composition has neither `duration-in-frames` nor `fps`; it runs `mount()`/`validateProps()`, not `update()`, and has no frame-state variables. Declaring `fps` without `duration-in-frames` is an error. A static timeline clip needs an explicit `duration` and `sourceIn: 0`.
- Bindings: `data-fy-text`, `data-fy-attr-*`, `data-fy-class-*`, `data-fy-if`, and `<template data-fy-repeat>`. Primitive top-level props are also `--fy-prop-<name>` CSS variables. Bindings apply once, before `mount`.
- CSS/WAAPI animations are seeked from the frame clock. `data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` schedule one animation in frames. Frame state: `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, `--fy-duration-frames`.
- Exactly one optional controller, inline or external, is the only executable code. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required. Other scripts and `on*` handlers are rejected.
- Media and transcript `src` values resolve from the project root; controller `src` and ordinary HTML URLs resolve from the composition URL. Embedded media uses `data-fy-start` (frames), `data-fy-trim` (seconds), optional `data-fy-duration` (seconds), and `data-fy-volume` (0-1). Transcripts use `<fy-transcript src words>`.
- An optional top-level import map may add bare specifiers for controllers; `frameyard` and `frameyard/` are reserved.

## Determinism

- A composition frame depends only on its integer `frame`, immutable `props`, and assets loaded before frame production. A timeline frame derives from its active clips.
- Use `random("stable:key")` from `frameyard/runtime`; never `Math.random()`. Never use `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions as animation inputs.
- Load remote data, fonts, and images before frame production. Network is blocked during capture. Prefer project fonts installed with `npx frameyard font add`; remote font URLs produce `FONT_REMOTE` and are not reproducible. Keep `update({ frame, props })` synchronous and seek-safe; do not carry state between frames.
- Let the runtime seek embedded video; do not play, pause, or set `currentTime` in `update()`. Redraw WebGL from the current frame; production pins software WebGL.
- Do not run model inference inside `mount()`, `update()`, or frame production.

## Resource policy

`fy.policy.json` is read from the working directory upward, independent of `fy.config.js`; `FRAMEYARD_POLICY` overrides it.

- `light`: one still frame; blocks `check`, `tts`, `transcribe`, and `render`.
- `authoring`: four still frames and `check` at low priority; blocks `tts`, `transcribe`, and `render`.
- `full`: everything up to the 32-frame still cap.
- `lint`, `context`, `doctor`, `add`, `inspect`, `compare`, and `--dry-run` are available in every tier. `font search`, `font list`, and `font verify` are available in every tier; `font add` requires `authoring` or `full`; `font remove`, `font add --force`, and `font add --url` without `--license`/`--license-file` require `full`.
- When blocked, run `--dry-run`, report `deferred: true`, and give the user `commandLine`, `prerequisites`, and `blockers`. Never claim a render or asset exists.
- `--profile shared-cpu` caps timeline workers at 2 and composition concurrency at 1 and lowers priority; `--low-priority` lowers priority without caps. Values above a cap fail with `RESOURCE_PROFILE_CONFLICT`; do not clamp silently.
- `light`/`authoring` deny `--force` and `--overwrite`; ask before replacing an output. Do not edit the policy file, host configuration, or skill source. The policy is a guardrail, not a security boundary.

## Command rules

- Use `--json` for non-interactive commands; parse stdout, keep stderr for progress/diagnostics. Use `--project <dir>` outside the project root.
- Outputs default to `out/<id>.<ext>` for video and `out/<id>.png` for static compositions; explicit `--out` is relative to the current directory. Replace outputs only with approval.
- For a timeline, `--props` is a map keyed by top-level composition clip ID; for a composition, it is the props object. Use `--concurrency` for animated compositions, `--workers`/`--scratch` for timelines. `--container <mp4|mov|mkv|webm>`, `--codec <h264|hevc|vp9>`, and `--encoder <auto|software|nvenc|qsv>` select delivery; the output extension must match the container.
- Produce speech and transcripts only with `npx frameyard tts` and `npx frameyard transcribe`, never upstream executables; read [audio assets](references/audio-assets.md). Do not overwrite generated assets without approval.
- Use `npx frameyard add --list --json` and `add composition|timeline <id> --template <name> --json` for templates, or `add recipe <recipe-id> --id <project-id> --json` for a complete composition/timeline/props/README bundle. Merge the returned registration object into `fy.config.js`. `add` never edits the config or overwrites an entry.
- Use `npx frameyard asset add <https-url> --out <path> --json` to pin remote images, video, or audio into the project and `fy.assets.json`; never fetch during render. Use `--sha256` when the source is known and `--force` only with permission.
- Use `npx frameyard font search <query> --json` to find a Fontsource family, then `npx frameyard font add <fontsource-id> --json` to pin and vendor it. Use `font add --file` for a local or brand font, or `font add --url` for an explicit HTTPS source. Reference the returned CSS family. `font list`, `font verify`, and `font remove` manage the manifest; never edit `fy.fonts.json` hashes by hand. Read [fonts](references/fonts.md).
- When a diagnostic includes `fix`, prefer its `command`, `to`, `message`, and `docs`; `npx frameyard explain <code> --json` adds the cause, examples, and docs. `npx frameyard explain --list --json` lists every stable code. Fixes are advisory and never applied automatically.
- Use `npx frameyard doctor --json` before reporting an environment problem. Read [JSON results](references/json-results.md) and [failure recovery](references/failure-recovery.md).

## Diagnostics and karaoke

`check`, `still`, and `render` run static validation before Chromium; errors stop, warnings allow frames. Diagnostics carry a stable `code`, message, and optional source location/suggestion. Treat `BINDING_PATH_MISSING`, `ANIMATION_*`, `STATIC_*`, and `DETERMINISM_WARNING` as actionable.

Use transcripts from `npx frameyard transcribe`. Convert source-relative milliseconds to composition frames with the clip start, trim start, and `fps`. Karaoke requires measured `words`; never interpolate segment timings.

## CLI invocation

Use `npx frameyard` or an installed binary. `scripts/frameyard.mjs` is the fallback; set `FRAMEYARD_CLI` when the command is unavailable. Pin the CLI with `npx frameyard@<version>` when it differs from `frameyard-api-version`.

```sh
npx frameyard check <id> --json
node scripts/frameyard.mjs check <id> --json
```

## References

- [Quick reference](references/quick-reference.md)
- [Fonts](references/fonts.md)
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
