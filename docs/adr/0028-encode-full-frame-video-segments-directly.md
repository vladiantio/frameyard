# Encode full-frame video segments directly

**Status:** Accepted. Extends [ADR-0027](./0027-encode-two-full-frame-layers-through-dual-pipes.md).
**Date:** 2026-11-06

A segment with one full-frame video layer, an identity transform, and an opaque
timeline background now decodes and re-encodes the source range directly into
the delivery segment. It skips the background overlay, fit, presentation, and
composite filter graph, but keeps the same delivery encoder and container as
every other segment.

## Context

The representative 60-minute 50/50 gate contains 24 seconds per minute of
full-frame video on a single track. The composite path still built a color
background, overlaid the video, normalized timestamps, fitted the frame, and
then encoded. The video source already matches the stage, so those filters are
identity work except for the fps/format normalization.

Stream-copy was considered and deferred: it requires keyframe alignment, matching
codec parameters, and a concat-compatible bitstream across composition and media
segments. A direct re-encode avoids those risks while removing the composite
overhead.

## Decision

- `encodeVideoSegmentDirect` seeks to the clip's source start, maps the first
  video stream, drops audio, applies
  `fps=<project fps>,format=rgba,format=yuv420p`, and encodes with the normal
  delivery encoder/container settings. The RGBA round trip preserves the
  composite path's color conversion and keeps decoded pixels identical.
- The fast path requires one visual layer whose source is a video matching the
  stage dimensions, an identity transform, and no keyframes, blend, transition,
  or opacity. The timeline background must be opaque.
- `FRAMEYARD_DISABLE_VIDEO_DIRECT=1` forces the composite path for A/B
  measurements.
- Video with transforms, opacity, overlays, keyframes, transitions, or a
  non-matching source/stage size keeps the composite path. Composition and
  nested-timeline segments are unaffected.

## Considered Options

- **Stream-copy the video range.** Deferred: keyframe alignment and mixed-codec
  concat compatibility need a larger probe and validation surface. A direct
  re-encode reaches the target without that risk.
- **Keep the composite graph.** Rejected for this case: the background, fit, and
  presentation filters are identity work for a full-frame video.
- **Use the dual-pipe path.** Not applicable: there is only one visual layer.

## Consequences

- Full-frame video segments still re-encode, so every delivered segment shares
  the same codec, profile, and container settings. The conformance risk is lower
  than stream-copy.
- The representative 60-minute 50/50 gate drops the composite path for its
  single-video seconds while retaining it for overlays, PIP, images, and
  multi-layer segments.
- A 60-second full-frame video-only gate fell from 10.65 s to 7.61 s (−28.5%)
  with pixel-identical decoded frames.
- The representative 60-minute 50/50 gate fell from 16.82 to 15.57 minutes
  (−7.4%) with 180 direct video segments, exact 108,000 frames, clean scratch,
  and a byte-identical output file.
- Tests cover a full-frame video timeline through the direct path and the
  existing media/blend/keyframe/timeline suites.
- The fast path is internal; there is no CLI or JSON contract change.
