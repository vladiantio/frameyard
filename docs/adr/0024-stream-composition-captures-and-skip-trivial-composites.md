# Stream composition captures and skip trivial composites

**Status:** Accepted. Extends [ADR-0012](./0012-render-timelines-with-segmented-lossless-clip-intermediates.md). Extended by [ADR-0025](./0025-capture-timeline-layers-in-parallel-with-a-global-limit.md): independent layers are captured concurrently under a global session limit. Extended by [ADR-0026](./0026-reuse-loaded-composition-sessions-across-segments.md): loaded sessions are reused across segments.
**Date:** 2026-11-06

The production timeline renderer will stream captured PNG buffers directly into
the lossless FFV1 encoder instead of writing a PNG sequence to scratch first. A
segment whose visual content is a single full-frame composition with no
transform, opacity, blend, transition, or keyframes will bypass the FFV1
intermediate and the FFmpeg composite entirely and encode the capture directly
into the delivery segment over the timeline background. All other segments keep
the segmented lossless path.

## Context

The 60-minute composition-only gate rendered 108,000 frames in 37.28 minutes
with four workers. Per-stage worker time was 48.9%
capture, 23.2% FFV1, 24.7% composite, and 2.8% session setup. The run wrote
15.52 GB of PNG intermediates, and the FFV1 stage added 8.64 minutes of wall
time at four workers. Capture itself was the floor: 92.6% of the capture loop
was `Page.captureScreenshot` plus PNG encoding.

The gate is a one-layer composition workload, so the FFV1 intermediate and the
composite are identity operations apart from painting the timeline background.
Streaming alone improved the 60-second gate from 43.27 seconds to 38.76
seconds, but CPU contention between four concurrent captures and four FFV1
encoders limited the gain. The direct path removes both stages for qualifying
segments.

## Decision

- `captureCompositionLayer` opens an FFV1 encoder before capture and writes
  each PNG buffer to its stdin. The encoder is bounded with
  `FRAMEYARD_FFV1_THREADS` (default 2; `0` uses FFmpeg's default) so concurrent
  captures retain CPU headroom.
- `processTimelineSegment` detects a single active composition layer whose
  source dimensions equal the stage, whose transform is the identity, and which
  has no keyframes, blend, transition, or opacity. It also requires an opaque
  timeline background. Such a segment uses `startDirectSegmentEncoder`, streams
  the capture into the delivery codec over a solid background, and skips
  `compositeTimelineSegment`.
- Static compositions, media layers, nested timelines, transformed or animated
  clips, blends, transitions, and transparent nested backgrounds keep the
  segmented lossless path. Nested timelines continue to use FFV1.

## Considered Options

- **Keep the file-based PNG sequence.** Rejected: it wrote 15.52 GB to scratch,
  serialized capture and FFV1, and spent 8.64 minutes of wall time on FFV1 at
  four workers.
- **Stream FFV1 only.** Accepted as the general path, but insufficient alone:
  the 60-second gate improved by only 10.4% because capture and FFV1 contend for
  CPU. It remains necessary for multi-layer and transformed segments.
- **Always encode directly and skip the composite.** Rejected: multi-layer,
  blended, keyframed, transformed, and nested segments need the FFmpeg
  compositor.
- **Use a GPU/Skia compositor.** Rejected for this change: the gate is capture
  bound, and GPU rasterization would not remove screenshot/PNG encoding. It
  would also complicate the capture-pixel reproducibility guarantee.
- **Parallelize layer capture first.** Deferred for this change: it helps
  multi-layer timelines but not the one-layer long-form gate. The measured
  60-second two-layer run improved only 5.1% from streaming (62.79 to 59.60
  seconds). ADR 0025 then captured independent layers concurrently and reduced
  that run to 43.78 seconds.

## Consequences

- A qualifying direct segment emits `timeline.segment.direct` instead of
  `timeline.segment.composite` in the opt-in stage timings.
- Direct segments are encoded once, without a lossless FFV1 round trip. The
  reproducibility guarantee remains at clip capture. For the 60-minute gate,
  the direct output is byte-identical to the FFV1-and-composite output
  (SHA-256 `02dab384...b6aab`).
- Scratch no longer contains per-frame PNG sequences. The 60-minute gate wrote
  no PNG files to disk; the 15.52 GB of PNG buffers went through memory and
  pipes. FFV1 files remain for non-direct segments.
- The 60-minute gate at eight workers completed in 19.83 minutes, 34% inside the
  30-minute target. ADR 0026 later reduced it to 18.78 minutes by reusing loaded
  sessions. At four workers the ten-minute gate projects about 24 minutes.
- Multi-layer segments keep the lossless path and still pay for FFV1 and the
  composite. ADR 0025 captures their independent layers concurrently; the
  two-layer 60-second run improved from 62.79 to 59.60 seconds with streaming
  and to 43.78 seconds with parallel layer capture.
- The direct path is covered by the timeline rendering suite, including a
  transparent full-frame composition over a non-black timeline background, and
  by the full 108,000-frame gate with an FFprobe frame-count check.
