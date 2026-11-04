# Timeline transitions example

A 4-second, 1280×720, 30 fps timeline that dissolves through three timed
composition cards on one video track, each carrying a sustained chord:

- **alpha** `0..60` — the A-major card and the outgoing clip. It keeps rendering
  for the whole overlap, including after `beta` starts.
- **beta** `45..105` — the C#-major card and the incoming clip. Its first 15
  frames are the `alpha → beta` dissolve, then it runs alone, then it hands off
  to `gamma`.
- **gamma** `90..120` — the E-major card and the second incoming clip.

Each composition is a timed HTML fragment (`duration-in-frames`) with one
`<audio>` element. The audio belongs to the visual clip, not to a separate audio
track, so the dissolve crossfades it automatically.

## Transition contract

`transitions` is a timeline-level array of `{ "from", "to", "kind", "easing" }`:

- `from` and `to` are clip IDs on the **same video track**.
- `kind` is `dissolve`. Other kinds are rejected until they can be reproduced
  in both the preview and the FFmpeg composite.
- `easing` defaults to `linear` and accepts the same CSS timing-function
  vocabulary as clip keyframes.
- The transition window is the overlap: `to.start .. from.end`. There is no
  `duration` field; move the incoming clip earlier to make the dissolve longer.
- The geometry must be `from.start < to.start < from.end < to.end`. The incoming
  clip must begin inside the outgoing clip and outlast it.
- A clip may be the `to` of one transition and the `from` of the next, so
  transitions chain. A clip cannot participate twice on the same side.
- Overlap without a declared transition is still an error. Touching endpoints
  are not a transition.

During the window the incoming clip composites above the outgoing clip with
alpha `clipOpacity × eased progress`. Clip opacity may be static or keyframed
and multiplies the transition.

## Audio

Each card declares its chord directly in the composition (`assets/alpha.wav`,
`assets/beta.wav`, `assets/gamma.wav`). Because the sound is contributed by the
visual clip, the transition applies an equal-power crossfade over the same
window: the outgoing clip's gain is `sqrt(1 - t)` and the incoming clip's is
`sqrt(t)`, after easing. Equal power keeps the overlap from dipping the way a
linear fade would; the three chords form an A → C# → E ascent across the edit.

Timeline audio clips on `audio` tracks are separate: they mix once and do not
crossfade. To hear a transition, declare the sound inside the composition that
the transitioning clip renders.

## What to look at

The first dissolve uses `ease-in-out`, so it starts and ends gently around a
faster middle. The second uses `linear`, so its progress tracks the frame clock
exactly. The read-only preview draws a hatched band over each overlap; the band
is informational, not editable.

Render or preview with sound to hear the chords hand off at frames 45 and 90.
The first overlap blends A major into C# major; the second blends C# major into
E major.

## Files

```text
examples/transitions/
  assets/alpha.wav                 A-major chord, 2 s
  assets/beta.wav                  C#-major chord, 2 s
  assets/gamma.wav                 E-major chord, 1 s
  compositions/alpha.html          outgoing timed card
  compositions/beta.html           middle timed card
  compositions/gamma.html          incoming timed card
  timelines/transitions.timeline.json
  video.config.js
```

## Commands

From the repository root:

```sh
pnpm build
node dist/cli.js check transitions --project examples/transitions
node dist/cli.js still transitions --frame 0,52,60,97 --project examples/transitions --out transitions-stills
node dist/cli.js render transitions --project examples/transitions
node dist/cli.js dev --project examples/transitions
```

`render` writes `out/transitions.mp4` inside the project by default. Frame 52
sits halfway into the first dissolve, frame 59 is the last frame of that overlap,
and frame 97 is inside the second dissolve. `still` and `render` share the same
composite path, so a still taken inside a transition matches the rendered frame.
