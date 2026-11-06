# Audio and generated assets

Audio clips are a declarative `<audio>` timeline. Generated speech and transcripts are frozen local inputs produced before composition loading.

## Audio timeline

```html
<audio
  src="assets/voice.wav"
  data-fy-start="30"
  data-fy-trim="0.25"
  data-fy-duration="4.2"
  data-fy-volume="0.8"
></audio>
```

- `src` resolves from the project root.
- `data-fy-start` is the composition timeline position in frames.
- `data-fy-trim` is seconds trimmed from the source.
- `data-fy-duration` optionally limits how many source seconds are used.
- `data-fy-volume` is `0..1`.
- Frameyard never time-stretches audio or changes composition duration to fit it.
- `check` reports clip durations and overrun diagnostics.

An unmuted `<video>` contributes its audio track to the same mix. Use `muted` or `data-fy-audio="off"` for a visual-only video.

Declare required transcripts with:

```html
<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
```

`words` requires measured word timings. See [subtitles and karaoke](subtitles-karaoke.md).

## Local speech synthesis

Use Frameyard instead of calling the upstream executables directly:

### qwentts.cpp (default)

```sh
npx frameyard tts \
  --speaker vivian \
  --talker-model models/qwen-talker-1.7b-customvoice-Q8_0.gguf \
  --codec-model models/qwen-tokenizer-12hz-Q8_0.gguf \
  --language English \
  --text-file script.txt \
  --out assets/voice.wav \
  --json
```

- `--engine qwen` is the default and may be omitted.
- CustomVoice only: `--speaker` is required.
- Text comes from `--text-file` or stdin.
- `--style` maps to the upstream style instruction.
- `--language` maps to `--lang`.
- `--device CPU` forces qwentts.cpp onto the CPU when the GPU does not have enough VRAM.
- Output is one frozen 24 kHz mono WAV.
- Talker and codec GGUF paths are required.
- `--force` is required to replace an existing asset. Do not pass it without user approval.
- Executable resolution: `--executable`, then `FRAMEYARD_QWEN_TTS`, then `PATH`.
- Frameyard does not build qwentts.cpp, download models, or redistribute weights.

### Supertonic 3

```sh
npx frameyard tts \
  --engine supertonic \
  --speaker 0 \
  --model-dir models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11 \
  --language es \
  --text-file script.txt \
  --out assets/voice-es.wav \
  --json
```

- The engine covers 31 languages and requires one of their codes (`es`, `en`, `fr`, `de`, ...); `--language` is mandatory.
- `--speaker` is the numeric `--sid`, not a name.
- `--model-dir` points at the extracted Supertonic 3 archive with its seven files; do not pass individual files.
- `--style` and `--device` are qwen-only. Put Supertonic expression tags such as `<laugh>`, `<breath>`, and `<sigh>` in the text.
- The engine writes its native WAV; Frameyard normalizes it to 24 kHz mono and records `sourceSampleRate` and `sourceChannels` in the manifest.
- `--force` is required to replace an existing asset. Do not pass it without user approval.
- Executable resolution: `--executable`, then `FRAMEYARD_SHERPA_ONNX_TTS`, then `PATH`.
- Frameyard does not build sherpa-onnx, download the model archive, or redistribute weights. The upstream Supertonic repository is archived and its weights use the OpenRAIL-M license.

## Local transcription

```sh
npx frameyard transcribe assets/voice.wav \
  --model models/ggml-base.en.bin \
  --out assets/voice.transcript.json \
  --words \
  --export srt,vtt \
  --json
```

- The source is normalized with FFmpeg to 16 kHz mono PCM WAV before `whisper-cli` runs.
- The canonical output is Frameyard transcript JSON.
- `--words` requests actual word timings. It fails rather than fabricate them.
- `--export srt,vtt` writes derived subtitle files next to the transcript.
- `--force` is required to replace existing transcript or export files.
- Executable resolution: `--executable`, then `FRAMEYARD_WHISPER_CLI`, then `PATH`.
- Frameyard does not download Whisper models or execute Whisper's generated karaoke shell script.

## Pinned upstream revisions

The wrappers target the CLI surfaces of qwentts.cpp commit `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4`, sherpa-onnx commit `af2d8d81dbfa61c4cea4c568da78f3982edca005` (v2.0.1), and whisper.cpp commit `284029c07012d2000941a08d38a31ffb71f4734e`.

## Provenance manifest

Both commands update `fy.assets.json` in the project root unless `--manifest <file>` is supplied. The manifest records:

- artifact path, content hash, and size;
- generator command, Frameyard version, executable, and integration revision;
- model identities and sizes;
- operation parameters and, for transcription, source identity and derived exports.

Commit the manifest with the project. It explains how generated inputs were produced. Do not edit hashes by hand.

## Regeneration rules

- Do not regenerate or overwrite an existing generated asset without permission.
- Do not silently switch models, speakers, language, or text.
- Report the manifest path and the exact asset paths after success.
- `npx frameyard doctor` verifies manifest integrity, including artifact, source, model, and derived-export hashes, and optional integration executables; it does not download or repair anything. Pass `--talker-model`, `--codec-model`, `--model-dir`, or `--model` to inspect model readability and identity before generation.
- Once assets are frozen, checking and rendering do not need the model or inference executable.
