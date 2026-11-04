# Migrating to Frameyard 0.8

0.8 changes compositions from full HTML documents to partial HTML fragments and adds static (timeless) compositions. The framework generates the document shell, import map, sizing style, format block, and host runtime. Timelines, props files, audio, transcripts, and media keep their existing model; the CLI adds PNG output for static compositions and discriminated result kinds.

## Why

Every composition used to repeat `<!doctype html>`, `<html>`, `<head>`, `<meta charset>`, and `<body>`, and the author owned a `<head>` that the server already injected into. The fragment model keeps the same URLs, CSS, and relative asset behavior while making the framework responsible for the shell.

## Before and after

Before:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">
    { "title": "Hello" }
    </script>
    <style>
      #title { animation: fade-up 1s ease-out both; }
    </style>
    <script type="importmap">
    { "imports": { "demo-lib": "./demo-lib.js" } }
    </script>
  </head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
      <h1 id="title" data-fy-text="title"></h1>
    </fy-composition>
    <script type="text/fy-controller" src="./hello.controller.js"></script>
  </body>
</html>
```

After:

```html
<script type="application/json" data-fy="props">
{ "title": "Hello" }
</script>
<style>
  #title { animation: fade-up 1s ease-out both; }
</style>
<script type="importmap">
{ "imports": { "demo-lib": "./demo-lib.js" } }
</script>
<fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
  <h1 id="title" data-fy-text="title"></h1>
</fy-composition>
<script type="text/fy-controller" src="./hello.controller.js"></script>
```

The fragment is the content that used to live in `<body>`, plus the head elements that remain author-owned: props, styles, stylesheet links, import maps, and the controller.

## Rules

- Keep exactly one `<fy-composition>` element. It must be a top-level element, not nested in a `<div>`, `<template>`, or other element.
- Keep the props block, the controller, and import maps at the top level. They are metadata, not visual content.
- Keep `<style>` and `<link rel="stylesheet">` at the top level or inside the root. Top-level styles are hoisted into the generated head in source order; styles inside the root stay in the body.
- Do not add `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`. A legacy document reports `COMPOSITION_DOCUMENT_SHELL`.
- Do not use `data-fy-host` or `data-fy="format"`; both are reserved for framework-injected markup.
- An import map must be a top-level `<script type="importmap">` with a JSON object. `frameyard` and `frameyard/` specifiers are reserved. Invalid maps report `IMPORT_MAP_INVALID`.
- `.html` is still the composition extension. `project.json` still reports `kind: "html"` and `entry` as the fragment path.
- Composition URLs, relative controller `src`, relative asset URLs, media paths, and transcript paths keep their existing resolution rules.

## If the root was nested

Move the root to the top level and move the wrapper's styling into the root or into a top-level `<style>`:

Before:

```html
<body>
  <div class="page">
    <fy-composition duration-in-frames="150">...</fy-composition>
  </div>
</body>
```

After:

```html
<fy-composition duration-in-frames="150">
  <div class="page">...</div>
</fy-composition>
```

## Static compositions

A composition that declares neither `duration-in-frames` nor `fps` is now
static. It is captured once and `render <id>` writes `out/<id>.png`.

If a composition was failing because `duration-in-frames` was missing, decide
which behavior you intended:

- For a still, remove `fps` too and use the composition directly or as a
  timeline image clip.
- For video, add both `duration-in-frames` and `fps` (or let `fps` inherit from
  the project `format`). Declaring `fps` without `duration-in-frames` remains an
  error.

A static composition needs width and height, declared on the root or inherited
from the project `format`. It is visual-only: `<img>`, CSS, SVG, and canvas are
allowed; `<video>`, `<audio>`, and `<fy-transcript>` are validation errors. Its
controller may use `mount()` and `validateProps()`, but `update()` is not called
and frame-state variables are not set. Put audio, video, and captions on a
timeline instead.

`render` for a static composition rejects `--container`, `--codec`,
`--encoder`, and `--concurrency`. Use a timeline with an image/static
composition clip when the deliverable must be a video.

## Static timeline clips

A clip whose composition source is static behaves like an image clip:

- `duration` is required;
- `sourceIn` must be `0`;
- `props`, transform, opacity, and blend mode still apply;
- the clip contributes no audio or transcripts.

The renderer captures one transparent PNG per composition/props pair and reuses
it across segments.

## JSON result kinds

`render` now returns a discriminated union. Video results keep their fields and
add `kind: "video"`. Static composition results add `kind: "image"` with
`path`, `width`, `height`, `bytes`, `diagnostics`, and `elapsedMs`; they have no
`fps`, `durationInFrames`, `framesRendered`, `codec`, `container`, `encoder`, or
audio/transcript fields.

`check` also returns a union. Animated results add `kind: "animated"`. Static
results use `kind: "static"`, `metadata: { width, height, static: true }`,
`framesChecked: 1`, and no audio/transcript fields.

`still` on a static composition accepts only frame `0`; other frames fail with
`FRAME_OUT_OF_RANGE`.

Library consumers also see a type change: `FrameyardHost.metadata`,
`CompositionSourceInfo.metadata`, and browser sessions now expose
`ResolvedCompositionMetadata`, a union of animated metadata and
`{ width, height, static: true }`. Narrow with `metadata.static === true`
before reading `fps` or `durationInFrames`.

## Error codes

- `COMPOSITION_DOCUMENT_SHELL`: remove the document shell. The diagnostic includes the element and line.
- `IMPORT_MAP_INVALID`: fix the import map placement, JSON, attributes, or reserved specifier.
- `PROPS_INVALID` / `CONTROLLER_INVALID`: move the block to the top level and keep exactly one controller.
- `COMPOSITION_INVALID`: the root is missing, duplicated, or nested, or `fps` is declared without `duration-in-frames`.
- `STATIC_ANIMATION_UNSUPPORTED`: remove `data-fy-anim-*` or declare `duration-in-frames` and `fps`.
- `STATIC_MEDIA_UNSUPPORTED`: move video, audio, or transcripts to a timeline, or declare time metadata.
- `STATIC_UPDATE_IGNORED`: move static initialization from `update()` to `mount()`.
- `STATIC_ANIMATION_PAUSED`: remove CSS animations/transitions from a static composition; capture uses time 0.

`check`, `still`, and `render` run the same validation before Chromium. Run `npx frameyard check <id> --json` after editing each composition.

## No migration command

0.8 does not ship a migration command. The transformation is mechanical but depends on what the old `<head>` contained and whether the root was nested. Use this guide, migrate one composition at a time, and let `check` report the remaining structural errors.
