# Frameyard nested timelines example

A 12-second, 1280×720, 30 fps outer timeline that places two reusable inner
timelines on its tracks:

| Frames | Placement | What plays |
| --- | --- | --- |
| 0–119 | `chapter-a` · full frame | Chapter A on track `v1` |
| 120–239 | `chapter-b` · full frame | Chapter B on track `v2` |
| 240–359 | `chapter-a` · 480×270 group | Chapter A again on track `v3`, muted |

`chapter-a` and `chapter-b` are complete timelines in their own right. Each
contains a static backdrop, an animated card composition with its own props, and
a local audio clip. The outer timeline references them with
`"source": { "kind": "timeline", "id": "chapter-a" }` instead of referencing
their compositions directly.

The third placement repeats `chapter-a` with a group transform:

```json
{
  "source": { "kind": "timeline", "id": "chapter-a" },
  "start": 240,
  "duration": 120,
  "transform": {
    "fit": "cover",
    "width": 480,
    "height": 270,
    "x": 360,
    "y": 180
  },
  "audio": { "muted": true }
}
```

The transform applies to the whole nested result. Every layer inside the chapter
moves, scales, and clips together; the parent clip does not reach into the child
timeline. The same rule applies to opacity and blend mode. Nested audio is mixed
with the outer timeline automatically, so the final placement sets
`audio.muted` to avoid replaying the pulse.

## Layers inside the chapters

- `backdrop` is a static opaque composition. It declares no dimensions, no
  `fps`, and no `duration-in-frames`, so it inherits the project format. The
  renderer captures it once and reuses that PNG across segments and both chapter
  timelines.
- `card` is a 120-frame animated composition. The chapter timeline places it
  with props for the chapter number, copy, and accent color. The card paints on
  transparent alpha above the backdrop; its progress bar reads
  `--fy-progress` and the dial runs on the local frame clock.
- `pulse` is a 1.8-second WAV on the chapter's audio track. In the outer
  timeline the first two chapter clips contribute it; `check` reports two mixed
  audio clips.

`overlay` is a top-level composition on track `v4`. It draws the project chrome,
the frame counter, and the global progress bar for the full 12 seconds. Its PiP
border and left-hand caption are scheduled with
`data-fy-anim-start="240"`/`"246"` and an `animation` with `both` fill, so they
stay invisible until the grouped replay begins.

## Files

```text
examples/nested/
  compositions/backdrop.html       static inherited-format backdrop
  compositions/card.html           animated transparent card
  compositions/overlay.html        project chrome, PiP border, and outro caption
  timelines/chapter-a.timeline.json
  timelines/chapter-b.timeline.json
  timelines/nested-reel.timeline.json
  assets/pulse.wav                 local chapter audio
  scripts/make-pulse.sh            regenerate assets/pulse.wav
  video.config.js
```

`chapter-a` and `chapter-b` are listed in `video.config.js`, so each can be
checked, previewed, stilled, or rendered on its own. Timeline `--props` is keyed
by top-level composition clip ID; a nested timeline clip does not forward prop
overrides to the compositions inside it. Fix chapter props in the chapter's own
timeline document.

## Commands

From the repository root:

```sh
pnpm build
node dist/cli.js check chapter-a --project examples/nested
node dist/cli.js check nested-reel --project examples/nested
node dist/cli.js still nested-reel --frame 60,180,300 --project examples/nested --out nested-stills
FRAMEYARD_POLICY=full node dist/cli.js render chapter-a --project examples/nested
FRAMEYARD_POLICY=full node dist/cli.js render nested-reel --project examples/nested
node dist/cli.js dev --project examples/nested
```

The batch still captures chapter A full frame, chapter B full frame, and the
grouped replay with its overlay. `render` writes `out/chapter-a.mp4` and
`out/nested-reel.mp4` inside the project by default; pass `--out` for another
path. The outer render uses the segmented lossless pipeline and captures the
nested ranges through the same clip path as the stills. Use `--workers` and
`--scratch` to tune timeline rendering.

Regenerate the pulse with FFmpeg:

```sh
bash examples/nested/scripts/make-pulse.sh
```

Pass an output path as the first argument to write elsewhere. The source is a
pair of faded sine tones; replace `assets/pulse.wav` with any local WAV, MP3,
M4A, AAC, or video file if you want different audio.
