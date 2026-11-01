# Composite production frames in software

**Status:** Accepted. Extended by [ADR-0011](./0011-compose-timeline-frames-in-a-live-browser-host.md): timeline frames use the same software-composited capture path.
**Date:** 2026-10-30

Production Chromium sessions keep ANGLE pinned to SwiftShader for WebGL but add
`--disable-gpu-compositing`. Frame production is already fully software and
frame-seeked; routing every captured frame through GPU-process compositing adds
a fixed copy and synchronization cost without improving determinism. Software
compositing keeps WebGL canvases on SwiftShader while removing that round trip.
Capture remains a `Page.captureScreenshot` of the composition viewport, so the
frame, media-settle, and PNG output contracts are unchanged.

## Considered Options

- **Keep GPU-process compositing.** Rejected after measurement: the 1080p demo
  rendered about 1.4x slower sequentially and 2.3x slower with
  `--concurrency 4` on the reference machine.
- **Disable the GPU entirely.** Rejected because `--disable-gpu` also removes
  the SwiftShader path that keeps WebGL pixels independent of the host GPU.
- **Choose the compositor per composition.** Rejected because WebGL still works
  through software compositing and the extra static signal would widen the
  public composition contract. The benchmark's 1080p WebGL shader fixture pays
  a modest capture penalty (roughly 0-25%) with software compositing, while
  video and 2D capture costs improve substantially.

## Consequences

- Captured 2D pixels come from the software compositor; WebGL pixels still come
  from the pinned SwiftShader rasterizer.
- Parallel rendering scales better because each session no longer serializes
  captures through its GPU process.
- The benchmark includes WebGL and video fixtures so the composition-specific
  tradeoff stays visible; run `pnpm bench --fixtures` for current numbers.
- Capture timing and pixels can change for existing projects. The
  reproducibility guarantee remains at the capture boundary for the same
  pinned runtime and inputs; run `pnpm bench` for current timings.
