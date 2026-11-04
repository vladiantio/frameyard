# Animate timeline clips with keyframes

**Status:** Accepted
**Date:** 2026-11-04

Visual timeline clips may animate `x`, `y`, `scale`, `rotation`, and `opacity` through a top-level `keyframes` object. Each channel is an ordered array of `{ frame, value, easing? }` entries in clip-local integer frames. Keys hold before the first and after the last key, never extend the clip, and use a CSS timing function on the interval after each key. A channel cannot also be an explicit scalar in `transform`, and `keyframes.scale` cannot be combined with a `transform.width`/`height` box. The timeline document version remains 1.

Preview evaluates the CSS timing function exactly on every seek. Production generates per-frame FFmpeg expressions from the same browser-safe evaluator; position, scale, and rotation use filter expressions, and animated opacity uses an alpha mask applied before blend-mode compositing. Easing curves in the filter graph approximate the CSS curve; parity remains at clip capture, not at the final encoded pixel. `check` evaluates every keyframe channel at every timeline frame. The read-only preview shows merged keyframe markers and seeks from them.

## Context

Timelines had static transforms and static blend modes; keyframes were explicitly deferred by ADR 0010. The render unit is a segmented FFmpeg composite, and ADR 0012's performance model depends on not capturing every layer frame through Chromium. Animation therefore has to be expressed in the FFmpeg graph, not by adding a second per-frame compositor. At the same time, the preview is the authoring reference, so both paths need one definition of frame sampling and easing.

## Considered Options

- **Whole-transform keyframe snapshots.** More ergonomic for coordinated moves, but every key needs a rule for omitted channels, and the rule is ambiguous. Per-channel tracks make "keyed or static" explicit and map directly to preview styles and filter parameters.
- **A separate animation document or named presets.** Adds a reference namespace, resolution, and cross-clip coupling. Inline tracks keep a clip self-contained; presets can be added later without breaking inline tracks.
- **Source-relative or absolute timeline frames.** Source-relative time preserves animation phase across slips but makes trims confusing. Absolute timeline frames decouple animation from clip placement. Clip-local frames keep the animation with the clip and leave `sourceIn` as a pure media-content selector.
- **Arbitrary expression values.** A formula language would add determinism, validation, and preview-parity risk. Values stay JSON numbers; complex motion belongs in a composition controller.
- **Composite keyframed clips in Chromium or software per frame.** Better preview parity, but a second production compositor and a large throughput cost. FFmpeg expressions keep one path and the existing segmentation model.
- **Allow animated blend modes or audio gain.** Blend modes are discrete and not interpolable; audio fades are a separate contract. Both remain deferred.
- **Constrain easing to `linear` and `hold` or to named curves only.** The composition runtime already speaks CSS easing, and preview can evaluate it exactly. The filter graph approximates any supported curve with an adaptive Hermite expression within a fixed error budget.

## Consequences

- Clip keyframes are part of the timeline schema and resolved clips. Structural errors use `TIMELINE_CLIP_INVALID`; keys outside the resolved duration use `TIMELINE_CLIP_OUT_OF_RANGE`, with clip, track, channel, key index, frame, and JSON path details.
- `opacity` is clamped to `0..1` and `scale` to `>= 0` after easing. Position and rotation may overshoot. A zero-scale frame is invisible; the scale filter uses a zero-safe expression and the opacity mask gates it.
- Animated opacity and animated scale add a small alpha-mask pass at the fitted box size. The mask is generated from a 1×1 per-frame source and multiplied into the layer alpha, so blend modes see the animated source alpha. No stage-sized mask is added for normal layers.
- FFmpeg's rotate filter clips to a fixed output size. Static rotation uses the exact rotated bounding box; keyed rotation uses the diagonal of the fitted box, which is segment-stable and large enough for every angle. The filter fills the remaining area with transparent pixels, so rotation no longer cuts off corners.
- Segments are never split at keyframe boundaries. Values are evaluated against absolute timeline frames, so changing `maxSegmentFrames` or worker count does not change a frame's keyframe values.
- Production expressions are exact at keyframe frames and within 1/255 opacity, 0.5 px position, 0.1% scale, and 0.1° rotation of the shared evaluator between keys. Encoded output keeps the existing scaling, alpha, and color-conversion differences.
- `check` adds a per-frame keyframe sweep without capturing or encoding. `still` and `render` share the same composite path and `frameOffset`.
- The preview draws one marker per distinct keyframe frame across channels, with a channel/value tooltip and click-to-seek. It does not add an editing UI or keyframe manipulation.
- Timeline documents remain version 1; keyframes are additive. Documentation covers the contract, validation, preview markers, and the production approximation. The reference example is `examples/keyframes`.
- Performance is measured with a keyframed fixture; no hard CI ratio is enforced.
