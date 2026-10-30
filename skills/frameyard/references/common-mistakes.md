# Common mistakes

## Using the old authoring model

- **JavaScript composition modules / `defineComposition`** were removed in 0.4. A composition is a `.html` document listed in `video.config.js`.
- **`data-frameyard-*`** media attributes were removed in 0.4. Use `data-fy-*`.

## Document structure

- Missing `<!doctype html>` or missing/multiple `<fy-composition>` roots.
- Missing `width`, `height`, `fps`, or `duration-in-frames` on the root.
- Missing the `data-fy="props"` block when the composition relies on default props.
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
- Adding or changing media in `update()`; prepare it in the document or in `mount()`.
- Calling `play()`, `pause()`, or setting `currentTime` on a video.
- Assuming media/transcript `src` is document-relative. It is project-root-relative.
- Assuming the controller `src` is project-root-relative. It is document-relative.

## Validation

- Replacing `check` with a single `still`.
- Ignoring warnings or `diagnostics` in `--json` output.
- Claiming success after a nonzero exit, a missing still, or skipped visual inspection.
- Using `--overwrite` or `--force` without permission.
