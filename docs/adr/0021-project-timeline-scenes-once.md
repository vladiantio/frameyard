# Project timeline scenes once for production and preview

**Status:** Accepted
**Date:** 2026-11-04

A timeline frame is produced from a **timeline scene**: the ordered active clips and their presentation at one timeline frame or over one render range, including transition roles and composite order. `src/timeline/scene.ts` is browser-safe and owns active-layer selection, transition pairing, stacking, capture-mode classification, and presentation defaults. `planTimelineRender` keeps segment splitting and projects each segment through the scene module; production capture, `check`, `still`, and preview consume the same projection. Capture sessions, FFmpeg, audio mapping, and both compositors stay outside the seam.

## Context

The planner, the segment renderer, the still renderer, the audio mapper, and the preview host each derived the active clip set, the frame-to-source mapping, transition roles, stacking, and presentation defaults. Recent timeline features made the fan-out visible: dissolve, crossfade, and keyframes each added another copy. The preview bypassed `planTimelineRender` entirely and re-derived the scene pointwise. The copies already disagreed on static-composition caching and on what `TimelineCompositeLayer.kind` meant.

ADR 0018 already requires one keyframe evaluator shared by production and preview, and ADR 0019 requires both paths to agree at the composite stage. This decision applies the same rule to layer selection and presentation, without merging the compositors or the capture lifecycle.

## Considered Options

- **A browser-safe scene projection (chosen).** One range-based module returns ordered scene layers with the resolved clip, normalized presentation, source start and size, capture mode, and transition window/role. A frame is a one-frame range. Production, `check`, `still`, and preview consume it; capture and audio mapping stay separate.
- **Projection plus capture/session ownership.** Fewer layers between resolve and pixels, but the module would absorb Chromium sessions, static-image caching, nested capture, and FFmpeg artifacts, making preview depend on production machinery.
- **Projection plus audio resolution.** One scene would drive both pixels and audio, but audio mapping would pull nested gain, mute, and media probing into the render-facing module before those concerns are ready to move.
- **Keep the per-consumer models and share only the transition map.** Smaller change, but frame mapping, defaults, capture mode, and stacking would still drift independently.
- **Precompute the preview scene on the server.** The preview needs arbitrary frames, so it would either ship one scene per frame or keep re-deriving the scene in the browser.

## Consequences

- `src/timeline/scene.ts` defines `TimelineScene`, `TimelineSceneLayer`, the capture modes `frames | still | video | image | nested`, and one transition pairing used by the scene and by timeline audio envelopes. Layers carry the resolved clip and materialized `transform`, `keyframes`, `blend`, `sourceStart`, source size, and transition role; array order is composite order.
- `planTimelineRender` keeps segment splitting, removes `TimelineRenderLayer`, and projects each segment through the scene. `TimelineRenderPlan` shrinks to the segment list.
- `TimelineCompositeLayer` keeps its narrow FFmpeg shape but replaces the overloaded `kind` with an `input` mode (`sequence | image | video`). One mapper builds it from a scene layer plus the captured artifact.
- The preview payload becomes a serialized resolved timeline: clips keep the resolved shape, sources gain a `url`, and absolute paths are stripped. The browser host calls the scene projection on every seek. `TimelinePreviewClip` stops being a parallel model; the precomputed transitions array disappears.
- Nested timelines remain groups. The scene projects one timeline level; capture recurses into a nested source's own scene.
- Static-image caching keeps its current behavior during this change. Cache ownership moves with the capture pipeline, not with the scene projection.
- Projection errors are `FrameyardError`s carrying the clip or range context; the module does not return diagnostics because resolution already owns them.
- Tests target `test/timeline-scene.test.ts` for active layers, transition roles, stacking, frame-to-source mapping, capture modes, source sizes, and defaults. Plan tests keep segment splitting; render and preview tests keep pixels.
- No pixel behavior is intended to change. Preview and production still composite in different engines; parity remains at clip capture.
