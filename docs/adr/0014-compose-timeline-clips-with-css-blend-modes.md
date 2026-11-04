# Compose timeline clips with CSS blend modes

**Status:** Accepted
**Date:** 2026-11-03
**Amended by:** [ADR-0018](0018-animate-timeline-clips-with-keyframes.md) (clip keyframes; blend modes remain static)

Visual timeline clips may declare a static `blend` mode. The mode is a CSS `mix-blend-mode` value and composites the clip against the accumulated backdrop of all lower layers and the timeline background. The clip's source alpha gates the blend: transparent pixels leave the backdrop unchanged. The supported modes are `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, and `exclusion`. `hue`, `saturation`, `color`, and `luminosity` require cross-channel math and are rejected at validation. `blend` is a top-level clip field, omitted means `normal`, and the timeline document stays at version 1.

Preview applies `mix-blend-mode` to the clip's DOM wrapper. Production applies FFmpeg's `blend` filter with the source alpha mask, then composites the blended result source-over. Chromium/CSS is the reference; FFmpeg is an approximation. The existing guarantee remains: parity is at clip capture, not at the final encoded pixel. Blend modes are static; there are no animated blend modes.

## Context

Timeline rendering already supports static transforms and opacity. Blend modes are the natural next compositing feature, and the preview and production paths need the same semantics. FFmpeg's native `blend` is not alpha-aware: a transparent source pixel would replace the backdrop. The compositor therefore has to place the layer on a stage-sized transparent canvas, blend it with the backdrop, use the source alpha as a mask, and then composite normally. The alpha-correct recipe costs roughly 1.7× per blended 1080p layer in a micro-benchmark.

CSS and FFmpeg differ in a few places. FFmpeg's `soft-light` uses a legacy formula, so the W3C piecewise formula is supplied as a per-component expression. `color-dodge` and `color-burn` need the source as blend input #0; `overlay` and `hard-light` need the backdrop first. The separable modes otherwise match CSS within roughly 2/255 in 8-bit sRGB.

Preview layer order previously followed document/first-activation order, while production follows track order. Blend modes make that divergence visible, so preview now stacks by track and isolates the stage. Blending never crosses an iframe boundary; a nested timeline is its own document.

## Considered Options

- **Preview-only blend modes.** Rejected: the preview would lie about the final output.
- **Blend the whole clip box as opaque.** Rejected: transparent compositions, `contain` letterboxing, and rotated edges would paint over the backdrop instead of leaving it intact.
- **Isolate each track into a group before blending.** Rejected: tracks are flat ordering, and track groups would change the existing compositing model. The backdrop is everything below the clip in the stage.
- **Inject a black backdrop into transparent nested timelines.** Rejected: a nested timeline with no declared background has no backdrop by definition. Authors who want internal blending against a color declare a background; authors who want the group to blend with the parent put `blend` on the nested clip.
- **Warn when a composition paints an opaque background.** Rejected: detecting the effective background is heuristic, and an opaque composition is a legitimate choice. The limitation is documented.
- **Implement the four non-separable modes with custom expressions.** Rejected for now: they need cross-channel math and would complicate the filter graph and validation for little gain.
- **Move compositing to Skia to preserve capture pixels.** Rejected for this change: ADR 0012 left Skia as a future option, but FFmpeg meets the blend requirement at an acceptable cost.

## Consequences

- The FFmpeg recipe for one blended layer is: place the fitted/transformed layer on a transparent stage-sized canvas; `split` the canvas into blend and mask copies; `split` the backdrop into blend, mask, and final-composite copies; extract the backdrop alpha; `blend` the placed layer with the backdrop; `maskedmerge` the blended RGB with the source alpha; `overlay` the result source-over the original backdrop. The final alpha is the source alpha.
- Blend modes apply to all visual sources: composition, nested timeline, video, and image. A nested timeline blends as a flattened group; a blend inside it sees only that timeline's own backdrop.
- An opaque composition or nested background blocks lower layers, exactly as its alpha implies. A transparent composition or nested timeline lets the backdrop through.
- The preview stage gets `isolation: isolate`, and preview layers stack by track index. Blend modes never reach the preview chrome.
- `check` validates the mode statically. `still` and `render` share the same composite graph. A blend mode that is unsupported or applied to an audio clip is a `TIMELINE_CLIP_INVALID` error.
- Tests cover every supported mode against the CSS formula with a 3/255 tolerance, source alpha with transparent and semi-transparent regions, stacked blended layers, opacity and offset boxes, preview stacking and `mix-blend-mode`, preview-versus-still parity for screen and multiply, end-to-end composition, video, image, and nested-timeline layers, transparent-nested isolation, and composition layers across independent segments.
- The performance model gains a per-blended-layer cost. The alpha-correct recipe is used unconditionally; an opaque-backdrop fast path is deferred until the representative benchmark shows the 60-minute target needs it.
- Documentation lives in the design baseline, README, glossary, the official skill's timeline and common-mistakes references, and the scaffold guide. The timeline document version does not change.
