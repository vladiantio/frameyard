# Reuse composition fragments with scoped includes

**Status:** Accepted. Static includes, scoped props, bindings, CSS, and scoped
controllers are implemented in #17-#18; timeline capture is tracked in #20.
Amends
the one-controller rule in [ADR-0007](./0007-make-html-documents-the-composition-unit.md)
and [ADR-0016](./0016-author-compositions-as-html-fragments.md) for included
partials. Extends [ADR-0002](./0002-make-frame-and-props-the-only-animation-state.md)
with one expansion step before bindings and frame production.
**Date:** 2026-11-09

Frameyard will let a composition include a reusable partial with
`<fy-include>`. An include expands once, before bindings and frame production,
into a `<fy-partial>` root with its own immutable props, binding boundary,
scoped CSS, and at most one controller. Includes are structural reuse, not a
runtime template language: they cannot be conditional, repeated, or created by
a controller, and they cannot fetch remote files.

## Context

Frameyard compositions are single partial fragments with one top-level
`<fy-composition>` root. Reusing a header, lower third, chart, or scene
currently means copying markup, styles, props, and controller code into every
composition. Copying is the main source of drift between otherwise similar
scenes.

The include contract has to preserve four properties at once:

- **One expanded tree.** Preview, `check`, `still`, composition render, and
  timeline capture must see the same DOM, styles, props, and controllers.
- **Static validation first.** Missing files, invalid partials, cycles, prop
  errors, and controller declaration errors must fail before Chromium starts.
- **Determinism.** Expansion depends only on the entry file, included files,
  and literal include props. No network, no wall clock, and no frame state.
- **Actionable diagnostics.** A creator or agent must see the included file,
  the `<fy-include>` source location, and the chain that led there.

The current invariants are a useful boundary. A composition entry is still one
fragment with one `<fy-composition>` root. A controller is still the only
executable code. Includes add a second, nested scope; they do not add a second
composition unit or a template runtime.

## Decision

### Partial files and include syntax

An include target is a **composition partial**: a project `.html` file with
exactly one top-level `<fy-partial>` root. A partial has no document shell, no
`<fy-composition>` root, and no composition metadata. It is not a
`fy.config.js` entry and does not appear in `project.json` as a composition.

A partial root may contain only these direct children:

- at most one `<script type="application/json" data-fy="props">` block;
- at most one `<script type="application/json" data-fy="props-schema">` block;
- any number of `<style>` elements;
- at most one controller, inline or external, using the existing
  `<script type="text/fy-controller">` declaration;
- the rendered content, including nested `<fy-include>` elements.

`<link rel="stylesheet">`, import maps, additional executable scripts, and a
nested `<fy-partial>` are invalid in a partial. `<fy-partial>` carries no
metadata attributes; the parent composition fixes the format and frame clock.

A composition includes a partial with an empty element inside its root:

```html
<fy-include src="./partials/badge.html" props='{"label":"Live"}'></fy-include>
```

- `src` is required and must point at a `.html` file inside the project.
- `props` is an optional JSON object literal. It is not a binding expression.
- `class`, `style`, `id`, and non-framework `data-*` attributes on
  `<fy-include>` are copied to the expanded `<fy-partial>` root. `class` and
  `style` are the supported way to position or theme an include.
- `data-fy-*` attributes other than the include's own configuration are
  reserved and invalid on `<fy-include>`.

Includes are allowed anywhere in the composition root's rendered content,
including inside a partial, but not inside `<template>`, `<style>`, `<script>`,
`<fy-transcript>`, or a controller's source. Include content is static:
`data-fy-if`, `data-fy-repeat`, and controller-created DOM cannot control an
include. Conditional content belongs inside the partial and uses the partial's
own props.

A partial may be included more than once. Each occurrence is a separate scope
with its own props, controller instance, and CSS scope id. A cycle is a
repeated file on the current ancestor chain, not a repeated file in the graph.

### Resolution and project boundaries

- `src` values starting with `/` resolve from the project root.
- Other `src` values resolve relative to the including file.
- Paths are normalized with forward slashes, must carry the `.html` extension,
  and must stay inside the project root after lexical normalization.
- Absolute filesystem paths, URL schemes, query strings, and fragments are
  rejected.
- Remote includes are not supported. Includes are read during the loading
  phase; capture never fetches a partial.
- Include depth is limited to 32. A deeper chain fails with
  `INCLUDE_DEPTH_EXCEEDED` rather than expanding without bound.
- Partials are project files, not entries. The explicit-entry rule for
  compositions and timelines is unchanged.

### Prop scoping

Every include instance has its own immutable props. The merge order is:

1. partial props-schema defaults;
2. partial default props;
3. the `<fy-include props>` object.

The resolved object is validated against the partial schema before Chromium and
again at host load, deep-frozen, and fixed for that load. A malformed `props`
attribute uses `PROPS_INVALID`; a schema failure uses `PROPS_SCHEMA_INVALID`.

The include boundary is also a binding boundary:

- Bindings inside the partial resolve only against the partial's scoped props.
- Parent props do not fall back into included bindings.
- A parent controller cannot re-bind included DOM.
- Included `data-fy-if`, `data-fy-repeat`, `data-fy-text`, `data-fy-attr-*`,
  and `data-fy-class-*` apply once per load, using the partial scope.
- Primitive scoped props are exposed as `--fy-prop-*` custom properties on the
  `<fy-partial>` root. A scoped prop shadows an inherited custom property with
  the same name.

CSS custom properties are separate from props. A parent composition's
`--fy-prop-*` values inherit into an include unless the include sets the same
property. A partial may consume an inherited parent variable for theming, but
that does not make the parent prop visible to bindings or controllers.

Include props are literal and static. Timeline composition-clip props and
timeline variables do not flow into include props. A partial that needs
timeline-parameterized data is the wrong unit; use a composition. A partial can
still consume inherited `--fy-prop-*` values for visual theming.

### Styles and CSS isolation

The framework gives every include instance a deterministic scope id in
document order: `include-1`, `include-2`, and so on. The expanded root is:

```html
<fy-partial
  data-fy-include="include-1"
  data-fy-include-src="partials/badge.html"
  data-fy-props='{"label":"Live"}'
>
  ...
</fy-partial>
```

The framework copies the literal include props into the reserved
`data-fy-props` attribute; authors write `props` on `<fy-include>`, not
`data-fy-props`.

The host style makes `<fy-partial>` layout-transparent with
`display: contents`. The partial root is a DOM and CSS scope boundary, not a
layout box; authors put layout on an inner element.

Included `<style>` elements stay in place and their contents are wrapped as:

```css
@scope ([data-fy-include="include-1"]) to ([data-fy-include]) {
  /* author CSS */
}
```

- An included selector cannot match an element outside its partial root.
- The `to` limit stops an outer include's styles at a nested include root, so
  sibling and nested scopes do not leak into each other.
- `:scope` targets the partial root.
- `:root`, `html`, and `body` selectors do not match inside an include.
- `@media`, `@supports`, `@layer`, and `@keyframes` may be nested inside the
  scope wrapper. Keyframe names remain global; partials must prefix them.
- `@font-face`, `@property`, `@import`, `@namespace`, and `@charset` are not
  allowed in partial styles. Project fonts come from the font manifest.
- Parent styles may still target included content intentionally. Isolation is
  one-way: includes cannot restyle the parent, but the parent can theme an
  include.
- Included markup and CSS resolve ordinary asset URLs against the composition
  document, not the partial file. Partials that reference images or other
  assets should use project-root URLs such as `/assets/logo.png`.
- Framework blocks (`props`, `props-schema`, controller) are read in the
  partial scope. They may remain in the DOM as inert elements.

CSS `@scope` is a Chromium feature. Frameyard previews and renders in Chromium,
so this is the supported environment.

### Controllers

The one-controller rule becomes:

- a composition has at most one root controller at the top level of its
  fragment;
- each `<fy-partial>` has at most one controller as a direct child;
- therefore an expanded document can run one root controller plus one
  controller per include instance.

Each included controller receives `{ root, props }` where `root` is its
`<fy-partial>` element and `props` are the scoped props. It may export
`mount`, `update`, `dispose`, and `validateProps` with the existing lifecycle
rules.

- `validateProps` runs for the root and every include before any `mount`.
- `mount` order is pre-order: root controller first, then include controllers
  in document order, parent before child.
- `update` uses the same order. Every controller receives the same frame.
- `dispose` runs in reverse order when the load is replaced or the host is
  disposed.
- A failure in any controller disposes already-mounted controllers in reverse
  order and fails the load atomically.
- A static composition mounts root and include controllers but does not call
  `update`, set frame state, or seek CSS animations.

Each include instance imports its controller through a unique module URL. An
inline controller is served from the partial file URL with an instance token;
an external controller is served from its own path with an instance token.
Relative imports resolve relative to the partial file, and module-scope
mutable state is isolated per instance. A controller failure reports the
partial path, controller location, and include chain.

Partial import maps are not supported. The root composition owns module
resolution; partial controllers use relative imports or specifiers already in
the root import map.

### Expansion pipeline and diagnostics

Static validation and serving use the same expansion rules:

1. Parse the entry fragment.
2. Resolve the include graph depth-first; detect missing files, cycles, bad
   targets, and the depth limit.
3. Parse and validate each partial's grammar, props, schema, and controller.
4. Expand each include into a `<fy-partial>` root with a scope id, source path,
   copied host attributes, and literal props.
5. Validate the expanded document, applying each scope's props to its own
   binding subtree.
6. Run the existing media, transcript, animation, and static-mode checks over
   the expanded tree.
7. Serve or capture the expanded document.

The Node-side expansion keeps an origin map from expanded nodes to their
source file, line, and column. Diagnostics inside a partial point at the
partial file; include errors point at the `<fy-include>` element. Resolution
adds `includeChain` to `CompositionDiagnosticDetails`: the project-relative
paths from the root composition to the failing partial, in order.

New stable codes:

- `INCLUDE_NOT_FOUND`: the target file does not exist.
- `INCLUDE_CYCLE`: the target repeats a file on the ancestor chain.
- `INCLUDE_INVALID`: the include element or partial shape is invalid,
  including a document shell, multiple roots, a bad extension, a reserved
  attribute, a stylesheet link, an import map, or an unsupported placement.
- `INCLUDE_DEPTH_EXCEEDED`: the chain exceeds 32 files.

Existing `PROPS_INVALID`, `PROPS_SCHEMA_INVALID`, `PROPS_SCHEMA_INVALID_SCHEMA`,
and `CONTROLLER_INVALID` keep their meaning inside a partial and gain the
partial path and include chain. Every new code gets a `frameyard explain`
entry and an advisory fix where one is possible. No fix is applied
automatically.

IDs are not rewritten. A partial included more than once must not rely on
document-global `id` lookup; controllers query from their own root and CSS is
already scoped. Duplicate ids remain the author's accessibility
responsibility.

### Determinism and rendering

- Expansion happens once per load from file contents and literal include props.
  A composition frame still depends only on its frame, immutable props, and
  data/assets loaded before frame production.
- The browser never fetches a partial after loading starts.
- Preview, `check`, `still`, and render share the expanded document. The
  browser host only applies scoped bindings and controllers; it does not
  resolve includes.
- A static composition may include partials. Animation, media, audio, and
  transcripts inside an included fragment remain illegal in a static
  composition.
- Timeline composition clips capture expanded documents through the existing
  path. The composition session pool and static-composition cache keys must
  distinguish expanded documents by their include graph and content, not only
  by entry path, props, transparency, and scale.
- Nested timelines inherit the same behavior through their composition clips.
  Timeline variables and nested prop overrides are a separate contract
  (ADR-0031); they do not target include props in this design.

## Example

`compositions/scene.html`:

```html
<script type="application/json" data-fy="props">{ "title": "Launch" }</script>
<fy-composition width="640" height="360" fps="10" duration-in-frames="30">
  <h1 data-fy-text="title"></h1>
  <fy-include src="./partials/badge.html" props='{"label":"Live"}'></fy-include>
  <fy-include src="./partials/badge.html" props='{"label":"Replay"}' class="replay"></fy-include>
</fy-composition>
```

`compositions/partials/badge.html`:

```html
<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <script type="application/json" data-fy="props-schema">
    {
      "type": "object",
      "properties": { "label": { "type": "string" } },
      "required": ["label"]
    }
  </script>
  <style>
    .badge { display: inline-block; padding: 6px 10px; background: #b8f36b; color: #0a1005; }
  </style>
  <span class="badge" data-fy-text="label"></span>
</fy-partial>
```

The equivalent inline composition uses the same two `<span class="badge">`
elements with the text `Live` and `Replay`, and the same `.badge` rule without
the include scope. The captured pixels must match at every frame; includes add
structure, not a new visual model.

## Considered Options

- **Copy and paste the fragment.** Rejected: it is the drift this change
  removes, and it gives agents no single source for reusable markup.
- **Include a whole composition entry.** Rejected: a composition has its own
  root, metadata, and frame clock. Includes need a nested scope, not a second
  composition or a nested render unit.
- **Resolve includes in the browser during load.** Rejected: it splits the
  validation and serving paths, adds failure modes after network blocking, and
  makes diagnostics depend on a browser fetch. Node expansion keeps one tree.
- **Shadow DOM per include.** Rejected: it gives stronger CSS and layout
  isolation but breaks the existing document-wide binding walk, media
  settlement, animation seeking, and controller root contract. `@scope` covers
  the CSS leak this change needs to prevent.
- **Global shared styles.** Rejected: a partial could silently restyle the
  parent and sibling scenes. Scoped styles keep reuse safe by default.
- **Parent props fall back into included bindings.** Rejected: it makes a
  partial depend on ambient parent data, creates name collisions, and cannot
  be validated against the partial schema. Explicit include props and
  inherited CSS custom properties cover the useful cases.
- **Conditional or repeated includes.** Rejected: includes expand before
  bindings. Runtime conditionals belong inside the partial; use a composition
  when the unit itself must vary.
- **One shared controller module for every include instance.** Rejected:
  module-scope state, the documented place for controller state, would be
  shared across instances. A per-instance module URL keeps the existing
  controller contract.
- **Remote includes.** Rejected: rendering never fetches media or markup after
  loading. Remote includes would break offline determinism.

## Consequences

- `src/composition/` gains a partial grammar reader, and Node-side code gains
  an include resolver. The browser-safe grammar stays free of `node:` imports.
- `src/html/validate.ts` expands the include graph before its existing checks;
  `src/server/composition-html.ts` expands before wrapping the document shell.
- `src/runtime/host.ts` and `src/runtime/bindings.ts` gain scope boundaries,
  per-scope props, pre-order controller lifecycle, and per-instance module
  URLs.
- `src/contracts.ts` gains `includeChain`; `src/explain.ts` and
  `src/diagnostic-fixes.ts` gain the new codes.
- The official skill gains `references/includes.md` when the implementation
  lands. The design baseline and glossary use the terms partial, include, and
  include scope.
- The one-controller invariant in ADR-0007 and ADR-0016 is amended for included
  partials. The root composition still has exactly one controller.
- Includes do not make composition entries dynamic. Timeline composition-clip
  props and timeline variables still target the root composition, not include
  props.
- No runtime behavior changes until #17-#20 implement this contract. Each
  slice adds its own public-behavior tests; the ADR alone adds documentation
  checks.
