# Capture renders at the scaled source format

**Status:** Accepted. Extends [ADR-0024](./0024-stream-composition-captures-and-skip-trivial-composites.md), [ADR-0026](./0026-reuse-loaded-composition-sessions-across-segments.md), [ADR-0027](./0027-encode-two-full-frame-layers-through-dual-pipes.md), and [ADR-0028](./0028-encode-full-frame-video-segments-directly.md).
**Date:** 2026-11-08

`render --scale` now rasterizes composition captures at the scaled pixel density
and sizes the timeline stage to the scaled format. Captured PNGs, FFV1
intermediates, and delivery segments are produced at the output resolution, and
the final encode-time scale pass is gone. The browser keeps the authored
viewport; a CDP device-metrics override changes the device pixel ratio, and a
capture clip trims the result to even delivery dimensions.

## Context

The previous implementation captured at the composition format and applied
`renderScaleFilter` in `startVideoEncoder`, `muxVideoWithAudio`, and
`scaleVideoFile`. That left the full-resolution capture, FFV1, and composite
cost in place and added a final re-encode or a scale filter to the delivery
encoder. The goal is to capture at the scaled source format instead.

The change has to preserve four things at once:

- The visual result is a uniform downscale of the authored composition, not a
  reflow at a smaller layout.
- The authored viewport stays intact: `vw`/`vh`, percentage sizing, and media
  queries must see the composition format, not the output format.
- Captured PNGs and encoded segments stay even-sized for delivery codecs.
- Transparent captures, session reuse, the direct composition/dual-pipe/direct
  video fast paths, and audio muxing keep working.

The browser behavior was the key constraint. In this environment,
`newContext({ deviceScaleFactor })` changes `window.devicePixelRatio` but
`Page.captureScreenshot` still returns the CSS-pixel size. Playwright's
`page.screenshot` also returns the CSS-pixel size. Sending
`Emulation.setDeviceMetricsOverride` on the same CDP session used for capture
does produce the scaled surface, and `Page.captureScreenshot` with a CSS-pixel
`clip` produces exact output dimensions.

## Decision

- `openCompositionSession({ scale })` keeps the context viewport at the
  composition metadata width and height. For `scale !== 1` it sends
  `Emulation.setDeviceMetricsOverride` with the source dimensions,
  `deviceScaleFactor: scale`, `mobile: false`, and matching screen dimensions.
  Capture uses `Page.captureScreenshot` with a clip of
  `capture.width / scale` by `capture.height / scale`, so the resulting PNG is
  exactly the even delivery size. `scale: 1` sends no override and no clip.
- `scaledCaptureDimensions` returns the source dimensions at scale 1 and the
  even, minimum-two `scaledVideoDimensions` below 1. Composition render results
  use it; the timeline stage and captured artifacts use it. An odd composition
  at scale 1 now fails with `RENDER_FAILED` instead of claiming an even result
  while the capture stayed odd.
- Timeline segments compute the scaled stage once. Composition, nested-timeline,
  and static-composition captures receive `scale`; `sceneLayerToCompositeLayer`
  scales project-pixel `transform.x`/`y`, `transform.width`/`height`, and
  keyframe `x`/`y` values into the stage. The `scale` multiplier, rotation,
  opacity, fit, and transition frames are resolution-independent. Captured
  composition and nested artifacts override their source dimensions with
  `scaledCaptureDimensions`; video and image sources keep their natural
  dimensions and the fit filter scales them into the stage.
- The direct composition, dual-pipe, direct video, and FFV1 composite paths all
  use the scaled stage. `encodeVideoSegmentDirect` applies the media scale filter
  because it has no browser capture stage. `muxVideoWithAudio` stream-copies the
  video, and `scaleVideoFile` plus the encode-time scale options on
  `startVideoEncoder`/`muxVideoWithAudio` are removed.
- `CompositionSessionPool` keys include the capture scale, and the static
  composition cache key includes it. A render uses one scale, so these keys keep
  different scales from sharing a capture.
- Static compositions still reject `--scale`. `check`, `still`, and `--sequence`
  keep their existing size behavior.

## Considered Options

- **CSS transform on `html` with a scaled viewport.** Implemented first and
  rejected: `vw`/`vh` and media queries see the scaled viewport while the layout
  stays authored size. That hybrid changes authored semantics and complicates
  fixed positioning, and even rounding needs separate per-axis transforms.
- **Shrink the viewport to the scaled dimensions without a transform.** Rejected:
  the composition reflows at the smaller layout instead of scaling, so `100%`,
  `vw`, and media queries produce a different design.
- **Playwright `newContext({ deviceScaleFactor })` alone.** Rejected: it changes
  `window.devicePixelRatio`, but the raw CDP screenshot remains CSS-sized in this
  environment. The CDP device-metrics override is required.
- **Keep the full-resolution capture and scale during encode.** Rejected: it
  keeps the full-resolution capture, FFV1, and composite cost and the final
  re-encode that this change removes.
- **Crop or pad in FFmpeg after capture.** Rejected: the capture clip already
  produces exact even output without a post-processing pass.

## Consequences

- Composition PNGs, FFV1 intermediates, and delivery segments are produced at
  the output resolution. Audio muxing stream-copies the video, so there is no
  final scale pass.
- The authored viewport is preserved: `vw`/`vh`, percentage sizing, and media
  queries see the composition format. `window.devicePixelRatio` equals the scale,
  so fonts and vectors rasterize at the capture density.
- Scale below 1 rounds to even dimensions. Scale 1 keeps exact dimensions, so
  odd composition dimensions fail with a clear `RENDER_FAILED`.
- Full-frame video is the only path that scales during encode, because it has no
  browser capture stage. Composition and timeline captures do not.
- The session pool and static capture cache are keyed by capture scale. One
  render uses one scale.
- Tests cover the scaled composite path, direct composition, direct video,
  dual-pipe, nested timelines, static image layers, keyframed offsets and boxes,
  and odd-dimension rejection. The capture-probe recipe is in
  `docs/preview-testing.md`.
- Static compositions still reject `--scale`. There is no public contract change
  beyond the scaled output dimensions and the odd-dimension diagnostic.
