# JSON command results

Every non-interactive command supports `--json`. Stdout contains one JSON document; progress and human diagnostics go to stderr. Failures exit nonzero.

## Success envelope

```json
{
  "ok": true,
  "command": "check"
}
```

Additional fields are command-specific and stable within the 0.1 contract.

## Error envelope

```json
{
  "ok": false,
  "command": "render",
  "error": {
    "code": "OUTPUT_EXISTS",
    "message": "Output already exists: ..."
  }
}
```

Use the error `code` for decisions, not message text. `command` is `null` only for usage failures that occur before a command is known. Exit code `2` means usage; `130` means cancellation; other failures exit `1`.

## check

```json
{
  "ok": true,
  "command": "check",
  "composition": "hello",
  "metadata": { "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 900 },
  "framesChecked": 900,
  "audio": {
    "clips": 1,
    "warnings": [],
    "details": [
      {
        "src": "assets/voice.wav",
        "startFrame": 30,
        "startSeconds": 1,
        "endSeconds": 5.2,
        "sourceDurationSeconds": 4.95,
        "trimStart": 0.25,
        "volume": 0.8
      }
    ]
  },
  "transcripts": {
    "clips": 1,
    "warnings": [],
    "details": [
      { "src": "assets/voice.transcript.json", "language": "en", "segments": 3, "words": 17, "durationMs": 5200, "bytes": 2048 }
    ]
  },
  "elapsedMs": 1200
}
```

## still

```json
{
  "ok": true,
  "command": "still",
  "composition": "hello",
  "frame": 42,
  "path": "/absolute/path/hello-42.png",
  "width": 1920,
  "height": 1080,
  "elapsedMs": 700
}
```

## render

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
  "durationSeconds": 30,
  "framesRendered": 900,
  "concurrency": 1,
  "bytes": 1234567,
  "audio": { "clips": 1, "warnings": [] },
  "transcripts": { "clips": 1, "warnings": [] },
  "elapsedMs": 99000
}
```

A successful render means the final path exists and was published atomically. A nonzero exit means no new partial video was published. `concurrency` is the number of browser sessions actually used; it is capped by `durationInFrames` and by the CLI maximum of 16.

## tts

```json
{
  "ok": true,
  "command": "tts",
  "path": "/absolute/path/assets/voice.wav",
  "bytes": 480000,
  "sha256": "64-character hex digest",
  "sampleRate": 24000,
  "channels": 1,
  "speaker": "vivian",
  "language": "English",
  "manifest": "/absolute/path/frameyard.assets.json",
  "elapsedMs": 12000
}
```

`language` is omitted when it was not supplied.

## transcribe

```json
{
  "ok": true,
  "command": "transcribe",
  "path": "/absolute/path/assets/voice.transcript.json",
  "bytes": 2048,
  "sha256": "64-character hex digest",
  "source": {
    "path": "assets/voice.wav",
    "sha256": "64-character hex digest",
    "bytes": 480000
  },
  "language": "en",
  "segments": 3,
  "words": 17,
  "exports": [
    {
      "format": "srt",
      "path": "/absolute/path/assets/voice.transcript.srt",
      "bytes": 220,
      "sha256": "64-character hex digest"
    }
  ],
  "manifest": "/absolute/path/frameyard.assets.json",
  "elapsedMs": 30000
}
```

`words` is `0` when word timings were not requested. `language` is omitted when it could not be determined.

## doctor

Doctor reports findings rather than throwing for environment problems. `ok: true` means the inspection completed; `healthy` says whether required checks, manifest integrity, explicitly supplied models, and integration compatibility passed.

```json
{
  "ok": true,
  "command": "doctor",
  "healthy": true,
  "checks": [
    { "name": "node", "required": true, "status": "ok", "detail": "v22.12.0" },
    { "name": "ffmpeg", "required": true, "status": "ok", "detail": "ffmpeg version ..." },
    { "name": "ffmpeg-encoders", "required": true, "status": "ok", "detail": "libx264 and aac are available." },
    { "name": "ffprobe", "required": true, "status": "ok", "detail": "ffprobe version ..." },
    { "name": "chromium", "required": true, "status": "ok", "detail": "/path/to/chrome" },
    { "name": "manifest", "required": false, "status": "ok", "detail": "2 artifacts verified." }
  ],
  "integrations": {
    "tts": {
      "name": "qwen-tts",
      "status": "ok",
      "requested": false,
      "executable": "/path/to/qwen-tts",
      "capabilities": ["--model", "--codec", "--speaker", "--lang", "--device", "-o"],
      "version": "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4 (2026-10-28)",
      "referenceRevision": "..."
    },
    "transcribe": {
      "name": "whisper-cli",
      "status": "missing",
      "requested": false,
      "referenceRevision": "..."
    }
  },
  "models": [
    {
      "role": "talker",
      "path": "/absolute/path/models/talker.gguf",
      "status": "ok",
      "bytes": 1234567,
      "sha256": "64-character hex digest"
    }
  ],
  "manifest": { "path": "/absolute/path/frameyard.assets.json", "exists": true, "valid": true, "artifacts": 2 }
}
```

`models` is populated only for model paths passed explicitly with `--talker-model`, `--codec-model`, or `--model`. `healthy: false` exits `1`. Missing optional integrations do not fail, but a found executable with incompatible capabilities does.
