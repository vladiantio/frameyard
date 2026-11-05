# Timeline keyframes example

A 6-second, 1280×720, 30 fps timeline that animates one clip through every
supported presentation channel:

- `v1` **backdrop** — a static HTML composition with a gradient, a perspective
  grid, and a soft glow. It declares no time metadata, so it is captured once
  as an opaque image layer.
- `v2` **card** — a static transparent HTML composition captured once as well.
  Its timeline clip uses `blend: "screen"` and keyframes on `x`, `y`, `scale`,
  `rotation`, and `opacity`.

The card enters from the left, settles in the center, holds, and leaves toward
the right while it fades. Position, scale, and rotation use `ease-out` into the
hold and `ease-in` out of it. The clip uses `ease-out` and `ease-in` rather than
animating inside the card, because this animation belongs to the edit, not to
the reusable composition.

## Keyframe contract

`keyframes` is a per-clip object keyed by channel. Each channel is an array of
`{ "frame", "value", "easing" }` entries:

- `frame` is clip-local. `0` is the clip start; `duration` is the end boundary.
- Keys must be integers in `0..duration`, strictly increasing, with at least two
  entries per channel.
- A channel holds its first value before the first key and its last value after
  the last key.
- `easing` applies to the interval after that key and defaults to `linear`. The
  supported vocabulary is `linear`, `ease`, `ease-in`, `ease-out`,
  `ease-in-out`, `step-start`, `step-end`, `hold`, `cubic-bezier(...)`, and
  `steps(...)`. The final key’s easing has no effect.
- A channel cannot also be an explicit scalar in `transform`; keyed channels
  and static channels are separate. Defaults do not conflict.
- `opacity` is `0..1`, `scale` is `>= 0`, and interpolated opacity and scale are
  clamped after easing. Position and rotation may overshoot.
- `keyframes.scale` cannot be combined with a `transform.width`/`height` box.

Preview evaluates the CSS timing functions exactly and seeks the clip styles on
every frame. Production generates FFmpeg expressions from the same evaluator,
using an alpha mask for animated opacity. Floating-point easing in the filter
graph is an approximation of the CSS curve; parity is guaranteed at clip capture,
not at the final encoded pixel. Fractional positions can differ by a subpixel.

## Files

```text
examples/keyframes/
  compositions/backdrop.html   opaque static backdrop
  compositions/card.html       transparent static card
  timelines/keyframes.timeline.json
  video.config.js
```

The timeline lives in `timelines/keyframes.timeline.json`. Both compositions are
static: they declare neither `duration-in-frames` nor `fps`, and the timeline
supplies their durations and `sourceIn: 0`. The card is still animated on the
timeline because keyframes are a clip property, not a composition property.

## Commands

From the repository root:

```sh
pnpm build
node dist/cli.js check keyframes --project examples/keyframes
node dist/cli.js still keyframes --frame 12,90,170 --project examples/keyframes --out keyframes-stills
node dist/cli.js still keyframes --frame 90 --project examples/keyframes --out keyframes-center.png
FRAMEYARD_POLICY=full node dist/cli.js render keyframes --project examples/keyframes
node dist/cli.js dev --project examples/keyframes
```

`render` writes `out/keyframes.mp4` inside the project by default. The batch
still captures the entrance, the hold, and the exit through the same clip
capture and composite path as the render. `dev` lists the timeline and shows
the keyframe markers on the clip bar; clicking a marker seeks to that frame.
