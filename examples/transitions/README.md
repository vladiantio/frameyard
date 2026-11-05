# Timeline transitions example

This project has two timelines:

- `transitions` dissolves three timed composition cards on one video track and
  lets their contributed audio crossfade.
- `audio-crossfade` mutes the composition audio and places the sound directly on
  an audio track, with a `crossfade` between two audio clips.

## Visual dissolve with contributed audio

`transitions` is a 4-second, 1280×720, 30 fps timeline:

- **alpha** `0..60` — the A-major card and the outgoing clip. It keeps rendering
  for the whole overlap, including after `beta` starts.
- **beta** `45..105` — the C#-major card and the incoming clip. Its first 15
  frames are the `alpha → beta` dissolve, then it runs alone, then it hands off
  to `gamma`.
- **gamma** `90..120` — the E-major card and the second incoming clip.

Each composition is a timed HTML fragment (`duration-in-frames`) with one
`<audio>` element. The audio belongs to the visual clip, so the dissolve
crossfades it automatically.

## Audio clips on the timeline

`audio-crossfade` renders the same alpha and beta cards for 3.5 seconds, but
mutes their composition audio with `audio.muted: true` and puts the sound on
`a1` instead:

- **chord-alpha** `0..60` — `assets/alpha.wav`, the outgoing chord.
- **chord-beta** `45..105` — `assets/beta.wav`, the incoming chord.

```json
"transitions": [
  { "from": "alpha", "to": "beta", "kind": "dissolve", "easing": "ease-in-out" },
  { "from": "chord-alpha", "to": "chord-beta", "kind": "crossfade", "easing": "linear" }
]
```

The visual dissolve and the audio crossfade share the same 15-frame overlap, so
the picture and the sound hand off together. `crossfade` is the audio-track
kind: it applies an equal-power gain ramp and changes no pixels.

## Transition contract

`transitions` is a timeline-level array of `{ "from", "to", "kind", "easing" }`:

- `from` and `to` are clip IDs on the **same track**. A transition never spans
  tracks.
- `kind` is `dissolve` on a video track or `crossfade` on an audio track. A
  dissolve fades the incoming picture in and also crossfades the audio the two
  clips contribute; a crossfade only ramps audio gain. Using the wrong kind for
  the track is an error.
- `easing` defaults to `linear` and accepts the same CSS timing-function
  vocabulary as clip keyframes.
- The transition window is the overlap: `to.start .. from.end`. There is no
  `duration` field; move the incoming clip earlier to make the transition
  longer.
- The geometry must be `from.start < to.start < from.end < to.end`. The incoming
  clip must begin inside the outgoing clip and outlast it.
- A clip may be the `to` of one transition and the `from` of the next, so
  transitions chain. A clip cannot participate twice on the same side.
- Overlap without a declared transition is still an error. Touching endpoints
  are not a transition.

During a dissolve the incoming clip composites above the outgoing clip with
alpha `clipOpacity × eased progress`. Clip opacity may be static or keyframed
and multiplies the transition.

## Audio semantics

Both kinds use an equal-power ramp over the window: the outgoing clip's gain is
`sqrt(1 - t)` and the incoming clip's is `sqrt(t)`, after easing. For a
dissolve, the ramp applies to the audio the two visual clips contribute. For a
crossfade, it applies to the two audio-track clips themselves.

`audio.muted` still zeroes a side, and `audio.gain` plus the track `gain`
multiply the envelope. A crossfade on an audio track has no visual effect; a
dissolve on an audio track is rejected.

## What to look at

The first dissolve uses `ease-in-out`, so it starts and ends gently around a
faster middle. The second uses `linear`, so its progress tracks the frame clock
exactly. The read-only preview draws a hatched band over each overlap, including
the audio crossfade; the band is informational, not editable.

Render or preview with sound. In `transitions` the chords hand off at frames 45
and 90. In `audio-crossfade` the sound is on the timeline, and the A → C#
crossfade happens at frames 45..60 while the picture dissolves over the same
window.

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
  timelines/audio-crossfade.timeline.json
  video.config.js
```

## Commands

From the repository root:

```sh
pnpm build
node dist/cli.js check transitions --project examples/transitions
node dist/cli.js check audio-crossfade --project examples/transitions
node dist/cli.js still transitions --frame 0,52,60,97 --project examples/transitions --out transitions-stills
node dist/cli.js still audio-crossfade --frame 52 --project examples/transitions --out audio-crossfade-still.png
FRAMEYARD_POLICY=full node dist/cli.js render transitions --project examples/transitions
FRAMEYARD_POLICY=full node dist/cli.js render audio-crossfade --project examples/transitions
node dist/cli.js dev --project examples/transitions
```

`render` writes `out/<timeline-id>.mp4` inside the project by default. Frame 52
sits halfway into the first dissolve, frame 59 is the last frame of that overlap,
and frame 97 is inside the second dissolve. In `audio-crossfade`, frame 52 is
also inside the audio crossfade. `still` and `render` share the same composite
path, so a still taken inside a transition matches the rendered frame.
