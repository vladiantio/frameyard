# Subtitles and karaoke

Frameyard does not burn captions into videos and has no built-in subtitle renderer. A composition controller renders timed text. Transcription produces a canonical transcript; SRT and VTT are derived exports.

## Canonical transcript

All timestamps are integer milliseconds relative to the source audio:

```json
{
  "schemaVersion": 1,
  "text": "Hello world.",
  "language": "en",
  "source": {
    "path": "assets/voice.wav",
    "sha256": "64-character hex digest",
    "bytes": 12345
  },
  "segments": [
    { "startMs": 0, "endMs": 1200, "text": "Hello world." }
  ],
  "words": [
    { "startMs": 0, "endMs": 500, "text": "Hello" },
    { "startMs": 520, "endMs": 1100, "text": "world." }
  ]
}
```

- `segments` are always present after a successful transcription.
- `words` is present only when `--words` requested measured timings.
- Never synthesize word timings by interpolating segment timestamps.
- `check` fails with `TRANSCRIPT_WORDS_UNAVAILABLE` when a composition declares `words: true` but the transcript has no word timings.

## Declaring transcript requirements

```html
<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
```

Transcript `src` paths resolve from the project root. `check`, `still`, and `render` validate declared transcript files. Preview loads the declarations but leaves visual presentation to the composition controller.

## Converting source time to frames

Given an `<audio>` element:

```html
<audio src="assets/voice.wav" data-fy-start="30" data-fy-trim="0.25" data-fy-duration="4.2" data-fy-volume="0.8"></audio>
```

the controller can read the attributes or keep matching constants. Convert a word or segment time with:

```js
const FPS = 30;
const frame = clip.startFrame + Math.round((word.startMs / 1000 - clip.trimStart) * FPS);
```

Skip words before the trimmed source range or after `trimStart + trimDuration`. Do not divide by `durationInFrames` or assume a 30 fps composition.

A seek-safe karaoke update in the controller only reads the current frame:

```js
function wordProgress(word, frame) {
  const start = clip.startFrame + (word.startMs / 1000 - clip.trimStart) * FPS;
  const end = clip.startFrame + (word.endMs / 1000 - clip.trimStart) * FPS;
  return Math.max(0, Math.min(1, (frame - start) / Math.max(1, end - start)));
}
```

Apply that value to text styling inside the controller's `update({ frame })`. Do not use timers, `requestAnimationFrame`, or transitions. Declare the transcript with `<fy-transcript src="..." words>` and fetch the canonical JSON in `mount()`.

## Check and inspect

```sh
npx frameyard check karaoke --json
npx frameyard still karaoke --frame 120 --out karaoke-120.png --json
```

Inspect several frames across a word boundary. A single still cannot prove that highlighting is synchronized.

## Derived exports

```sh
npx frameyard transcribe assets/voice.wav --model models/ggml-base.en.bin \
  --out assets/voice.transcript.json --export srt,vtt --json
```

Exports use the JSON output basename: `voice.transcript.srt` and `.vtt`. They are derived files, not the canonical contract. Regenerate them from the transcript rather than editing them by hand.
