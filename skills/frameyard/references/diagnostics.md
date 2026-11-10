# Diagnostics

Frameyard reports composition problems as structured diagnostics before and during frame production.

## Static validation

`check`, `still`, and `render` run a Node-side static composition validation before launching Chromium. `dev` runs it when a composition is requested. Static errors fail the command without starting a browser; warnings allow frame evaluation.

Static validation covers:

- fragment structure, root count and placement, metadata (including `width`/`height` pairing), default-props JSON, props schemas, and import maps
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

`details` may include `path`, `line`, `column`, `endLine`, `endColumn`, `element`, `attribute`, `value`, `suggestion`, `frame`, `controller`, and `includeChain`. For `PROPS_SCHEMA_INVALID`, `details.path` is the failing prop path (for example `title` or `palette.foreground`); `line` and `column` still point at the schema block. For `PROPS_SCHEMA_INVALID_SCHEMA`, `details.path` is the composition source path. Include diagnostics use the including or partial file as `path`, the `<fy-include>`/controller location when available, and `includeChain` from the entry composition to the failing partial.

## Fixes

Diagnostics and error envelopes may include an optional `fix` object:

```json
{
  "fix": {
    "kind": "attribute",
    "message": "Use \"data-fy-text\" instead of \"data-fy-txt\".",
    "from": "data-fy-txt",
    "to": "data-fy-text",
    "docs": "skills/frameyard/references/bindings.md"
  }
}
```

`kind` is `attribute`, `value`, `path`, `command`, or `docs`. `patch`, `command`, and `docs` are optional. Fixes are advisory; Frameyard never applies them automatically.

Baseline fixes are provided for `BINDING_INVALID`, `BINDING_PATH_MISSING`, `ANIMATION_INVALID`, `CONTROLLER_INVALID`, `INCLUDE_NOT_FOUND`, `INCLUDE_INVALID`, `INCLUDE_CYCLE`, `INCLUDE_DEPTH_EXCEEDED`, `STATIC_MEDIA_UNSUPPORTED`, `ASSET_NOT_FOUND`, `TIMELINE_CLIP_OVERLAP`, `TIMELINE_TRANSITION_GEOMETRY`, `FONT_LOAD_FAILED`, and `OUTPUT_EXISTS`, plus related binding, timeline, font, media, props-schema, and policy codes. Unknown codes have no fix.

Use `npx frameyard explain <code>` for the cause and examples, or `npx frameyard explain --list --json` for every stable code and summary. Timeline diagnostics may also include `timeline`, `clip`, `track`, `channel`, `keyframe`, `jsonPath`, `timelineFrame`, `sourceFrame`, `from`, `to`, and `nesting`; keyframe errors use `channel`, the zero-based `keyframe` index, and the clip-local `frame`, and transition errors use `from`/`to`.

## Common codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `COMPOSITION_INVALID` | error | Missing/invalid root, metadata, fragment structure, or reserved attributes |
| `COMPOSITION_DOCUMENT_SHELL` | error | A full document shell (`<!doctype>`, `<html>`, `<head>`, or `<body>`) is present; compositions are fragments |
| `INCLUDE_NOT_FOUND` | error | An `<fy-include>` target file does not exist |
| `INCLUDE_CYCLE` | error | The include chain repeats a partial file |
| `INCLUDE_INVALID` | error | Invalid include element, target shape, placement, path, or partial style at-rule |
| `INCLUDE_DEPTH_EXCEEDED` | error | The include chain is deeper than 32 files |
| `IMPORT_MAP_INVALID` | error | Invalid import map placement, JSON, attributes, or reserved `frameyard` specifiers |
| `COMPOSITION_FORMAT_UNRESOLVED` | error | The composition omits `width`/`height` and the project has no `format`; this is a command error, not a document diagnostic |
| `PROPS_INVALID` | error | Invalid default props JSON, invalid overrides, or `validateProps` failure |
| `PROPS_SCHEMA_INVALID` | error | Resolved props do not match the declared props schema; `details.path` is the failing prop path |
| `PROPS_SCHEMA_INVALID_SCHEMA` | error | The declared props schema is malformed, misplaced, duplicated, or uses an unsupported keyword |
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
| `ASSET_URL_INVALID` | error | An `asset add` URL is not HTTPS or loopback HTTP |
| `ASSET_PATH_INVALID` | error | An asset destination escapes the project root or has an unsupported media extension |
| `ASSET_HASH_MISMATCH` | error | A downloaded asset does not match the expected SHA-256 |
| `ASSET_DOWNLOAD_FAILED` | error | A remote asset could not be downloaded or returned an HTTP failure |
| `FONT_MANIFEST_INVALID` | error | Invalid font manifest schema, path, face, weight, or duplicate family |
| `FONT_FILE_MISSING` | error | A manifest font file is missing |
| `FONT_FILE_INVALID` | error | Wrong extension, signature, or non-file font path |
| `FONT_HASH_MISMATCH` | error | A vendored font file changed size or SHA-256 |
| `FONT_LICENSE_MISSING` | warning | Font license type or file is unknown or absent |
| `FONT_LOAD_FAILED` | error | Chromium failed to load a used `@font-face` |
| `FONT_PROVIDER_UNAVAILABLE` | error | Fontsource API/CDN unreachable or invalid response |
| `FONT_DOWNLOAD_FAILED` | error | A Fontsource or URL response was not a valid font file |
| `FONT_REMOTE` | warning | CSS references a remote font or stylesheet |
| `FONT_NOT_FOUND` | error | Fontsource id or `font remove` id is not installed |
| `AUDIO_WARNING` | warning | Audio timeline overrun or silent embedded media |
| `TRANSCRIPT_WARNING` | warning | Empty transcript text or no timed segments |
| `DETERMINISM_WARNING` | warning | Forbidden clock/randomness, CSS transition, or runtime diagnostic |
| `COMPOSITION_NOT_READY` | error | `seek`/`settle` before a successful load |
| `COMPOSITION_DISPOSED` | error | Operation after the host was disposed |
| `IMAGE_INVALID` | error | An inspect/compare input is missing, unreadable, not an image, or has different dimensions in a comparison |
| `POLICY_INVALID` | error | `fy.policy.json` or `FRAMEYARD_POLICY` is missing a required field, has an unknown field, or uses an invalid value |
| `RESOURCE_POLICY_BLOCKED` | error | The active tier blocks the operation, `--force`, or `--overwrite`; use `--dry-run` or ask the user for a `full` run |
| `RESOURCE_POLICY_LIMIT` | error | A still request exceeds the active tier's frame cap |
| `RESOURCE_PROFILE_CONFLICT` | error | `--workers` or `--concurrency` exceeds the `shared-cpu` profile cap |

## Results

`check`, `still`, and `render` JSON results expose:

- `entry`: project-relative HTML path
- `controller`: `{ kind: "inline" }`, `{ kind: "external", src }`, or `null`
- `diagnostics`: all static and runtime diagnostics, deduplicated

`check` and `render` are discriminated unions. Animated/video results report `kind: "animated"` or `kind: "video"`; static composition results report `kind: "static"` or `kind: "image"`. A static check exposes `metadata: { width, height, static: true }` and `framesChecked: 1` with no audio/transcript fields. An image render exposes the PNG path, dimensions, bytes, diagnostics, and elapsed time with no fps, duration, frame count, codec, container, encoder, audio, or transcript fields. `still` exposes `frames`, `width`, and `height`, plus `frame` and `path` when exactly one frame was captured; a static composition only accepts frame 0.

Failures use the same envelope with `error.code`, `error.message`, optional `error.details`, and top-level `diagnostics`.

## Lint and resource policy

`lint` returns the same diagnostic shape as `check` but does not launch Chromium. It reports static composition and timeline errors, scene and keyframe projection errors for every timeline frame, media metadata errors, and `DETERMINISM_WARNING` for controller source that calls wall-clock or randomness APIs. It does not run `validateProps` or composition runtime.

Policy failures use the normal error envelope. `RESOURCE_POLICY_BLOCKED` details include `policy`, `operation`, `allowed`, and a `suggestion`; `RESOURCE_POLICY_LIMIT` includes `limit` and `requested`; `RESOURCE_PROFILE_CONFLICT` includes `profile`, `option`, `limit`, and `requested`. Run the blocked `tts`, `transcribe`, or `render` command with `--dry-run` to get the handoff plan instead of treating the block as a render failure. `font add` requires `authoring` or `full`; `font remove` and `font add --force` require `full`.

## Working with diagnostics

1. Run `npx frameyard check <id> --json`.
2. Read every error first; fix the first one and rerun.
3. Prefer `fix.command`, `fix.to`, `fix.message`, and `fix.docs` when present; `npx frameyard explain <code>` adds examples.
4. Treat warnings as actionable. `BINDING_PATH_MISSING` is usually a typo; use `fix.to` or `details.suggestion`.
5. Use `details.path`, `line`, and `column` to edit the exact source.
6. Re-run `check`, inspect representative stills, then render.

Do not ignore a failing `check`, a missing still, or a nonzero render. Do not describe visual correctness you did not inspect.
