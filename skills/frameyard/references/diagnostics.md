# Diagnostics

Frameyard reports composition problems as structured diagnostics before and during frame production.

## Static validation

`check`, `still`, and `render` run a Node-side static composition validation before launching Chromium. `dev` runs it when a composition is requested. Static errors fail the command without starting a browser; warnings allow frame evaluation.

Static validation covers:

- fragment structure, root count and placement, metadata (including `width`/`height` pairing), default-props JSON, and import maps
- controller declaration and file existence
- executable scripts, `on*` handlers, `javascript:` URLs, and unsupported visual elements
- unknown `data-fy-*` attributes, binding paths, `if`/`repeat` placement, and animation attributes
- audio/video/transcript references and ordinary image/stylesheet assets
- visual content outside `<fy-composition>`
- document-level `<title>`/`<meta>` elements, the reserved `data-fy-host` attribute, and non-top-level props, controllers, or import maps

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

`details` may include `path`, `line`, `column`, `endLine`, `endColumn`, `element`, `attribute`, `value`, `suggestion`, `frame`, and `controller`. Timeline diagnostics may also include `timeline`, `clip`, `track`, `channel`, `keyframe`, `jsonPath`, `timelineFrame`, `sourceFrame`, `from`, `to`, and `nesting`; keyframe errors use `channel`, the zero-based `keyframe` index, and the clip-local `frame`, and transition errors use `from`/`to`.

## Common codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `COMPOSITION_INVALID` | error | Missing/invalid root, metadata, fragment structure, or reserved attributes |
| `COMPOSITION_DOCUMENT_SHELL` | error | A full document shell (`<!doctype>`, `<html>`, `<head>`, or `<body>`) is present; compositions are fragments |
| `IMPORT_MAP_INVALID` | error | Invalid import map placement, JSON, attributes, or reserved `frameyard` specifiers |
| `COMPOSITION_FORMAT_UNRESOLVED` | error | The composition omits `width`/`height` and the project has no `format`; this is a command error, not a document diagnostic |
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
| `STATIC_ANIMATION_UNSUPPORTED` | error | A static composition uses `data-fy-anim-*`; remove it or declare `duration-in-frames` and `fps` |
| `STATIC_MEDIA_UNSUPPORTED` | error | A static composition declares `<video>`, `<audio>`, or `<fy-transcript>`; move media to a timeline |
| `STATIC_UPDATE_IGNORED` | warning | A static composition controller exports `update()`; move initialization into `mount()` |
| `STATIC_ANIMATION_PAUSED` | warning | A static composition has CSS animations/transitions; they are paused at time 0 |
| `SCRIPT_NOT_ALLOWED` | error | Executable `<script>` other than the controller |
| `EVENT_HANDLER_NOT_ALLOWED` | error | Inline `on*` handler or `data-fy-attr-on*` |
| `URL_NOT_ALLOWED` | error | `javascript:` URL |
| `ELEMENT_NOT_SUPPORTED` | error | `iframe`, `object`, `embed`, `base`, refresh/CSP meta, `source`, `track`, or declarative shadow DOM |
| `ELEMENT_UNKNOWN` | warning | Unknown `fy-*` element |
| `CONTENT_OUTSIDE_ROOT` | warning | Visual content outside `<fy-composition>` |
| `TIMELINE_TRANSITION_INVALID` | error | Unknown transition field, invalid clip id, or unsupported easing |
| `TIMELINE_TRANSITION_UNKNOWN_CLIP` | error | Transition names a missing or self clip |
| `TIMELINE_TRANSITION_WRONG_TRACK` | error | Transition clips are on different tracks |
| `TIMELINE_TRANSITION_AUDIO_TRACK` | error | A `dissolve` is declared on an audio track; use `crossfade` |
| `TIMELINE_TRANSITION_VIDEO_TRACK` | error | A `crossfade` is declared on a video track; use `dissolve` |
| `TIMELINE_TRANSITION_NOT_OVERLAPPING` | error | Declared transition has no overlap |
| `TIMELINE_TRANSITION_GEOMETRY` | error | Reversed order or the incoming clip ends before the outgoing clip |
| `TIMELINE_TRANSITION_DUPLICATE` | error | Repeated pair or a clip used twice on one side |
| `TIMELINE_TRANSITION_KIND` | error | Unsupported or missing transition `kind` |
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

`check` and `render` are discriminated unions. Animated/video results report `kind: "animated"` or `kind: "video"`; static composition results report `kind: "static"` or `kind: "image"`. A static check exposes `metadata: { width, height, static: true }` and `framesChecked: 1` with no audio/transcript fields. An image render exposes the PNG path, dimensions, bytes, diagnostics, and elapsed time with no fps, duration, frame count, codec, container, encoder, audio, or transcript fields. `still` exposes `frames`, `width`, and `height`, plus `frame` and `path` when exactly one frame was captured; a static composition only accepts frame 0.

Failures use the same envelope with `error.code`, `error.message`, optional `error.details`, and top-level `diagnostics`.

## Working with diagnostics

1. Run `npx frameyard check <id> --json`.
2. Read every error first; fix the first one and rerun.
3. Treat warnings as actionable. `BINDING_PATH_MISSING` is usually a typo; use the `suggestion` field.
4. Use `details.path`, `line`, and `column` to edit the exact source.
5. Re-run `check`, inspect representative stills, then render.

Do not ignore a failing `check`, a missing still, or a nonzero render. Do not describe visual correctness you did not inspect.
