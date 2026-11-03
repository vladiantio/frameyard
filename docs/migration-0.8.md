# Migrating to Frameyard 0.8

0.8 changes compositions from full HTML documents to partial HTML fragments. The framework now generates the document shell, import map, sizing style, format block, and host runtime. Timelines, props files, audio, transcripts, the CLI, and the rendering pipeline are unchanged.

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

## Error codes

- `COMPOSITION_DOCUMENT_SHELL`: remove the document shell. The diagnostic includes the element and line.
- `IMPORT_MAP_INVALID`: fix the import map placement, JSON, attributes, or reserved specifier.
- `PROPS_INVALID` / `CONTROLLER_INVALID`: move the block to the top level and keep exactly one controller.
- `COMPOSITION_INVALID`: the root is missing, duplicated, or nested.

`check`, `still`, and `render` run the same validation before Chromium. Run `npx frameyard check <id> --json` after editing each composition.

## No migration command

0.8 does not ship a migration command. The transformation is mechanical but depends on what the old `<head>` contained and whether the root was nested. Use this guide, migrate one composition at a time, and let `check` report the remaining structural errors.
