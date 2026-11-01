# Compose timeline frames in a live browser host

**Status:** Superseded by [ADR-0012](./0012-render-timelines-with-segmented-lossless-clip-intermediates.md). Rejected for production in 0.6; retained as the preview model.
**Date:** 2026-10-31

> **Spike result (2026-10-31):** the host was deterministic (pixel-identical across seeks and sessions) and a one-clip host was pixel-identical to a direct composition capture, but a 1920×1080 30 fps timeline with four active layers averaged 138.8 ms/frame versus 33.6 ms/frame for a direct composition capture (4.1×). The project prioritizes long-timeline rendering throughput, so the live host is kept only as a preview candidate, not as the production compositor.

Timeline frames will be produced by a browser timeline host that loads every clip source as a layer and captures the composed stage. Composition and nested-timeline clips are same-origin iframes, media clips are video and image elements, and static clip transforms and opacity are CSS. For each timeline frame the host seeks only the active clips, waits for their settle, and the renderer captures the stage through CDP. Preview and production drive the same host, so the timeline output has one compositing path.

## Considered Options

- **Pre-render each clip and assemble with FFmpeg.** Rejected as the primary path because preview must composite live, so preview and render would diverge at scaling, opacity, and blending; intermediates also add generation loss or very large lossless files.
- **Capture each clip separately and composite PNG frames in Node.** Rejected because it is substantially slower per timeline frame and cannot use browser-native compositing; preview would still need a separate browser compositor.
- **Composite with CSS in the preview but pre-render for production.** Rejected for the same parity reason; the project's value is that preview and production execute the same behavior.

## Consequences

- Composition and nested-timeline clips are isolated iframe surfaces. CSS blend modes and backdrop filters cannot blend across clip boundaries; 0.6 has neither.
- The timeline host preloads all clip sources, then network is blocked for frame production. Memory and WebGL context use grow with the number of loaded clips; the spike must measure a representative timeline before this decision is accepted.
- Timeline rendering is sequential in 0.6. Composition rendering keeps opt-in concurrency.
- Audio is not played by the host; preview mixes timeline audio in the parent and production mixes it offline with FFmpeg.
- If the spike fails its cost budget, this ADR is revised before implementation; the timeline document contract does not depend on the compositor choice.
