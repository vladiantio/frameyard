# JSON command results

Every non-interactive command supports `--json`. Stdout contains one JSON document; progress and human diagnostics go to stderr. Failures exit nonzero.

## Success envelope

```json
{
  "ok": true,
  "command": "check"
}
```

Additional fields are command-specific and stable within the 0.8 contract. `check`, `still`, and `render` report `elapsedMs`, the wall time of the operation from static validation and preflight through the final frame or publication; CLI argument parsing is excluded.

## Error envelope

```json
{
  "ok": false,
  "command": "render",
  "error": {
    "code": "OUTPUT_EXISTS",
    "message": "Output already exists: ...",
    "details": {}
  },
  "diagnostics": []
}
```

`error.details`, `error.fix`, and top-level `diagnostics` are optional. Use the error `code` for decisions, not message text. `command` is `null` only for usage failures that occur before a command is known. Exit code `2` means usage; `130` means cancellation; other failures exit `1`.

## Diagnostics

`check`, `still`, and `render` results contain a `diagnostics` array:

```json
{
  "severity": "warning",
  "code": "BINDING_PATH_MISSING",
  "message": "data-fy-text references prop \"titel\", which is not in the resolved props.",
  "details": {
    "path": "compositions/hello.html",
    "line": 12,
    "column": 5,
    "element": "h1",
    "attribute": "data-fy-text",
    "value": "titel",
    "suggestion": "title"
  },
  "fix": {
    "kind": "path",
    "message": "Replace \"titel\" with \"title\", or add \"titel\" to the defaults.",
    "from": "titel",
    "to": "title",
    "docs": "skills/frameyard/references/bindings.md"
  }
}
```

Static validation diagnostics include source locations. Runtime diagnostics may include a `frame`. Timeline diagnostics add `timeline`, `clip`, `track`, `jsonPath`, and, for keyframe errors, `channel` and the zero-based `keyframe` index; transition diagnostics add `from` and `to`. Audio and transcript warnings use `AUDIO_WARNING` and `TRANSCRIPT_WARNING`; controller clock/randomness and CSS transition warnings use `DETERMINISM_WARNING`. See [diagnostics](diagnostics.md) for the code table.

## lint

`lint` reports `kind: "composition"` or `kind: "timeline"` and the same diagnostic shape. A timeline result includes `framesProjected`, `segments`, `tracks`, `clips`, and `transitions`; a composition result includes `metadata` and reports `framesProjected: 0` because lint does not seek frames. The result also includes the active `policy` details.

```json
{
  "ok": true,
  "command": "lint",
  "policy": { "policy": "authoring", "maxStillFrames": 4, "allowOverwrite": false, "source": "env" },
  "kind": "timeline",
  "timeline": "main",
  "entry": "timelines/main.timeline.json",
  "format": { "width": 1920, "height": 1080, "fps": 30 },
  "durationInFrames": 900,
  "framesProjected": 900,
  "segments": 3,
  "diagnostics": [],
  "elapsedMs": 2
}
```

`lint` does not run `validateProps` or composition runtime. A clean lint is not a successful `check`.

## context

`context` returns a read-only project digest. It includes `root`, `format`, `policy`, `compositions`, `timelines`, `assets`, `fonts`, `next`, and `truncated`. Each composition carries its resolved `metadata`, prop `path`/`type` pairs, optional parsed `propsSchema`, controller, and diagnostic counts; each timeline carries duration, tracks, clip summaries, transitions, audio/transcript counts, and diagnostic counts. Schema defaults are included in the resolved prop list. Each font carries `id`, `family`, `provider`, optional `version`, `variable`, `subsets`, `styles`, `license`, `files`, `bytes`, and `status`. `truncated.fonts` reports a clipped font list.

```json
{
  "ok": true,
  "command": "context",
  "root": "/path/to/project",
  "format": { "width": 1920, "height": 1080, "fps": 30 },
  "policy": { "policy": "authoring", "profile": "shared-cpu", "maxStillFrames": 4, "allowOverwrite": false, "source": "file" },
  "compositions": [
    { "id": "main", "entry": "compositions/main.html", "kind": "animated", "metadata": { "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 900 }, "controller": { "kind": "external", "src": "compositions/main.controller.js" }, "props": [{ "path": "title", "type": "string" }], "propsSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }, "diagnostics": { "errors": 0, "warnings": 0, "codes": [] } }
  ],
  "timelines": [],
  "assets": [],
  "next": ["npx frameyard lint main --json"],
  "truncated": { "clips": false, "assets": false, "props": false }
}
```

## inspect

`inspect` decodes the first frame and reports `width`, `height`, `bytes`, `alpha`, `blank`, `background`, `content`, `colors`, `luminanceGrid`, and `edgeDensity`. `alpha.coverage` is the opaque fraction; `content.bbox` is `null` when no pixels differ from the background. It never launches Chromium.

## compare

`compare` reports `identical`, `differingPixels`, `totalPixels`, `percent`, `maxChannelDelta`, `meanChannelDelta`, `bbox`, and 3×3 `regions`. It exits 1 when the images differ; the JSON body still has `ok: true` and `identical: false`. Different dimensions fail with `IMAGE_INVALID`.

## explain

`explain <code>` returns `code`, `message` (the cause), optional `docs`, and optional `examples` with `failing` and `corrected` snippets. `explain --list` returns `codes` with `code` and `summary`. Unknown codes exit with `USAGE` and point at `frameyard explain --list`.

```json
{
  "ok": true,
  "command": "explain",
  "code": "BINDING_INVALID",
  "message": "A data-fy-* attribute or binding path is invalid.",
  "docs": "skills/frameyard/references/bindings.md",
  "examples": {
    "failing": "<h1 data-fy-txt=\"title\"></h1>",
    "corrected": "<h1 data-fy-text=\"title\"></h1>"
  }
}
```

## add

`add --list` returns `templates` with `name`, `kind`, `description`, and optional `prerequisites`; `recipes` with `id`, `title`, `description`, `tags`, `kind`, `files`, and optional `prerequisites`; and `scaffolds`. `files` entries are path templates where `{id}` is the project id. Adding a template entry returns `kind`, `id`, `template`, `entry`, `path`, `register`, `prerequisites`, and `next`. Adding a recipe returns `kind: "recipe"`, `recipe`, `id`, `path`, `files`, `register`, `prerequisites`, and `next`. `register` is the exact object to merge into `fy.config.js`; `add` does not edit the config itself.

## font

`font search` returns `provider: "fontsource"`, the `query`, applied `filters`, `results`, and `truncated`. Each result has `id`, `family`, `category`, `variable`, `weights`, `styles`, `subsets`, `license`, optional `version`, and `type`.

`font add` (Fontsource id, `--file`, or `--url`) returns `action: "add"`, a `font` summary (`id`, `family`, `provider`, optional `version`, `variable`, `subsets`, `styles`, `license`, `files`, `bytes`, `status`), the `manifest` path, installed `files`, `warnings`, and `next` commands. Fontsource results identify `provider: "fontsource"` and the pinned `version`; URL results identify `provider: "url"`. `font list` returns `manifest` and a `fonts` array of the same summaries. `font verify` returns `manifest`, `fonts`, `files`, `bytes`, `valid`, and `diagnostics`; errors exit 1, warnings exit 0. `font remove` returns `id`, `family`, `manifest`, `files`, and `keptFiles`.

```json
{
  "ok": true,
  "command": "font",
  "action": "verify",
  "manifest": "/project/fy.fonts.json",
  "fonts": 1,
  "files": 1,
  "bytes": 22288,
  "valid": true,
  "diagnostics": []
}
```

A present-but-invalid manifest fails with `FONT_MANIFEST_INVALID`; missing files use `FONT_FILE_MISSING`, changed content uses `FONT_HASH_MISMATCH`, and a failed browser load uses `FONT_LOAD_FAILED`. Remote font CSS is a `FONT_REMOTE` warning. Fontsource network or API failures use `FONT_PROVIDER_UNAVAILABLE`; invalid downloaded WOFF2 content uses `FONT_DOWNLOAD_FAILED`; a missing Fontsource family or `font remove` id uses `FONT_NOT_FOUND`.

## dry run

`tts`, `transcribe`, and `render` accept `--dry-run`. The result has `dryRun: true`, the active `policy`, a command-specific `plan`, a shell-ready `commandLine`, `prerequisites`, `blockers`, and the output path. It does not create the output directory, write the manifest, load a model, launch Chromium, or encode.

```json
{
  "ok": true,
  "command": "render",
  "dryRun": true,
  "deferred": true,
  "policy": { "policy": "authoring", "maxStillFrames": 4, "allowOverwrite": false, "source": "env" },
  "plan": { "kind": "video", "frames": 900, "segments": 3, "workers": 2, "encoder": "auto", "codec": "h264", "container": "mp4", "probed": false },
  "commandLine": "FRAMEYARD_POLICY=full npx frameyard render main --workers 2 --codec h264 --container mp4",
  "prerequisites": ["assets/voice.wav"],
  "blockers": [],
  "diagnostics": [],
  "output": { "path": "out/main.mp4", "exists": false }
}
```

An existing output appears in `blockers` with `OUTPUT_EXISTS`; the dry run still exits 0. The handoff command includes `FRAMEYARD_POLICY=full` when the active tier is not `full`. A dry run is not a render; `deferred: true` means the heavy operation was not executed and the `commandLine` is the handoff.

## check

Animated composition results report `kind: "animated"`. `metadata` reports the resolved format, combining declared values with the project `format`.

```json
{
  "ok": true,
  "command": "check",
  "kind": "animated",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "controller": { "kind": "inline" },
  "metadata": { "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 900 },
  "framesChecked": 900,
  "audio": {
    "clips": 1,
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
    "details": [
      { "src": "assets/voice.transcript.json", "language": "en", "segments": 3, "words": 17, "durationMs": 5200, "bytes": 2048 }
    ]
  },
  "diagnostics": [],
  "elapsedMs": 1200
}
```

`entry` is the project-relative composition fragment path. `controller` is `{ kind: "inline" }`, `{ kind: "external", src }`, or `null`.

A static composition result reports `kind: "static"`, dimensions only, `framesChecked: 1`, and no audio/transcript fields:

```json
{
  "ok": true,
  "command": "check",
  "kind": "static",
  "composition": "still",
  "entry": "compositions/still.html",
  "controller": null,
  "metadata": { "width": 1920, "height": 1080, "static": true },
  "framesChecked": 1,
  "diagnostics": [],
  "elapsedMs": 600
}
```

### Timeline check

A timeline check reports `timeline`, `entry`, `format`, `durationInFrames`, `framesChecked`, `tracks`, `clips`, `transitions`, `audio`, `transcripts`, `diagnostics`, and `elapsedMs`. `framesChecked` equals the timeline duration; `transitions` is the resolved count, and transition diagnostics carry `from`/`to` and `jsonPath` in `details`.

## still

```json
{
  "ok": true,
  "command": "still",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "controller": { "kind": "external", "src": "compositions/hello.controller.js" },
  "frames": [
    { "frame": 0, "path": "/absolute/path/out/stills/still-hello-0.png" },
    { "frame": 42, "path": "/absolute/path/out/stills/still-hello-42.png" }
  ],
  "width": 1920,
  "height": 1080,
  "diagnostics": [],
  "elapsedMs": 1400
}
```

`frames` is always present and follows the expanded `--frame` order. `frame` and `path` are also present only when exactly one frame was captured. `--frame` accepts a number, an inclusive range (`2-12`), or a comma-separated list; at most 32 unique frames are captured per invocation. With multiple frames, `--out` is a directory and the files are named `still-<id>-<frame>.png`. A static composition exposes only frame `0`; other frames fail with `FRAME_OUT_OF_RANGE`.

## render

Animated composition and timeline results report `kind: "video"`:

```json
{
  "ok": true,
  "command": "render",
  "kind": "video",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "controller": { "kind": "inline" },
  "path": "/absolute/path/out/hello.mp4",
  "width": 1920,
  "height": 1080,
  "frameRange": { "start": 0, "end": 899 },
  "fps": 30,
  "durationInFrames": 900,
  "durationSeconds": 30,
  "framesRendered": 900,
  "concurrency": 1,
  "scale": 1,
  "codec": "h264",
  "container": "mp4",
  "encoder": "libx264",
  "bytes": 1234567,
  "audio": { "clips": 1 },
  "transcripts": { "clips": 1 },
  "diagnostics": [],
  "elapsedMs": 99000
}
```

`--frames` sets `frameRange` to the inclusive rendered range and makes `durationInFrames`, `framesRendered`, and `durationSeconds` describe only that range. `--scale` sets `scale` and the actual even-sized `width`/`height`. A video `--frames` list must be contiguous; use `--sequence` for arbitrary lists.

A static composition result reports `kind: "image"` and has no fps, duration, frame count, codec, container, encoder, audio, or transcript fields:

```json
{
  "ok": true,
  "command": "render",
  "kind": "image",
  "composition": "still",
  "entry": "compositions/still.html",
  "controller": null,
  "path": "/absolute/path/out/still.png",
  "width": 1920,
  "height": 1080,
  "bytes": 48210,
  "diagnostics": [],
  "elapsedMs": 700
}
```

A sequence result reports `kind: "sequence"` and the output directory:

```json
{
  "ok": true,
  "command": "render",
  "kind": "sequence",
  "composition": "hello",
  "entry": "compositions/hello.html",
  "frames": [{ "frame": 0, "path": "/absolute/path/out/frames/sequence-hello-0.png" }],
  "width": 1920,
  "height": 1080,
  "path": "/absolute/path/out/frames",
  "sequence": "/absolute/path/out/frames",
  "scale": 1,
  "diagnostics": [],
  "elapsedMs": 900
}
```

`--sequence` requires `--frames` and writes `sequence-<id>-<frame>.png`; it does not encode a video. Sequence output is full-size; `--scale` and video flags are rejected.

A successful render means the final path exists and was published atomically. A nonzero exit means no new partial output was published. Without `--out`, the final path is `out/<composition-id>.<ext>` for video and `out/<composition-id>.png` for a static composition inside the project root. `concurrency` is the number of browser sessions actually used; it is capped by `durationInFrames` and by the CLI maximum of 16, and a static composition rejects it. `container` is `mp4`, `mov`, `mkv`, or `webm`; `codec` is `h264`, `hevc`, or `vp9`; and `encoder` is the resolved encoder (`libx264`, `libx265`, `libvpx-vp9`, `h264_nvenc`, `hevc_nvenc`, `h264_qsv`, or `hevc_qsv`). Timeline results also report the effective `workers` count after the encoder session cap, with an `ENCODER_WARNING` diagnostic when it was reduced.

## tts

```json
{
  "ok": true,
  "command": "tts",
  "engine": "qwen",
  "path": "/absolute/path/assets/voice.wav",
  "bytes": 480000,
  "sha256": "64-character hex digest",
  "sampleRate": 24000,
  "channels": 1,
  "speaker": "vivian",
  "language": "English",
  "manifest": "/absolute/path/fy.assets.json",
  "elapsedMs": 12000
}
```

`engine` is `qwen` or `supertonic`. `language` is omitted when it was not supplied; Supertonic always supplies it. `device` is present only for qwen.

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
  "manifest": "/absolute/path/fy.assets.json",
  "elapsedMs": 30000
}
```

`words` is `0` when word timings were not requested. `language` is omitted when it could not be determined.

## doctor

The doctor result adds `policy` and `resources` fields. `policy.status` is `ok` or `error`; an invalid policy is reported as a finding without preventing the environment checks. `resources` reports platform, architecture, CPU count, load average, and total/free memory. `fonts` reports the project font manifest path, whether it exists, `valid`, installed `fonts`/`files`/`bytes`, and an optional `detail` for the first integrity problem.

Doctor reports findings rather than throwing for environment problems. `ok: true` means the inspection completed; `healthy` says whether required checks, manifest integrity, explicitly supplied models, and integration compatibility passed. `ffmpeg-opus-encoder` and `ffmpeg-video-encoders` are optional: the video check probes each supported encoder with a one-frame encode and lists any that FFmpeg advertises but cannot open (an old driver, for example), and neither check affects `healthy`.

```json
{
  "ok": true,
  "command": "doctor",
  "healthy": true,
  "checks": [
    { "name": "node", "required": true, "status": "ok", "detail": "v22.12.0" },
    { "name": "ffmpeg", "required": true, "status": "ok", "detail": "ffmpeg version ..." },
    { "name": "ffmpeg-encoders", "required": true, "status": "ok", "detail": "libx264 and aac are available." },
    { "name": "ffmpeg-opus-encoder", "required": false, "status": "ok", "detail": "libopus is available for VP9/WebM audio." },
    { "name": "ffmpeg-video-encoders", "required": false, "status": "error", "detail": "Unavailable: h264_nvenc (Driver does not support the required nvenc API version); hevc_nvenc (Driver does not support the required nvenc API version). Available: libx264, libx265, libvpx-vp9, h264_qsv, hevc_qsv." },
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
    },
    "sherpaOnnxTts": {
      "name": "sherpa-onnx-offline-tts",
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
  "manifest": { "path": "/absolute/path/fy.assets.json", "exists": true, "valid": true, "artifacts": 2 }
}
```

`models` is populated only for model paths passed explicitly with `--talker-model`, `--codec-model`, `--model-dir`, or `--model`. A Supertonic `--model-dir` reports one entry with role `supertonic`; `tts` provenance records the seven individual model files. `healthy: false` exits `1`. Missing optional integrations do not fail, but a found executable with incompatible capabilities does.
