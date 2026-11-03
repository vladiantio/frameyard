# Inherit composition format from the project

**Status:** Accepted. Amends [ADR-0007](./0007-make-html-documents-the-composition-unit.md) and [ADR-0010](./0010-make-timelines-the-render-unit.md).
**Date:** 2026-11-03

`<fy-composition>` will keep `duration-in-frames` required but make `width`, `height`, and `fps` optional. A composition that omits any of them inherits the value from the single project `format` in `video.config.js`; a declared value always wins. Declaring `width` without `height` (or the reverse) remains an error. A composition that declares its full format keeps working unchanged, including in composition-only projects that have no `format`.

The unit of reuse moves from "a file with fixed output pixels" to "a source that composes at whatever the project or timeline provides". The same composition can therefore appear in a 1080p timeline and a vertical timeline without editing the file or duplicating attributes that the project already fixes. Timelines do not gain their own format: `ResolvedTimeline.format` is already `project.format`, so timeline and standalone inheritance are the same resolution.

## Considered Options

- **Keep all four attributes required.** Rejected because the project `format` and the composition root duplicate the same three values, and the copies can disagree. The only disagreement the renderer tolerates today is size; a stale `fps` is a hard error that adds no information.
- **Add a separate `defaultFormat` key.** Rejected because a second format invites divergence and adds precedence questions. `format` is already "the project format"; it now also fills omitted composition values.
- **Hardcode a framework default (1920×1080 at 30 fps).** Rejected because it is an implicit value that no project declared, and it would silently produce a different composition than the timeline that contains it.
- **Infer width and height from the browser viewport.** Rejected because frame pixels would depend on preview window size, breaking determinism and preview/render parity.
- **Make `duration-in-frames` optional too.** Rejected because duration is intrinsic to the composition and cannot be inherited from a project format; timelines trim a source range but do not define the source length.
- **Bake the resolved format into the composition HTML at build time.** Rejected because composition documents stay authored artifacts and the server already injects framework markup at request time.

## Consequences

- Declared metadata is distinct from resolved metadata. `CompositionDescriptor.metadata` exposes `{ format: DeclaredFormat; durationInFrames }`, and `CompositionSourceInfo` carries the resolved `metadata` plus `declaredFormat`. `CompositionMetadata`, `window.__fy.metadata`, and render results keep exposing resolved numbers only.
- The preview server injects the project format as a `data-fy="format"` JSON block marked `data-fy-host`. The browser host reads it to resolve the same values the Node-side validator used; the existing static-vs-runtime metadata equality check therefore still holds.
- The composition route and `project.json` resolve metadata in the server. `project.json` keeps exposing resolved metadata, or `null` when the document is invalid or the format cannot be resolved.
- Rendering a composition that omits format values in a project without `format` fails with `COMPOSITION_FORMAT_UNRESOLVED`, a context error rather than a document diagnostic. The message names both fixes: declare the attributes or add `format` to `video.config.js`.
- A declared `fps` that differs from the project format remains `TIMELINE_FPS_MISMATCH`. The check compares the declared fps, not the resolved one, so inheritance never hides a real mismatch. Width and height keep the existing fit behavior with no mismatch error.
- The resolved format is part of the immutable frame environment, alongside props and loaded assets. Layouts that use viewport units become format-dependent by design; preview and production use the same resolved values.
- The scaffold keeps declaring an explicit format as the safe teaching default. `examples/blend/compositions/backdrop.html` demonstrates inheritance.
- Static validation gains an optional `format` input. Composition-only projects without `format` remain valid as long as every composition declares its own width, height, and fps.
