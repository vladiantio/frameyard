# Diagnostics

Frameyard reports composition problems as structured diagnostics before and during frame production.

## Static validation

`check`, `still`, and `render` run a Node-side static composition validation before launching Chromium. `dev` runs it when a composition is requested. Static errors fail the command without starting a browser; warnings allow frame evaluation.

Static validation covers:

- doctype, root count, metadata, and default-props JSON
- controller declaration and file existence
- executable scripts, `on*` handlers, `javascript:` URLs, and unsupported visual elements
- unknown `data-fy-*` attributes, binding paths, `if`/`repeat` placement, and animation attributes
- audio/video/transcript references and ordinary image/stylesheet assets
- visual content outside `<fy-composition>`

## Diagnostic shape

```json
{
  "severity": "warning",
  "code": "BINDING_PATH_MISSING",
  "message": "data-fy-text references prop \"titel\", which is not in the resolved props.",
  "details": {
    "path": "compositions/hello.html",
    "line": 12,
    "column": 5,
    "element": "h1",
    "attribute": "data-fy-text",
    "value": "titel",
    "suggestion": "title"
  }
}
```

`details` may include `path`, `line`, `column`, `endLine`, `endColumn`, `element`, `attribute`, `value`, `suggestion`, `frame`, and `controller`.

## Common codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `COMPOSITION_INVALID` | error | Missing/invalid doctype, root, metadata, or document structure |
| `PROPS_INVALID` | error | Invalid default props JSON, invalid overrides, or `validateProps` failure |
| `CONTROLLER_INVALID` | error | Missing/duplicate/both-inline-and-external controller, missing file, or invalid exports |
| `BINDING_INVALID` | error | Unknown `data-fy-*` attribute or malformed binding path |
| `BINDING_PATH_MISSING` | warning | A binding path is absent from the resolved props |
| `BINDING_VALUE_INVALID` | warning | A text/attribute/class binding resolved to an object or array |
| `BINDING_REPEAT_INVALID` | error | Repeat is not on `<template>`, or its path is missing/not an array |
| `BINDING_REPEAT_NESTED` | error | Nested `data-fy-repeat` |
| `BINDING_TARGET_INVALID` | error | `data-fy-text` on a void element or the root; invalid binding target |
| `ANIMATION_INVALID` | error | Invalid `data-fy-anim-*` value |
| `ANIMATION_NOT_FOUND` | warning | `data-fy-anim-*` is present but the element has no CSS animation |
| `ANIMATION_MULTIPLE` | warning | Multiple animations on one declaratively scheduled element |
| `SCRIPT_NOT_ALLOWED` | error | Executable `<script>` other than the controller |
| `EVENT_HANDLER_NOT_ALLOWED` | error | Inline `on*` handler or `data-fy-attr-on*` |
| `URL_NOT_ALLOWED` | error | `javascript:` URL |
| `ELEMENT_NOT_SUPPORTED` | error | `iframe`, `object`, `embed`, `base`, refresh/CSP meta, `source`, `track`, or declarative shadow DOM |
| `ELEMENT_UNKNOWN` | warning | Unknown `fy-*` element |
| `CONTENT_OUTSIDE_ROOT` | warning | Visual content outside `<fy-composition>` |
| `MEDIA_INVALID` | error | Invalid or missing audio/video source or attributes |
| `TRANSCRIPT_INVALID` | error | Invalid or missing transcript source |
| `ASSET_NOT_FOUND` | error | Missing image, stylesheet, media, or transcript file |
| `AUDIO_WARNING` | warning | Audio timeline overrun or silent embedded media |
| `TRANSCRIPT_WARNING` | warning | Empty transcript text or no timed segments |
| `DETERMINISM_WARNING` | warning | Forbidden clock/randomness, CSS transition, or runtime diagnostic |
| `COMPOSITION_NOT_READY` | error | `seek`/`settle` before a successful load |
| `COMPOSITION_DISPOSED` | error | Operation after the host was disposed |

## Results

`check`, `still`, and `render` JSON results expose:

- `entry`: project-relative HTML path
- `controller`: `{ kind: "inline" }`, `{ kind: "external", src }`, or `null`
- `diagnostics`: all static and runtime diagnostics, deduplicated

`check` also exposes `metadata`, `framesChecked`, `audio.details`, and `transcripts.details`. `still` exposes `frame`, `path`, `width`, and `height`. `render` exposes the output path, dimensions, frame count, concurrency, bytes, and audio/transcript clip counts.

Failures use the same envelope with `error.code`, `error.message`, optional `error.details`, and top-level `diagnostics`.

## Working with diagnostics

1. Run `npx frameyard check <id> --json`.
2. Read every error first; fix the first one and rerun.
3. Treat warnings as actionable. `BINDING_PATH_MISSING` is usually a typo; use the `suggestion` field.
4. Use `details.path`, `line`, and `column` to edit the exact source.
5. Re-run `check`, inspect representative stills, then render.

Do not ignore a failing `check`, a missing still, or a nonzero render. Do not describe visual correctness you did not inspect.
