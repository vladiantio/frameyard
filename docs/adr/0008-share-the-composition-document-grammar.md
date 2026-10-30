# Share the composition document grammar

**Status:** Accepted
**Date:** 2026-10-30

Static composition validation and the composition host will read the HTML composition grammar through one browser-safe module with two adapters: parse5 for Node-side validation and the DOM for the host. The reader returns a composition descriptor of fixed facts (metadata, default props, and the controller declaration) and per-kind declarations (animation, media, and transcripts) at the host's existing lifecycle points; it stays pure, leaving path resolution, filesystem checks, and transcript parsing to the validator. Controller `src` remains project-relative in public results, with the authoring value retained as `rawSrc` for the host's module import. This keeps static validation and frame production from drifting while preserving ADR-0007's split between Node-side validation and browser frame production.

## Considered Options

- **Server-injected descriptor.** Rejected because the host still reads per-element bindings, animation, and media from the DOM; a descriptor would cover only part of the grammar and couple the host to server injection.
- **Shared rule table with two readers.** Rejected because it centralizes constants but leaves two traversals and two error paths.
- **Normalized document tree.** Rejected because the host needs the original DOM elements for animation and media application; a lazy adapter avoids the copy.

## Consequences

- The reader lives in `src/composition/` and is covered by a browser-only tsconfig so it cannot import `node:`.
- `ControllerDeclaration` gains `rawSrc`; public `src` stays project-relative. The host's `controller.src` now matches check, still, and render.
- Bindings remain a separate slice; static validation keeps binding-path resolution and runtime application.
