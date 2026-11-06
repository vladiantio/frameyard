# Encode a full-frame composition and a static overlay through dual pipes

**Status:** Accepted. Extends [ADR-0026](./0026-reuse-loaded-composition-sessions-across-segments.md).
**Date:** 2026-11-06

A segment with a full-frame composition base and one static composition overlay
now captures both layers concurrently and feeds them to one FFmpeg process
through two image pipes. The base has an identity transform; the overlay may use
a static fit, box, and position, but no keyframes, blend, transition, or
opacity. The process composites the background, base, and overlay and encodes
the delivery segment directly. The FFV1 intermediates and the separate
composite pass are skipped.

## Context

The two-layer 60-second PIP gate takes 43.78 s; the overlay is a 640×360
composition on a second track. A two-full-frame-layer workload (1920×1080 base
plus a 1920×1080 transparent overlay) took 53.27 s with the normal FFV1 and
composite path. Both captures already ran concurrently after ADR 0025, but the
segment still paid for two FFV1 encodes, two decodes, and a separate composite
encode.

FFmpeg can read a second image stream from `pipe:3`, and Node can provide that
extra stdio pipe on Linux and macOS. The two captures write to independent
pipes, so neither blocks the other while FFmpeg overlays frames in order.

## Decision

- `startDualPipeSegmentEncoder` spawns one FFmpeg process with:
  - `pipe:0` for the base composition;
  - `pipe:3` for the overlay composition;
  - a `lavfi color` input for the timeline background;
  - `[2:v][0:v]overlay`, then `[base][1:v]overlay`, then the delivery encoder.
- `captureTwoLayerDirectComposition` leases two capture sessions, writes each
  layer to its pipe, and waits for both frame counts before finishing.
- The fast path requires exactly two composition layers: a base that matches the
  stage with an identity transform, and an overlay with no keyframes, blend,
  transition, opacity, scale, or rotation. The overlay may use a static fit,
  explicit box, and position. An opaque timeline background is required.
- Windows falls back to the FFV1 and composite path because extra stdio pipe
  descriptors are not portable there.
- `FRAMEYARD_DISABLE_DUAL_PIPE=1` forces the fallback for A/B measurements.
- One-layer direct segments keep `startDirectSegmentEncoder`; PIP, transformed,
  blended, keyframed, nested, static, and media layers keep the segmented
  lossless path.

## Considered Options

- **General multi-pipe compositor for any layer count.** Rejected for now:
  extra pipes multiply the coordination surface and make Windows support
  harder. Two full-frame layers cover the measured multi-layer case.
- **Interleave two captures into one pipe.** Rejected: the filter graph would
  need frame-splitting metadata and the capture loops would have to lockstep.
- **Buffer the base layer and stream only the overlay.** Rejected: buffering a
  300-frame 1080p layer costs hundreds of megabytes and adds a copy.
- **Keep FFV1 and tune the composite.** Measured filters and thread knobs gave
  no meaningful gain; the intermediate round trip is the cost.

## Consequences

- The two-full-frame-layer 60-second gate fell from 53.27 s to 34.62 s (−35.0%)
  with byte-identical output. The full 60-minute two-layer gate completed in
  29.69 minutes with eight workers, 108,000 exact frames, and clean scratch,
  just inside the 30-minute target.
- The two-layer PIP 60-second gate fell from 43.78 s to 33.90 s (−22.6%); sampled
  decoded frames are pixel-identical to the FFV1-and-composite path. The full
  PIP 60-minute gate completed in 25.75 minutes with eight workers, 108,000
  exact frames, and clean scratch.
- The fast path writes no FFV1 files and no PNG sequences for qualifying
  segments.
- A dual-pipe failure aborts both FFmpeg inputs and discards both sessions;
  frame counts are checked per layer before publication.
- Windows and non-qualifying segments keep the existing deterministic path, so
  the capture-pixel guarantee is unchanged.
- Tests cover two full-frame compositions with a transparent overlay over a
  non-black background, plus the full timeline rendering suite.
