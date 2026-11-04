# Failure recovery

Do not claim success after a nonzero exit. Fix the cause, rerun `check`, and only then render. `check`, `still`, and `render` run static composition validation before Chromium; read the structured `diagnostics` array for source locations.

## Common codes

| Code | Meaning | Action |
| --- | --- | --- |
| `USAGE` | Invalid flags or missing required arguments | Read `npx frameyard <command> --help`. |
| `CONFIG_NOT_FOUND` | No `video.config.js` found | Run from the project root or pass `--project`. |
| `CONFIG_INVALID` | Invalid config or composition entry | Fix `video.config.js`; entries must be explicit, local, `.html`, and exist. |
| `COMPOSITION_NOT_FOUND` | ID is not listed | Add the entry to `video.config.js`. |
| `COMPOSITION_INVALID` | Invalid root, metadata, fragment structure, or reserved attribute | Fix the composition fragment; check `details.line` and `details.attribute`. |
| `COMPOSITION_DOCUMENT_SHELL` | A full document shell is present | Remove `<!doctype>`, `<html>`, `<head>`, and `<body>`; keep the fragment body and top-level metadata. See the 0.8 migration guide. |
| `IMPORT_MAP_INVALID` | Invalid import map placement, JSON, attributes, or reserved specifier | Keep one or more top-level import maps; remove `frameyard`/`frameyard/` keys and forbidden attributes. |
| `COMPOSITION_FORMAT_UNRESOLVED` | The composition omits `width`/`height` and the project has no `format` | Declare `width`/`height` on `<fy-composition>`, add `format { width, height, fps }` to `video.config.js`, or render through a timeline. |
| `COMPOSITION_ERROR` | Mount, update, or browser page error | Read the frame location; remove forbidden clocks/randomness or fix the controller. |
| `COMPOSITION_UPDATE_ASYNC` | `update()` returned a promise | Move async work to `mount()`. |
| `COMPOSITION_NOT_READY` | `seek`/`settle` before a successful load | Await `load`/`ready`. |
| `COMPOSITION_DISPOSED` | Operation after host disposal | Reload the composition. |
| `CONTROLLER_INVALID` | Missing, duplicate, non-top-level, or invalid controller declaration/file/exports | Keep exactly one inline or external top-level controller; verify its exports and path. |
| `BINDING_INVALID` | Unknown `data-fy-*` attribute or malformed path | Fix the attribute name or path. |
| `BINDING_PATH_MISSING` | Binding path absent from resolved props | Fix the prop or path; use `details.suggestion`. |
| `BINDING_VALUE_INVALID` | Object/array used where a primitive is required | Use a string/number/boolean or move the logic to a controller. |
| `BINDING_REPEAT_INVALID` | Repeat not on `<template>`, or path missing/not an array | Use `<template data-fy-repeat="items">` with an array. |
| `BINDING_REPEAT_NESTED` | Nested repeat | Use a controller for nested data. |
| `BINDING_TARGET_INVALID` | `data-fy-text` on a void element or the root | Move the binding to a text container. |
| `ANIMATION_INVALID` | Invalid `data-fy-anim-*` value | Use non-negative integer frames and a positive duration. |
| `ANIMATION_NOT_FOUND` | `data-fy-anim-*` without a CSS animation | Add an `animation` shorthand or remove the attributes. |
| `ANIMATION_MULTIPLE` | Multiple animations on one scheduled element | Use one animation or move scheduling to CSS/the controller. |
| `STATIC_ANIMATION_UNSUPPORTED` | A static composition uses `data-fy-anim-*` | Remove the attributes or declare `duration-in-frames` and `fps` to make the composition animated. |
| `STATIC_MEDIA_UNSUPPORTED` | A static composition declares video, audio, or a transcript | Move media and captions to a timeline, or declare `duration-in-frames` and `fps`. |
| `STATIC_UPDATE_IGNORED` | A static composition exports `update()` | Move initialization into `mount()`; static compositions do not run `update()`. |
| `STATIC_ANIMATION_PAUSED` | A static composition has CSS animations/transitions | Remove them; the capture uses time 0. |
| `SCRIPT_NOT_ALLOWED` | Executable script other than the controller | Move code into the controller. |
| `EVENT_HANDLER_NOT_ALLOWED` | Inline `on*` handler or `data-fy-attr-on*` | Remove the handler; use a controller. |
| `URL_NOT_ALLOWED` | `javascript:` URL | Use a safe URL. |
| `ELEMENT_NOT_SUPPORTED` | `iframe`, `object`, `embed`, `base`, document-level `<title>`/`<meta>`, refresh/CSP meta, `source`, `track`, or declarative shadow DOM | Use supported DOM/SVG/canvas/video sources. |
| `ELEMENT_UNKNOWN` | Unknown `fy-*` element | Use `fy-composition`/`fy-transcript` or a normal element. |
| `CONTENT_OUTSIDE_ROOT` | Visual content outside `<fy-composition>` | Move it inside the root. |
| `PROPS_INVALID` | Invalid/non-top-level props JSON or `validateProps()` failure | Put the props block at the top level of the fragment; fix the props file or validator. |
| `FRAME_OUT_OF_RANGE` | Frame outside `0..durationInFrames - 1` | Choose valid frames; a batch error lists every invalid frame and the valid range. |
| `AUDIO_INVALID` | Bad clip or unreadable/unsupported audio | Use a local project-root-relative file with a decodable audio stream. |
| `AUDIO_WARNING` | Audio timeline overrun or silent embedded media | Adjust timing/trim or remove the silent source. |
| `TIMELINE_TRANSITION_UNKNOWN_CLIP` | A transition names a missing or self clip | Use two distinct resolved clip IDs in this timeline. |
| `TIMELINE_TRANSITION_WRONG_TRACK` | The pair is on different tracks | Keep both clips on one video track. |
| `TIMELINE_TRANSITION_AUDIO_TRACK` | A `dissolve` is on an audio track | Use `"kind": "crossfade"`. |
| `TIMELINE_TRANSITION_VIDEO_TRACK` | A `crossfade` is on a video track | Use `"kind": "dissolve"`. |
| `TIMELINE_TRANSITION_NOT_OVERLAPPING` | The incoming clip starts at or after the outgoing clip ends | Move `to.start` earlier; touching endpoints are not a transition. |
| `TIMELINE_TRANSITION_GEOMETRY` | Reversed order or the incoming clip ends before the outgoing clip | Use `from.start < to.start < from.end < to.end`. |
| `TIMELINE_TRANSITION_DUPLICATE` | Repeated pair or a clip used twice on one side | Declare each pair once; a clip may chain `from → to → from`. |
| `TIMELINE_TRANSITION_KIND` | Unsupported or missing `kind` | Use `"kind": "dissolve"` on a video track or `"kind": "crossfade"` on an audio track. |
| `TIMELINE_TRANSITION_INVALID` | Unknown transition field, invalid id, or unsupported easing | Fix the entry; easing uses the keyframe timing-function vocabulary. |
| `MEDIA_INVALID` | Invalid media source or attributes | Use local, seekable files and valid `data-fy-*` values. |
| `MEDIA_SEEK_FAILED` | Embedded video did not reach the requested time | Re-encode with a regular keyframe interval or replace the source. |
| `TRANSCRIPT_INVALID` | Invalid/missing transcript declaration or JSON | Regenerate with `npx frameyard transcribe`; do not hand-edit timestamps. |
| `TRANSCRIPT_WORDS_UNAVAILABLE` | Karaoke requested without measured word timings | Re-run transcription with `--words` or remove `words`. |
| `TRANSCRIPT_WARNING` | Empty transcript text or no timed segments | Regenerate the transcript. |
| `ASSET_NOT_FOUND` | Required file is missing or unreadable | Restore the asset, model, or text file. |
| `DETERMINISM_WARNING` | Forbidden clock/randomness, CSS transition, or runtime warning | Derive state from `frame`/`props`; use `random("stable:key")`. |
| `OUTPUT_EXISTS` | Output exists and replacement was not approved | Reuse it, choose another path, or pass `--overwrite`/`--force` with permission. |
| `OUTPUT_FAILED` | An output or manifest could not be written atomically | Check directory permissions and free space; rerun. |
| `EXECUTABLE_NOT_FOUND` | `qwen-tts`, `sherpa-onnx-offline-tts`, or `whisper-cli` could not be resolved | Pass `--executable`, set `FRAMEYARD_QWEN_TTS`, `FRAMEYARD_SHERPA_ONNX_TTS`, or `FRAMEYARD_WHISPER_CLI`, or fix `PATH`. |
| `TTS_FAILED` | Speech synthesis failed or produced an invalid WAV | Read stderr; verify the engine-specific models (`--talker-model`/`--codec-model` for qwen, `--model-dir` for Supertonic) and CLI compatibility. |
| `TRANSCRIBE_FAILED` | Normalization or `whisper-cli` failed | Verify FFmpeg, the source media, and the Whisper model. |
| `MANIFEST_INVALID` | Provenance manifest is corrupt or unsupported | Restore or regenerate the manifest; do not invent hashes. |
| `FFMPEG_FAILED` | FFmpeg is missing, lacks encoders, or failed | Run `npx frameyard doctor --json`; install FFmpeg with libx264 and AAC. |
| `FFPROBE_FAILED` | FFprobe is missing or failed | Install FFmpeg/FFprobe together. |
| `BROWSER_FAILED` | Chromium could not start | Install the Playwright Chromium build. |
| `RENDER_FAILED` | Capture or encoding failed | Read stderr; rerun `check` and a representative `still`. |
| `CANCELLED` | The operation was interrupted | Rerun when ready. Partial outputs are removed. |
| `INTERNAL` | Unexpected internal failure | Rerun with `FRAMEYARD_DEBUG=1` and report the stack. |

## Behavior to rely on

- A failed render writes to a temporary file and does not publish a partial output.
- A multi-frame still captures every frame to a temporary file first; a failed capture publishes no stills. `OUTPUT_EXISTS` lists every conflicting output path before capture starts.
- Failed TTS/transcription operations leave no artifact and no manifest entry.
- Existing outputs are replaced only with `--overwrite` (renders/stills) or `--force` (generated assets).
- Cancellation terminates the child inference process and cleans temporary work.
- `check` validates every animated frame, or a static composition's single state, and declared transcripts without encoding.
- Static validation failures exit before Chromium starts.
- `check`, `still`, and `render` seek embedded videos and wait for decode before evaluating or capturing a frame.
- `doctor` inspects but never repairs, downloads, or modifies the environment.

## When visual inspection is impossible

If the host cannot display images, say explicitly that representative stills could not be visually inspected. Report their paths and the fact that inspection was skipped. Do not describe visual correctness you did not observe.

## Reporting a completed result

Report all of:

- source project path, composition entry, and controller;
- props file or inline props used;
- generated audio/transcript paths and provenance manifest path;
- `check` result, including diagnostics and warnings;
- still paths and whether they were viewed;
- final video path, frame count, and audio/transcript summary;
- any skipped step or unresolved diagnostic.

## 0.8 fragment migration

0.8 changed compositions from full documents to partial HTML fragments. If `check` reports `COMPOSITION_DOCUMENT_SHELL`:

1. Remove `<!doctype html>`, `<html>`, `<head>`, `<body>`, `<title>`, and `<meta>`.
2. Keep one top-level `<fy-composition>` root.
3. Move the props block, the controller, and import maps to the top level.
4. Keep top-level `<style>` and `<link rel="stylesheet">` as siblings; Frameyard hoists them into the generated head. Styles inside the root stay in the body.
5. Remove the reserved `data-fy-host` attribute and `data-fy="format"` block.
6. Run `npx frameyard check <id> --json` again.

See `docs/migration-0.8.md` in the Frameyard repository for before/after examples.
