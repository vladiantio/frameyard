# Author compositions as HTML fragments

**Status:** Accepted. Amends [ADR-0007](./0007-make-html-documents-the-composition-unit.md) and [ADR-0008](./0008-share-the-composition-document-grammar.md).
**Date:** 2026-11-03

Frameyard 0.8 makes a composition a partial HTML fragment instead of a full HTML document. The author writes body content with one top-level `<fy-composition>` root, plus optional top-level props, controller, import maps, and styles. The server wraps that fragment in a fixed document shell at the composition URL, so preview and production keep the same relative-URL, stylesheet, and host semantics. This removes author-owned document boilerplate and makes the framework, not the author, responsible for the charset, title, import map, sizing style, format block, and host module.

## Considered Options

- **Keep full HTML documents.** Rejected because every composition repeats a shell the framework already owns, and the head becomes a second place where import maps, metadata, and host markup can drift.
- **Accept both documents and fragments.** Rejected because two authoring shapes double validation, diagnostics, documentation, and agent examples for a pre-1.0 breaking release.
- **Inject a fragment into the preview container without a document.** Rejected for the reasons in ADR-0007: relative asset URLs, document styles, and head content would need rewriting. Serving a generated document at the real composition URL avoids that problem.
- **Generate full documents at build time.** Rejected because Frameyard has no build step and the preview server already renders composition entries per request.
- **Let projects configure the document head.** Rejected because the author goal is to stop managing the head; a configuration surface would recreate the problem in `video.config.js`.

## Decision

- A composition entry is a partial HTML fragment. It contains exactly one top-level `<fy-composition>` element. Props blocks, the controller, and import maps must be top-level siblings; `<style>` and `<link rel="stylesheet">` may be top-level or inside the root.
- The fragment must not contain `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`, and must not use the reserved `data-fy-host` attribute or `data-fy="format"` block.
- The server generates a fixed document: `<!doctype html>`, `<html lang="en">`, a head with charset and title, the format block, the framework import map, author import maps in source order, the host style, hoisted author styles and stylesheet links in source order, and the host module; then the remaining fragment nodes in the body.
- Top-level author import maps are allowed and are hoisted after the framework map. Their JSON, attributes, and specifiers are validated; `frameyard` and `frameyard/` are reserved. Multiple import maps merge in document order, and the framework entries resolve first.
- Static validation parses the fragment in a body context and detects legacy document shells with a separate document parse. The shared composition reader takes a `document` or `fragment` root scope; the browser host keeps document scope, while Node validation uses fragment scope.
- The authoring change is a clean break in 0.8. A legacy full document fails with `COMPOSITION_DOCUMENT_SHELL` and a suggestion to the migration guide. There is no migration command.

## Consequences

- `src/server/composition-html.ts` replaces host injection into an author document with document-shell generation and head hoisting.
- `src/html/validate.ts` gains fragment structure checks, shell detection, import-map validation, and reserved-attribute checks. `COMPOSITION_DOCUMENT_SHELL` and `IMPORT_MAP_INVALID` join the stable diagnostic codes.
- The composition reader's root scope is explicit. ADR-0008's shared grammar still applies; only the container differs between Node validation and the browser host.
- `.html` stays the composition extension and `project.json` keeps `kind: "html"`; the change is documented in `docs/migration-0.8.md` rather than encoded in the JSON contract.
- `examples/`, the `init` scaffold, the agent skill, and the test fixtures migrate to fragments. A baseline still comparison guards the wrapper against visual regressions.
- The browser host still reads a full document, so `readCompositionDescriptor` keeps its document-mode rules and the served document remains inspectable.
