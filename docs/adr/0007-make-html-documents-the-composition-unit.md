# Make HTML documents the composition unit

**Status:** Accepted
**Date:** 2026-10-30

Frameyard compositions will be declarative HTML documents rather than JavaScript modules. A composition declares its metadata, default props, bindings, animation schedule, audio, and transcripts in HTML and CSS, while an optional inline or external controller handles Canvas 2D, WebGL, karaoke, and per-frame computation the declarative layer cannot express. This replaces the imperative `mount → update → dispose` authoring contract with an HTML-first model that is easier for humans and agents to read, edit, and inspect, while preserving frame-and-props determinism and preview/render parity through the same injected host runtime.

## Considered Options

- **Keep JavaScript modules as the composition unit.** Rejected because the common path requires imperative DOM construction and a full `update()` function even for markup and CSS animation that HTML can express directly.
- **Pure no-JavaScript HTML/CSS.** Rejected because Canvas 2D and WebGL would become impossible without a new declarative drawing language, contradicting the existing visual-source contract.
- **HTML fragment injected into the preview container.** Rejected because relative asset URLs, document styles, and `<head>` content would need rewriting or scoping, making preview and render behavior fragile.
- **Add HTML as an alternative authoring format.** Rejected because two public composition models double the documentation, tests, and agent-skill surface; the repository is pre-1.0 and can make a clean breaking change.
- **Keep metadata and audio in `video.config.js`.** Rejected because it splits a composition across files and makes the HTML document less portable.
- **External-only controllers.** Rejected because it forces a second file for small, single-use compositions, which is worse for agent authoring and review; inline source keeps those compositions self-contained while external modules remain available for reuse, tests, and complex logic.
- **Browser-only validation.** Rejected because agents would pay a Chromium launch for source-level mistakes and would not get line and column locations; the server already parses composition HTML for host injection, script rejection, and inline-controller extraction.

## Consequences

- 0.4.0 is a breaking release. JavaScript composition modules, `defineComposition`, and `data-frameyard-*` media attributes are removed from the public authoring contract.
- The `fy` prefix is the authoring namespace: `fy-composition`, `fy-transcript`, `data-fy-*`, `--fy-*`, and `text/fy-controller`.
- The preview server injects a host runtime and import map into composition entries. Preview uses a same-origin iframe; `check`, `still`, and `render` navigate directly to the same document and drive the same host API.
- A composition has exactly one controller, declared inline in a `<script type="text/fy-controller">` block or externally with `src`. Inline source is extracted and served through a virtual module URL so relative imports, bare specifiers, and `import.meta.url` behave like an external module.
- Executable scripts and inline event handlers other than the controller are rejected; declarative HTML remains the default and the controller is the only escape hatch.
- A Node-side static composition validation pass runs before Chromium in `check`, `still`, and `render`, and on load in `dev`, reporting structured diagnostics with source locations.
- The demo, scaffold, README, agent skill, fixtures, and tests migrate to the HTML model.
- ADR 0001's web-native principle survives; its JavaScript-lifecycle assumption is amended. ADR 0006's frame-clock media rule survives; its `mount()` placement detail is superseded.

## Agent-hardening

The HTML contract is paired with a Node-side static composition validation pass. `check`, `still`, and `render` run it before Chromium; `dev` runs it on load. It validates metadata, root and controller declarations, default props, binding attributes and paths, animation attributes, scripts and event handlers, unsupported visual elements, and audio/transcript references. Diagnostics carry stable codes and optional source locations, and JSON results expose the composition entry, controller declaration, and warnings. Props domain validation remains controller-only in 0.4; a declarative schema is deferred.
