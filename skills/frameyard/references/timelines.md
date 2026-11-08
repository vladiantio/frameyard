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

- `format` fixes width, height, and fps for every timeline and fills those values for compositions that omit them; a declared value always wins. It is required when the project lists timelines.
- Composition and timeline IDs share one namespace and must be unique.
- An animated composition that declares an `fps` must match the project fps exactly; an undeclared `fps` inherits it. A different size is fitted by the clip. A static composition has no fps and skips the frame-rate comparison.
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
      "blend": "screen",
      "transform": { "fit": "contain", "x": 0, "y": 0, "scale": 1, "rotation": 0 },
      "keyframes": {
        "opacity": [
          { "frame": 0, "value": 0 },
          { "frame": 20, "value": 1, "easing": "ease-out" }
        ]
      },
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
- Unknown fields are errors. Blend modes are static per clip; there are no animated blend modes, other effects, or track solo/visibility. Clip transitions are the one same-track overlap (see [Transitions](#transitions)).

## Sources

| `source.kind` | Fields | Notes |
| --- | --- | --- |
| `composition` | `id` | Project composition ID. The clip may set `props`. A static composition behaves as an image source. |
| `timeline` | `id` | Nested timeline ID. Rendered as a group. |
| `video` | `src` | Local MP4/WebM, project-relative. |
| `image` | `src` | Local PNG/JPEG/WebP. `duration` is required. |
| `audio` | `src` | Local WAV/MP3/M4A/AAC or a video file used only for audio. |

Media paths resolve from the project root. No remote URLs.

## Time and trims

- `start` is the timeline frame where the clip begins.
- `sourceIn` is the first source frame. It defaults to `0` and must be `0` for images and static compositions.
- `duration` is the number of timeline frames. It is optional for animated compositions, nested timelines, video, and audio; it defaults to the rest of the source. Images and static compositions require it.
- A clip that exceeds its source is an error. Static compositions have no intrinsic duration, so the clip duration is the only bound.
- A static composition clip is captured once per props variant as a transparent PNG and reused across segments. A clip whose source is static and whose `audio` settings are non-default receives an `AUDIO_WARNING` because there is no source audio.
- Clips on one track cannot overlap unless a timeline-level `transitions` entry pairs them. Touching endpoints are allowed but are not a transition. Use separate tracks for overlays that are not transitions.

## Presentation

Visual clips accept a static transform:

- `fit`: `contain`, `cover`, or `stretch`.
- `width`, `height`: optional clip box in output pixels. Both are required together and cannot be combined with `scale`. `fit` applies inside the box, and `x`/`y` offset the box center. Without them, the project frame is the box.
- `x`, `y`: pixel offsets from the centered fitted result.
- `scale`: multiplier after fitting to the project frame; an alternative to `width`/`height`.
- `rotation`: degrees around the center.
- `opacity`: 0–1.
- `blend`: CSS `mix-blend-mode`, defaulting to `normal`. Supported values are `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, and `exclusion`. `hue`, `saturation`, `color`, and `luminosity` are rejected.

A blend mode composites the clip against everything below it in the stage, including the timeline background, and only where the clip's source alpha is non-zero. A composition or nested timeline that paints an opaque background blocks the lower layers; source alpha is what lets a blend reach them. A top-level timeline with no declared background renders over black; a nested or embedded timeline stays transparent. Blend modes are static; there are no animated blend modes.

Rotation keeps the full rotated bounds. Production expands the rotate filter's output to a fixed bound: static rotation uses its exact rotated bounding box, while keyed rotation uses the diagonal of the fitted box so every segment uses the same size. The filter fills the padding with transparent pixels, so rotated corners are visible instead of being cut off.

## Keyframes

Visual clips may animate `x`, `y`, `scale`, `rotation`, and `opacity` with a top-level `keyframes` object keyed by channel:

```json
"keyframes": {
  "opacity": [
    { "frame": 0, "value": 0 },
    { "frame": 24, "value": 1, "easing": "ease-out" },
    { "frame": 120, "value": 1 },
    { "frame": 150, "value": 0, "easing": "ease-in" }
  ],
  "x": [
    { "frame": 0, "value": -80, "easing": "ease-out" },
    { "frame": 24, "value": 0 }
  ]
}
```

- `frame` is clip-local. `0` is the clip's start boundary and `duration` is its end boundary. Moving `start` moves the animation with the clip; `sourceIn` does not shift it.
- Keys are integers in `0..duration`, strictly increasing, with at least two per channel and a required `value`.
- A channel holds its first value before the first key and its last value after the last key. Keyframes never extend a clip's duration.
- `easing` applies to the interval after that key. It defaults to `linear`; the final key's easing has no effect.
- Supported easings are `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `step-start`, `step-end`, `hold`, `cubic-bezier(x1, y1, x2, y2)`, and `steps(n, jump-start|jump-end|jump-none|jump-both)`.
- A channel cannot also be an explicitly declared scalar in `transform`. Defaults do not conflict; unkeyed channels keep their `transform` value.
- `opacity` values are `0..1` and `scale` values are `>= 0`. Interpolated opacity and scale are clamped after easing; `x`, `y`, and `rotation` may overshoot.
- `keyframes.scale` cannot be combined with a `transform.width`/`height` box.
- `keyframes` is only valid on visual clips. A static composition is captured once as an image and then animated like any other visual layer.

Preview evaluates keyframes on every seek with the exact CSS timing function. Production generates per-frame FFmpeg expressions from the same evaluator and uses an alpha mask for animated opacity. Floating-point easing in the filter graph approximates the CSS curve; parity remains at clip capture, not at the final encoded pixel. Fractional `x`/`y` values may differ by a subpixel between preview and production.

The read-only timeline preview draws a marker for each distinct keyframe frame on a clip. Hovering a marker lists the channels at that frame; clicking it seeks the playhead there.

## Transitions

A timeline may declare a `transitions` array. Each entry pairs two clips on one track across their overlap:

```json
"clips": [
  { "id": "alpha", "track": "main", "source": { "kind": "composition", "id": "alpha" }, "start": 0, "duration": 60 },
  { "id": "beta", "track": "main", "source": { "kind": "composition", "id": "beta" }, "start": 45, "duration": 60 }
],
"transitions": [
  { "from": "alpha", "to": "beta", "kind": "dissolve", "easing": "ease-in-out" }
]
```

- `from` and `to` must be clip IDs on the same track. A transition never spans tracks.
- `kind` is required. `dissolve` is a visual fade on a video track and also crossfades the audio the two clips contribute. `crossfade` is an audio gain ramp on an audio track. Using the wrong kind for the track is an error.
- `easing` defaults to `linear` and accepts the same CSS timing functions as keyframes, including `hold` and `steps(...)`.
- There is no `duration`. The window is the overlap `to.start .. from.end`. Move `to.start` earlier to lengthen the transition; the outgoing clip's declared duration already covers its side, so no media handles are needed.
- Valid geometry is `from.start < to.start < from.end < to.end`. The incoming clip must start inside the outgoing clip and end after it. Reversed order, a contained clip, a touching or later start, and cross-track pairs are errors.
- A clip may be the `to` of one transition and the `from` of the next, so transitions chain. A clip may not participate twice on the same side, and the same pair may not be declared twice.
- Overlap without a declared transition is still `TIMELINE_CLIP_OVERLAP`. A third clip that overlaps either side is an error, so at most two clips are active on a track.
- During a dissolve the incoming clip composites directly above the outgoing clip with alpha `clipOpacity × eased progress`. Its static or keyframed `opacity` multiplies the transition. `blend` works normally because transition alpha is part of the source alpha.
- Both kinds use equal power: the outgoing clip ramps as `sqrt(1 - t)` and the incoming as `sqrt(t)`, after easing. For a dissolve this applies to contributed audio; for a crossfade it applies to the two audio clips. `audio.muted` still zeroes its side. Transitions on a nested-timeline clip fade that group's audio.
- Preview stacks the incoming visual layer above the outgoing layer, applies the same alpha, ramps `<audio>` volume during playback, and draws a read-only hatched band over the overlap on either track.

`check` exposes the resolved transition count and validates every window. `still` and `render` share the composite path, so a still captured inside a dissolve matches the rendered frame. A crossfade changes no pixels. See `examples/transitions`.

### Audio on the timeline

Audio can live directly on an audio track and still crossfade:

```json
"tracks": [
  { "id": "v1", "kind": "video" },
  { "id": "a1", "kind": "audio" }
],
"clips": [
  { "id": "bed", "track": "v1", "source": { "kind": "composition", "id": "bed" }, "start": 0, "duration": 105 },
  { "id": "chord-a", "track": "a1", "source": { "kind": "audio", "src": "assets/a.wav" }, "start": 0, "duration": 60 },
  { "id": "chord-b", "track": "a1", "source": { "kind": "audio", "src": "assets/b.wav" }, "start": 45, "duration": 60 }
],
"transitions": [
  { "from": "chord-a", "to": "chord-b", "kind": "crossfade", "easing": "linear" }
]
```

Mute composition audio with `audio.muted: true` when the sound comes from audio-track clips, so it does not play twice. `examples/transitions` has an `audio-crossfade` timeline that pairs a visual dissolve with an audio crossfade over the same 15 frames.

## Audio

- Animated composition, video, and nested-timeline clips contribute audio automatically unless `audio.muted` is true. Static compositions contribute no audio; put audio on a timeline track.
- Timeline audio clips live on audio tracks. Audio tracks support `gain` and `muted`.
- `audio.gain` on a clip is 0–1 and multiplies the source audio.
- There are no linked A/V pairs. For a J/L cut, mute the visual clip and add an audio clip with a different `sourceIn`.
- Audio is mixed once for the whole timeline and muxed into the final output.

## Nested timelines

A nested timeline clip behaves as one layer: its internal tracks are composited first, then the parent clip's opacity, transform, and blend mode apply to the whole group. A blend mode inside the nested timeline sees only that timeline's own backdrop; it never sees the parent's layers. A declared nested background is part of the group, so a transparent nested timeline has no backdrop to blend against beyond its own layers. Nested audio is included. Cycles are rejected statically. Timeline clips do not override props of compositions inside a nested timeline.

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
- `check` evaluates every timeline frame and every animated composition frame; a static composition layer is inspected once and not seeked per frame. It also evaluates every keyframe channel at every timeline frame. `still` captures one or more requested frames through the same clip capture and composite path; a multi-frame still resolves the timeline, starts one server, and reuses one scratch directory. The `--frame` spec and 32-frame cap are the same as for compositions.
- `npx frameyard dev` lists compositions, timelines, and timeline media in the preview's assets panel. The source monitor shows the selected composition, clip source, or asset; the timeline view has a program monitor, read-only tracks and clips, playhead, playback, audio controls, and diagnostics. Selecting a clip loads its source in the source monitor without moving the playhead.

## Determinism and performance

- A timeline frame derives only from its active clips, their composition frames, keyframe values, props, assets, and the render plan.
- Composition frames are captured with Chromium; transparent compositions preserve alpha.
- Timeline production captures active composition and nested-timeline clips to lossless FFV1, composites segments with FFmpeg, concatenates the ordered segments, and mixes audio once.
- Keyframe and transition values are evaluated against absolute timeline frames, so segment boundaries do not change them. Position, scale, and rotation use per-frame filter expressions; animated opacity and incoming transition alpha use an alpha mask. Animated opacity, animated scale, and a dissolve add a mask/scale pass per affected layer.
- Preview composites in Chromium with CSS `mix-blend-mode` and CSS `opacity`; production composites with FFmpeg's `blend`, `maskedmerge`, and an alpha mask. CSS is the reference; small scaling, alpha, color, blend-math, and subpixel-position differences are expected. Easing curves in the filter graph approximate the CSS curve; parity is guaranteed at clip capture, not at final encoded pixels.
- Alpha-correct blending costs roughly 1.7× per blended 1080p layer in the production composite. Budget for it when a timeline stacks several blended layers.
- Final output bytes are not a reproducibility guarantee.
- Long timelines are segmented and bounded. The reference target and measured worst cases are documented in `docs/adr/0012-render-timelines-with-segmented-lossless-clip-intermediates.md`.
