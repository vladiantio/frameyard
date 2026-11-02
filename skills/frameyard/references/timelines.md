# Timelines

A timeline is a project-local JSON document that assembles composition and media clips on tracks and renders as one video. Compositions remain reusable HTML sources; a composition clip is one placement of a composition with its own source range and props.

## Project configuration

```js
export default {
  format: { width: 1920, height: 1080, fps: 30 },
  compositions: {
    intro: "./compositions/intro.html",
  },
  timelines: {
    main: "./timelines/main.timeline.json",
  },
};
```

- `format` fixes width, height, and fps for every timeline. It is required when the project lists timelines.
- Composition and timeline IDs share one namespace and must be unique.
- A composition used in a timeline must match the project fps exactly. A different size is fitted by the clip.
- Composition-only projects remain valid without `format` or `timelines`.

## Timeline document

```json
{
  "version": 1,
  "name": "Main edit",
  "tracks": [
    { "id": "v1", "kind": "video" },
    { "id": "v2", "kind": "video" },
    { "id": "a1", "kind": "audio", "gain": 1, "muted": false }
  ],
  "clips": [
    {
      "id": "intro",
      "track": "v1",
      "source": { "kind": "composition", "id": "intro" },
      "start": 0,
      "duration": 150,
      "sourceIn": 0,
      "props": { "title": "Hello" },
      "transform": { "fit": "contain", "x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1 },
      "audio": { "muted": false, "gain": 1 }
    },
    {
      "id": "logo",
      "track": "v2",
      "source": { "kind": "image", "src": "assets/logo.png" },
      "start": 30,
      "duration": 60,
      "transform": { "fit": "contain", "width": 480, "height": 270, "x": 640, "y": -320, "rotation": 0, "opacity": 0.9 }
    },
    {
      "id": "music",
      "track": "a1",
      "source": { "kind": "audio", "src": "assets/music.wav" },
      "start": 0,
      "duration": 210,
      "audio": { "gain": 0.5 }
    }
  ]
}
```

- `version` is `1`.
- `tracks` and `clips` are required. Track order is bottom-to-top for video and irrelevant for audio.
- `background` is an optional color; the final video composites over black.
- `durationInFrames` is optional. The duration is derived from the latest clip end unless declared; a declared duration may extend but not cut clips.
- Unknown fields are errors. No transitions, effects, keyframes, or track solo/visibility in 0.6.

## Sources

| `source.kind` | Fields | Notes |
| --- | --- | --- |
| `composition` | `id` | Project composition ID. The clip may set `props`. |
| `timeline` | `id` | Nested timeline ID. Rendered as a group. |
| `video` | `src` | Local MP4/WebM, project-relative. |
| `image` | `src` | Local PNG/JPEG/WebP. `duration` is required. |
| `audio` | `src` | Local WAV/MP3/M4A/AAC or a video file used only for audio. |

Media paths resolve from the project root. No remote URLs.

## Time and trims

- `start` is the timeline frame where the clip begins.
- `sourceIn` is the first source frame. It defaults to `0` and must be `0` for images.
- `duration` is the number of timeline frames. It is optional for compositions, nested timelines, video, and audio; it defaults to the rest of the source. Images require it.
- A clip that exceeds its source is an error.
- Clips on one track cannot overlap. Touching endpoints are allowed. Use separate tracks for overlays.

## Presentation

Visual clips accept a static transform:

- `fit`: `contain`, `cover`, or `stretch`.
- `width`, `height`: optional clip box in output pixels. Both are required together and cannot be combined with `scale`. `fit` applies inside the box, and `x`/`y` offset the box center. Without them, the project frame is the box.
- `x`, `y`: pixel offsets from the centered fitted result.
- `scale`: multiplier after fitting to the project frame; an alternative to `width`/`height`.
- `rotation`: degrees around the center.
- `opacity`: 0–1.

No keyframes or animated transforms in 0.6.

## Audio

- Composition, video, and nested-timeline clips contribute audio automatically unless `audio.muted` is true.
- Timeline audio clips live on audio tracks. Audio tracks support `gain` and `muted`.
- `audio.gain` on a clip is 0–1 and multiplies the source audio.
- There are no linked A/V pairs. For a J/L cut, mute the visual clip and add an audio clip with a different `sourceIn`.
- Audio is mixed once for the whole timeline and muxed into the final output.

## Nested timelines

A nested timeline clip behaves as one layer: its internal tracks are composited first, then the parent clip's opacity and transform apply to the whole group. Nested audio is included. Cycles are rejected statically. Timeline clips do not override props of compositions inside a nested timeline in 0.6.

## Commands

```sh
npx frameyard check main --json
npx frameyard still main --frame 42 --out main-42.png --json
npx frameyard still main --frame 0,118-126 --out out/stills --json
npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch --json
```

- `--props` on a timeline is a JSON object keyed by top-level composition clip ID; values merge over the clip's `props`.
- `--workers` is 1–16. The default is 8. With `--encoder nvenc` it is capped at 8 concurrent encode sessions and a larger value reports an `ENCODER_WARNING`.
- `--scratch` selects the FFV1 intermediate directory. Use a disk with enough space; intermediates are cleaned after the render.
- `--container <mp4|mov|mkv|webm>` selects the delivery container (default `mp4`); `--codec <h264|hevc|vp9>` selects the codec, and `--encoder <auto|software|nvenc|qsv>` selects how it is encoded. MP4 and MOV hold H.264/HEVC with AAC; MKV holds all three; WebM holds VP9 with Opus and defaults to VP9. `auto` is the default and probes NVENC, then Quick Sync, then software; `software` forces `libx264`, `libx265`, or `libvpx-vp9`. FFV1 intermediates stay lossless and software-encoded, HEVC keeps the `hvc1` tag in MP4/MOV, and the output extension must match the container.
- `--concurrency` is composition-only.
- `render` defaults to `out/<timeline-id>.mp4`.
- `check` evaluates every timeline frame and composition frame. `still` captures one or more requested frames through the same clip capture and composite path; a multi-frame still resolves the timeline, starts one server, and reuses one scratch directory. The `--frame` spec and 32-frame cap are the same as for compositions.
- `npx frameyard dev` lists timelines in the preview; the timeline view has a program monitor, read-only tracks and clips, playhead, playback, audio controls, and diagnostics.

## Determinism and performance

- A timeline frame derives only from its active clips, their composition frames, props, assets, and the render plan.
- Composition frames are captured with Chromium; transparent compositions preserve alpha.
- Timeline production captures active composition and nested-timeline clips to lossless FFV1, composites segments with FFmpeg, concatenates the ordered segments, and mixes audio once.
- Preview composites in Chromium; production composites with FFmpeg. Small scaling, alpha, and video color differences are expected. Parity is guaranteed at clip capture, not at final encoded pixels.
- Final output bytes are not a reproducibility guarantee.
- Long timelines are segmented and bounded. The reference target and measured worst cases are documented in `docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md`.
