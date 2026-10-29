# Failure recovery

Do not claim success after a nonzero exit. Fix the cause, rerun `check`, and only then render.

## Common codes

| Code | Meaning | Action |
| --- | --- | --- |
| `USAGE` | Invalid flags or missing required arguments | Read `npx frameyard <command> --help`. |
| `CONFIG_NOT_FOUND` | No `video.config.js` found | Run from the project root or pass `--project`. |
| `CONFIG_INVALID` | Invalid config or composition entry | Fix `video.config.js`; entries must be explicit, local, and exist. |
| `COMPOSITION_NOT_FOUND` | ID is not listed | Add the entry to `video.config.js`. |
| `COMPOSITION_INVALID` | Invalid metadata or lifecycle shape | Fix metadata and ensure `update()` is synchronous. |
| `COMPOSITION_ERROR` | Mount, update, or browser page error | Read the frame location in the message; remove forbidden clocks/randomness. |
| `COMPOSITION_UPDATE_ASYNC` | `update()` returned a promise | Move async work to `mount()`. |
| `PROPS_INVALID` | Props are not JSON or fail `validateProps()` | Fix the props file or validator. |
| `FRAME_OUT_OF_RANGE` | Frame is outside `0..durationInFrames - 1` | Choose a valid frame. |
| `AUDIO_INVALID` | Bad clip or unreadable/unsupported audio | Use a local project-relative file with a decodable audio stream. |
| `ASSET_NOT_FOUND` | Required file is missing or unreadable | Restore the asset, model, or text file. |
| `OUTPUT_EXISTS` | Output exists and replacement was not approved | Reuse it, choose another path, or pass `--overwrite`/`--force` with permission. |
| `OUTPUT_FAILED` | An output or manifest could not be written atomically | Check directory permissions and free space; rerun. |
| `EXECUTABLE_NOT_FOUND` | `qwen-tts` or `whisper-cli` could not be resolved | Pass `--executable`, set the environment variable, or fix `PATH`. |
| `TTS_FAILED` | Speech synthesis failed or produced an invalid WAV | Read stderr; verify the talker/codec models and CLI compatibility. |
| `TRANSCRIBE_FAILED` | Normalization or `whisper-cli` failed | Verify FFmpeg, the source media, and the Whisper model. |
| `TRANSCRIPT_INVALID` | Canonical transcript JSON is malformed | Regenerate it with `npx frameyard transcribe`; do not hand-edit timestamps. |
| `TRANSCRIPT_WORDS_UNAVAILABLE` | Karaoke requested without measured word timings | Re-run transcription with `--words` or remove `words: true`. |
| `MANIFEST_INVALID` | Provenance manifest is corrupt or unsupported | Restore or regenerate the manifest; do not invent hashes. |
| `FFMPEG_FAILED` | FFmpeg is missing, lacks encoders, or failed | Run `npx frameyard doctor --json`; install FFmpeg with libx264 and AAC. |
| `FFPROBE_FAILED` | FFprobe is missing or failed | Install FFmpeg/FFprobe together. |
| `BROWSER_FAILED` | Chromium could not start | Install the Playwright Chromium build. |
| `RENDER_FAILED` | Capture or encoding failed | Read stderr; rerun `check` and a representative `still`. |
| `CANCELLED` | The operation was interrupted | Rerun when ready. Partial outputs are removed. |

## Behavior to rely on

- A failed render writes to a temporary file and does not publish a partial MP4.
- Failed TTS/transcription operations leave no artifact and no manifest entry.
- Existing outputs are replaced only with `--overwrite` (renders/stills) or `--force` (generated assets).
- Cancellation terminates the child inference process and cleans temporary work.
- `check` validates every frame and declared transcripts without encoding.
- `doctor` inspects but never repairs, downloads, or modifies the environment.

## When visual inspection is impossible

If the host cannot display images, say explicitly that representative stills could not be visually inspected. Report their paths and the fact that inspection was skipped. Do not describe visual correctness you did not observe.

## Reporting a completed result

Report all of:

- source project path and composition entry;
- props file or inline props used;
- generated audio/transcript paths and provenance manifest path;
- `check` result, including warnings;
- still paths and whether they were viewed;
- final video path, frame count, and audio/transcript summary;
- any skipped step or unresolved warning.
