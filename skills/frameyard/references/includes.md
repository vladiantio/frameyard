# Composition includes

Use an include when several compositions share the same markup, styles, props,
bindings, and optional scoped controller. Use a composition when the reusable
unit needs its own format, frame clock, or a separate timeline clip.

## Files

A partial is a project `.html` file with exactly one top-level `<fy-partial>`
root. It is not listed in `fy.config.js`.

```html
<!-- compositions/partials/badge.html -->
<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <script type="application/json" data-fy="props-schema">
  { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }
  </script>
  <style>
    .badge { padding: 6px 10px; background: #b8f36b; color: #0a1005; }
  </style>
  <span class="badge" data-fy-text="label"></span>
</fy-partial>
```

A partial may contain one props block, one props-schema block, direct `<style>`
elements, at most one controller, and content. It cannot contain a document
shell, another `<fy-partial>`, an import map, or a stylesheet link.

## Include

```html
<fy-composition width="640" height="360" fps="10" duration-in-frames="30">
  <fy-include src="./partials/badge.html" props='{"label":"Live"}'></fy-include>
  <fy-include src="./partials/badge.html" props='{"label":"Replay"}' class="replay"></fy-include>
</fy-composition>
```

- `src` is required and must point at a project `.html` file.
- A path starting with `/` resolves from the project root. Other paths resolve
  relative to the file that contains the include.
- `props` is a JSON object literal, not a binding expression.
- `class`, `style`, `id`, and non-framework `data-*` attributes are copied to
  the expanded partial root.
- Includes are static. They cannot be conditional, repeated, or created by a
  controller. Put conditionals inside the partial and drive them with its props.
- Include depth is limited to 32. A repeated file on one ancestor chain is a
  cycle.

## Props and bindings

Each include instance resolves its own props in this order:

1. partial props-schema defaults;
2. partial default props;
3. the include `props` object.

Bindings inside the partial see only those scoped props. Parent props do not
fall back into included bindings. Primitive scoped props also become
`--fy-prop-*` custom properties on the `<fy-partial>` root. Parent CSS custom
properties still inherit, so a partial can consume a parent `--fy-prop-*`
value for visual theming.

Timeline composition-clip props and timeline variables do not flow into include
props. Use a composition when the timeline must parameterize the data.

## Controllers

A partial may declare one controller, inline or external:

```html
<script type="text/fy-controller" src="./badge.controller.js"></script>
```

- An external `src` resolves relative to the partial file.
- Each include instance loads its own module instance. Module-scope state does
  not leak between two uses of the same partial.
- `validateProps` runs against the scoped props before any mount.
- `mount` and `update` run root-first, then includes in document order.
  `dispose` runs in reverse. Every controller receives `{ root, props }`, where
  `root` is its `<fy-partial>`.
- A static composition mounts included controllers but does not call
  `update()` or set frame state.
- Import maps inside a partial are not supported; use the root composition's
  import map or relative imports.
- `Math.random()`, `Date.now()`, and timers produce `DETERMINISM_WARNING`
  attributed to the partial path.

## Styles

Each include gets a deterministic scope id. Its `<style>` content is wrapped in
`@scope ([data-fy-include="include-N"]) to ([data-fy-include])`, so an included
selector cannot restyle the parent or a nested include. Parent styles can still
target included content intentionally.

`:root`, `html`, and `body` selectors do not match inside an include. Keep
global styles and `@font-face` in the composition. Keyframe names are global;
prefix them when a partial defines its own.

Included markup and CSS resolve ordinary asset URLs against the composition
document, not the partial file. Use project-root URLs such as
`/assets/logo.png` inside a partial.

## Diagnostics

- `INCLUDE_NOT_FOUND`: the target file does not exist.
- `INCLUDE_CYCLE`: the include chain repeats a file.
- `INCLUDE_INVALID`: the include or partial shape, attributes, or style
  at-rules are invalid.
- `INCLUDE_DEPTH_EXCEEDED`: the chain is deeper than 32 files.

Diagnostics inside a partial use the partial path, line, and column, and include
an `includeChain` from the entry composition to the failing partial. Run
`npx frameyard explain <code>` for the cause and a fix.

## Verify

```sh
npx frameyard check <composition> --json
npx frameyard still <composition> --frame 0 --out still.png --json
```

Compare an include against the equivalent inline markup with
`npx frameyard compare a.png b.png --json`.
