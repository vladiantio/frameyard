# Failure recovery

Do not claim success after a nonzero exit. Fix the cause, rerun `check`, and only then render. `check`, `still`, and `render` run static composition validation before Chromium; read the structured `diagnostics` array for source locations.

## Common codes

| Code | Meaning | Action |
| --- | --- | --- |
| `USAGE` | Invalid flags or missing required arguments | Read `npx frameyard <command> --help`. |
| `CONFIG_NOT_FOUND` | No `video.config.js` found | Run from the project root or pass `--project`. |
| `CONFIG_INVALID` | Invalid config or composition entry | Fix `video.config.js`; entries must be explicit, local, `.html`, and exist. |
| `COMPOSITION_NOT_FOUND` | ID is not listed | Add the entry to `video.config.js`. |
| `COMPOSITION_INVALID` | Invalid doctype, root, metadata, or document structure | Fix the composition document; check `details.line` and `details.attribute`. |
| `COMPOSITION_ERROR` | Mount, update, or browser page error | Read the frame location; remove forbidden clocks/randomness or fix the controller. |
| `COMPOSITION_UPDATE_ASYNC` | `update()` returned a promise | Move async work to `mount()`. |
| `COMPOSITION_NOT_READY` | `seek`/`settle` before a successful load | Await `load`/`ready`. |
| `COMPOSITION_DISPOSED` | Operation after host disposal | Reload the composition. |
| `CONTROLLER_INVALID` | Missing, duplicate, or invalid controller declaration/file/exports | Keep exactly one inline or external controller; verify its exports and path. |
| `BINDING_INVALID` | Unknown `data-fy-*` attribute or malformed path | Fix the attribute name or path. |
| `BINDING_PATH_MISSING` | Binding path absent from resolved props | Fix the prop or path; use `details.suggestion`. |
| `BINDING_VALUE_INVALID` | Object/array used where a primitive is required | Use a string/number/boolean or move the logic to a controller. |
| `BINDING_REPEAT_INVALID` | Repeat not on `<template>`, or path missing/not an array | Use `<template data-fy-repeat="items">` with an array. |
| `BINDING_REPEAT_NESTED` | Nested repeat | Use a controller for nested data. |
| `BINDING_TARGET_INVALID` | `data-fy-text` on a void element or the root | Move the binding to a text container. |
| `ANIMATION_INVALID` | Invalid `data-fy-anim-*` value | Use non-negative integer frames and a positive duration. |
| `ANIMATION_NOT_FOUND` | `data-fy-anim-*` without a CSS animation | Add an `animation` shorthand or remove the attributes. |
| `ANIMATION_MULTIPLE` | Multiple animations on one scheduled element | Use one animation or move scheduling to CSS/the controller. |
| `SCRIPT_NOT_ALLOWED` | Executable script other than the controller | Move code into the controller. |
| `EVENT_HANDLER_NOT_ALLOWED` | Inline `on*` handler or `data-fy-attr-on*` | Remove the handler; use a controller. |
| `URL_NOT_ALLOWED` | `javascript:` URL | Use a safe URL. |
| `ELEMENT_NOT_SUPPORTED` | `iframe`, `object`, `embed`, `base`, refresh/CSP meta, `source`, `track`, or declarative shadow DOM | Use supported DOM/SVG/canvas/video sources. |
| `ELEMENT_UNKNOWN` | Unknown `fy-*` element | Use `fy-composition`/`fy-transcript` or a normal element. |
| `CONTENT_OUTSIDE_ROOT` | Visual content outside `<fy-composition>` | Move it inside the root. |
| `PROPS_INVALID` | Invalid props JSON or `validateProps()` failure | Fix the props file or validator. |
| `FRAME_OUT_OF_RANGE` | Frame outside `0..durationInFrames - 1` | Choose a valid frame. |
| `AUDIO_INVALID` | Bad clip or unreadable/unsupported audio | Use a local project-root-relative file with a decodable audio stream. |
| `AUDIO_WARNING` | Audio timeline overrun or silent embedded media | Adjust timing/trim or remove the silent source. |
| `MEDIA_INVALID` | Invalid media source or attributes | Use local, seekable files and valid `data-fy-*` values. |
| `MEDIA_SEEK_FAILED` | Embedded video did not reach the requested time | Re-encode with a regular keyframe interval or replace the source. |
| `TRANSCRIPT_INVALID` | Invalid/missing transcript declaration or JSON | Regenerate with `npx frameyard transcribe`; do not hand-edit timestamps. |
| `TRANSCRIPT_WORDS_UNAVAILABLE` | Karaoke requested without measured word timings | Re-run transcription with `--words` or remove `words`. |
| `TRANSCRIPT_WARNING` | Empty transcript text or no timed segments | Regenerate the transcript. |
| `ASSET_NOT_FOUND` | Required file is missing or unreadable | Restore the asset, model, or text file. |
| `DETERMINISM_WARNING` | Forbidden clock/randomness, CSS transition, or runtime warning | Derive state from `frame`/`props`; use `random("stable:key")`. |
| `OUTPUT_EXISTS` | Output exists and replacement was not approved | Reuse it, choose another path, or pass `--overwrite`/`--force` with permission. |
| `OUTPUT_FAILED` | An output or manifest could not be written atomically | Check directory permissions and free space; rerun. |
| `EXECUTABLE_NOT_FOUND` | `qwen-tts` or `whisper-cli` could not be resolved | Pass `--executable`, set the environment variable, or fix `PATH`. |
| `TTS_FAILED` | Speech synthesis failed or produced an invalid WAV | Read stderr; verify the talker/codec models and CLI compatibility. |
| `TRANSCRIBE_FAILED` | Normalization or `whisper-cli` failed | Verify FFmpeg, the source media, and the Whisper model. |
| `MANIFEST_INVALID` | Provenance manifest is corrupt or unsupported | Restore or regenerate the manifest; do not invent hashes. |
| `FFMPEG_FAILED` | FFmpeg is missing, lacks encoders, or failed | Run `npx frameyard doctor --json`; install FFmpeg with libx264 and AAC. |
| `FFPROBE_FAILED` | FFprobe is missing or failed | Install FFmpeg/FFprobe together. |
| `BROWSER_FAILED` | Chromium could not start | Install the Playwright Chromium build. |
| `RENDER_FAILED` | Capture or encoding failed | Read stderr; rerun `check` and a representative `still`. |
| `CANCELLED` | The operation was interrupted | Rerun when ready. Partial outputs are removed. |
| `INTERNAL` | Unexpected internal failure | Rerun with `FRAMEYARD_DEBUG=1` and report the stack. |

## Behavior to rely on

- A failed render writes to a temporary file and does not publish a partial MP4.
- Failed TTS/transcription operations leave no artifact and no manifest entry.
- Existing outputs are replaced only with `--overwrite` (renders/stills) or `--force` (generated assets).
- Cancellation terminates the child inference process and cleans temporary work.
- `check` validates every frame and declared transcripts without encoding.
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
