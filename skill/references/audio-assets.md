# Audio and generated assets

Audio clips are a declarative timeline. Generated speech and transcripts are frozen local inputs produced before composition loading.

## Audio timeline

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

- Placement is in composition frames.
- Trimming is in seconds from the source.
- Frameyard never time-stretches audio or changes composition duration to fit it.
- `check` reports clip durations and overrun warnings.

## Local speech synthesis

Use Frameyard, not `qwen-tts` directly:

```sh
frameyard tts \
  --speaker vivian \
  --talker-model models/qwen-talker-1.7b-customvoice-Q8_0.gguf \
  --codec-model models/qwen-tokenizer-12hz-Q8_0.gguf \
  --language English \
  --text-file script.txt \
  --out assets/voice.wav \
  --json
```

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

## Local transcription

```sh
frameyard transcribe assets/voice.wav \
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

## Provenance manifest

Both commands update `frameyard.assets.json` in the project root unless `--manifest <file>` is supplied. The manifest records:

- artifact path, content hash, and size;
- generator command, Frameyard version, executable, and integration revision;
- model identities and sizes;
- operation parameters and, for transcription, source identity and derived exports.

Commit the manifest with the project. It explains how generated inputs were produced. Do not edit hashes by hand.

## Regeneration rules

- Do not regenerate or overwrite an existing generated asset without permission.
- Do not silently switch models, speakers, language, or text.
- Report the manifest path and the exact asset paths after success.
- `frameyard doctor` verifies manifest integrity, including artifact, source, model, and derived-export hashes, and optional integration executables; it does not download or repair anything. Pass `--talker-model`, `--codec-model`, or `--model` to inspect model readability and identity before generation.
- Once assets are frozen, checking and rendering do not need the model or inference executable.
