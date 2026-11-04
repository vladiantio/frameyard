# Common mistakes

## Using the old authoring model

- **JavaScript composition modules / `defineComposition`** were removed in 0.4. A composition is a `.html` fragment listed in `video.config.js`.
- **`data-frameyard-*`** media attributes were removed in 0.4. Use `data-fy-*`.

## Document structure

- Adding `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`; compositions are fragments and the framework owns the shell (`COMPOSITION_DOCUMENT_SHELL`).
- Missing/multiple `<fy-composition>` roots, a root nested inside another element, or missing `duration-in-frames` on an animated composition. `width`, `height`, and `fps` may be omitted when the project declares `format`, but declaring only one of `width` and `height` is an error.
- Forgetting both `duration-in-frames` and `fps` on a composition that should animate; that composition is now static and renders to PNG. Declaring `fps` without `duration-in-frames` is an error.
- Rendering a composition that declares no dimensions in a project without `format`; add `width`/`height` or the project `format` (`COMPOSITION_FORMAT_UNRESOLVED`).
- Missing the top-level `data-fy="props"` block when the composition relies on default props; a nested props block is rejected.
- Putting props, the controller, or an import map inside `<fy-composition>` instead of at the top level.
- Using the reserved `data-fy-host` attribute or `data-fy="format"` block.
- Declaring an import map with `frameyard` or `frameyard/` specifiers; those are reserved (`IMPORT_MAP_INVALID`).
- Visual content outside `<fy-composition>`; it is not captured.
- Using `<base>`, refresh/CSP meta tags, `<iframe>`, `<object>`, or `<embed>`.

## Bindings

- Unknown `data-fy-*` attribute, usually a typo such as `data-fy-txt`.
- A binding path that does not exist in the resolved props. Check the `BINDING_PATH_MISSING` warning and its suggestion.
- Using `data-fy-repeat` on a normal element instead of `<template>`.
- Nesting `data-fy-repeat`; use a controller for nested data.
- Putting `data-fy-if` or `data-fy-text` on a repeat template.
- Putting `data-fy-text` on an `<img>` or another void element.
- Expecting bindings to update every frame or to re-bind controller-created DOM.

## Timing

- Writing seconds where frames are required, or frames where seconds are required.
  - `data-fy-start` and `data-fy-anim-start`/`duration` are frames.
  - `data-fy-trim`/`duration` are seconds.
- Using CSS `animation-delay`/`duration` in seconds and expecting the declarative scheduler to ignore its own attributes. `data-fy-anim-*` overrides the shorthand's delay/duration.
- Adding `data-fy-anim-*` without a CSS animation; this produces `ANIMATION_NOT_FOUND`.
- Using multiple animations on an element with one declarative schedule.

## Controllers

- Declaring both inline source and `src` on the same controller.
- Declaring more than one controller.
- Making `update()` async; do asynchronous work in `mount()`.
- Leaving module-scope state behind in `dispose()`.
- Writing a literal `</script>` inside inline controller source; escape it.
- Importing libraries from executable `<script>` tags; import them from the controller instead.
- Using `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions.

## Media and transcripts

- Using remote, live, or unseekable media sources.
- Using `<source>` or `<track>` children; use a local `src` and `<fy-transcript>`.
- Adding or changing media in `update()`; prepare it in the fragment or in `mount()`.
- Calling `play()`, `pause()`, or setting `currentTime` on a video.
- Assuming media/transcript `src` is document-relative. It is project-root-relative.
- Assuming the controller `src` is project-root-relative. It is relative to the composition URL.

## Timelines

- Putting `blend` on an audio clip. It is only valid on visual clips.
- Using `hue`, `saturation`, `color`, or `luminosity`. They need cross-channel math and are rejected; use one of the separable CSS modes.
- Expecting a blend on a transparent nested timeline to see the parent's layers. A nested timeline is its own document and blends only against its own backdrop.
- Expecting a blend on a composition with an opaque background to reach lower tracks. The composition's alpha is opaque; leave its background transparent.
- Expecting preview and final render blend pixels to match exactly. CSS is the reference and FFmpeg approximates it; the guarantee is at clip capture.
- Omitting `duration` on a static composition clip, or setting `sourceIn` above 0. A static source has no intrinsic duration or frames.
- Expecting a static composition clip to contribute audio or transcripts. It is visual-only.

## Timeline keyframes

- Treating `frame` as a timeline frame or a source frame. Keyframe frames are clip-local; `0` is the clip start boundary and `duration` is the end boundary.
- Expecting keyframes to extend a clip. A key past `duration` is a `TIMELINE_CLIP_OUT_OF_RANGE` error; declare a longer clip instead.
- Declaring the same channel as a scalar in `transform` and as a keyframe track. Keyed channels and static channels are separate; defaults do not conflict.
- Combining `keyframes.scale` with a `transform.width`/`height` box. Use a keyed scale without a box, or keep the box and animate `x`, `y`, `rotation`, and `opacity`.
- Putting keyframes on an audio clip. Only visual clips have presentation channels.
- Using seconds instead of integer clip-local frames, or putting keys out of order.
- Expecting the final key’s `easing` to do anything. Easing belongs to the interval after a key; the last key has no following interval.
- Expecting preview and encoded keyframe motion to match exactly. Preview uses the exact CSS curve; production approximates it in FFmpeg and may differ by a subpixel.
- Expecting an animated `blend` mode. Blend remains static; only `opacity` can animate the layer’s contribution to a blend.

## Static compositions

- Expecting `update()` or `--fy-*` frame-state variables to run. A static composition only runs `mount()` and prop validation; use CSS, markup, or mount-time canvas drawing.
- Adding `data-fy-anim-*`, `<video>`, `<audio>`, or `<fy-transcript>` to a static composition. These are `STATIC_ANIMATION_UNSUPPORTED` or `STATIC_MEDIA_UNSUPPORTED`.
- Relying on CSS animations or transitions at capture time; they are paused at 0 with `STATIC_ANIMATION_PAUSED`.
- Passing `--container`, `--codec`, `--encoder`, or `--concurrency` to `render` for a static composition. Use a timeline image clip if the deliverable must be video.
- Requesting a still frame other than 0 from a static composition.

## Validation

- Replacing `check` with a single `still`.
- Using `still` as an image-sequence exporter, adding `--step`-style workflows, or requesting more than 32 unique frames in one call.
- Ignoring warnings or `diagnostics` in `--json` output.
- Claiming success after a nonzero exit, a missing still, or skipped visual inspection.
- Using `--overwrite` or `--force` without permission.
