# Frameyard video example

A 12-second, 1920×1080 project that treats a local clip as source footage. The
project includes the same layout for two source codecs:

- `video` reads `assets/clip.webm` (VP9 + Opus)
- `video-mp4` reads `assets/clip.mp4` (H.264 + AAC)

Both compositions include:

- a full-bleed hero pass whose unmuted soundtrack joins the composition audio timeline
- a persistent detail pass with its own `data-fy-start`, `data-fy-trim`, and `data-fy-duration`
- `data-fy-audio="off"` on the detail pass so only the hero contributes audio
- a frame counter derived from `--fy-frame` in CSS, with static source-range labels
- frame-scheduled CSS typography and a frame-state progress bar
- a one-second fade to black over the final second of the composition

The hero pass uses the full 12-second source at volume `0.85`. The detail window
is visible for the whole composition: it holds the source at 5.8 seconds until
composition frame 120, then plays 5 seconds of the same file, and holds the final
source frame after frame 270. The result shows two source moments side by side.
The example is entirely declarative: the runtime owns loading, pausing, and
frame seeking, and CSS derives the frame counter from the frame state. No
controller is needed. The header, copy, and footer fade individually rather
than the whole scene; a full-scene opacity animation above a video can leave
the load frame on screen in interactive preview after a large seek.

## Timeline with the video on a track

`video-timeline` and `video-timeline-mp4` move the footage out of the
composition and onto timeline tracks. The HTML is now a transparent overlay
above it:

- `v1` holds the hero clip: the whole 12-second source, audio at `0.85`
- `v2` holds the detail pass from source frame 174 (5.8 s) for 150 frames,
  muted, placed in a 440×248 transform box in the bottom right
- `v3` holds `video-overlay`, an HTML-only composition with no `<video>`
  elements and a transparent document background

`video-timeline` reads `assets/clip.webm` (VP9 + Opus) and
`video-timeline-mp4` reads `assets/clip.mp4` (H.264 + AAC). Both share the same
overlay composition and props file; the overlay clip sets its own `format` prop
so the header reports the codec of each timeline.

The detail clip uses `transform.width` and `transform.height` instead of
`scale`, with `fit: "cover"` filling that box. The box matches the overlay's
detail window exactly, so the video and its chrome stay aligned in production
and preview.

The overlay draws the scrim, typography, frame border, detail-window chrome,
progress bar, and outro fade. `video-overlay` declares its own frame animations,
so the title and footer still animate on the timeline clock. Production captures
the overlay with alpha and composites it over the video layers with FFmpeg; the
interactive timeline preview composites the same layers in Chromium.

Both timelines accept `props/video-timeline.json`, which overrides the overlay
composition's props. Timeline `--props` is keyed by composition clip id, so the
file targets the `overlay` clip.

Open the preview with `node dist/cli.js dev --project examples/video`; the
compositions and both timelines are listed.

The compositions live in `compositions/video.html` and
`compositions/video-mp4.html`; the overlay lives in
`compositions/video-overlay.html`, and the timelines in
`timelines/video-timeline.timeline.json` and
`timelines/video-timeline-mp4.timeline.json`. Both clips are 12-second 1280×720
files generated procedurally for this example; the MP4 is transcoded from the
WebM source. Replace either asset with a local, seekable video file that is at
least 12 seconds long; remote URLs and live streams are not supported.

Regenerate both clips from scratch with the bundled FFmpeg script:

```sh
bash examples/video/scripts/make-clip.sh
```

The script writes both files into `assets/`; pass `--out-dir <directory>` to
write elsewhere. It requires FFmpeg with `libvpx-vp9`, `libx264`, Opus, and AAC
encoders, and fixed noise seeds keep the generated grain stable across runs on
the same FFmpeg build.

From the repository root:

```sh
pnpm build
node dist/cli.js check video --project examples/video
node dist/cli.js check video-mp4 --project examples/video
node dist/cli.js check video-timeline --project examples/video
node dist/cli.js check video-timeline-mp4 --project examples/video
node dist/cli.js still video --frame 210 --project examples/video --out video-still.png
node dist/cli.js still video-mp4 --frame 210 --project examples/video --out video-mp4-still.png
node dist/cli.js still video-timeline --frame 210 --project examples/video --out video-timeline-still.png
node dist/cli.js still video-timeline-mp4 --frame 210 --project examples/video --out video-timeline-mp4-still.png
node dist/cli.js render video --project examples/video --props examples/video/props/video.json
node dist/cli.js render video-mp4 --project examples/video --props examples/video/props/video.json
node dist/cli.js render video-timeline --project examples/video --props examples/video/props/video-timeline.json
node dist/cli.js render video-timeline-mp4 --project examples/video --props examples/video/props/video-timeline.json
```

Start the interactive preview with:

```sh
node dist/cli.js dev --project examples/video
```
