# Parameterize nested timelines with scoped variables

**Status:** Accepted
**Date:** 2026-11-19

A timeline may declare a `variables` object, and a nested timeline clip may
override it for that instance. A composition clip references a variable by
placing `{ "$var": "name" }` as a whole JSON value inside its `props`. Variables
are resolved during timeline resolution, before Chromium or frame production,
and are never interpolated into strings.

## Context

A nested timeline is reusable: it can be placed more than once, but until now
every composition inside it had fixed props. Reusing one timeline with different
titles, colors, or media therefore required duplicating the timeline or wrapping
the data in a separate composition.

Frameyard already has two parameterization layers:

- Composition props are immutable per load and merge over document defaults.
- Include props are literal and isolated per partial instance (ADR 0030).

Timelines need a third layer that is lexical rather than frame-derived. It must
stay JSON, deterministic, and diagnosable; it must not become a template
language.

## Decision

### Declarations

A timeline document may declare a `variables` object:

```json
{
  "version": 1,
  "variables": {
    "title": "Launch",
    "palette": { "foreground": "#b8f36b", "background": "#101820" }
  },
  "tracks": [{ "id": "v1", "kind": "video" }],
  "clips": [
    {
      "id": "intro",
      "track": "v1",
      "source": { "kind": "composition", "id": "intro" },
      "start": 0,
      "props": {
        "title": { "$var": "title" },
        "palette": { "$var": "palette" }
      }
    }
  ]
}
```

A nested timeline clip may override variables for that instance:

```json
{
  "id": "lower-one",
  "track": "v2",
  "source": { "kind": "timeline", "id": "lower" },
  "start": 0,
  "variables": {
    "title": "First",
    "palette": { "foreground": "#ff6b6b" }
  }
}
```

`variables` is allowed only on a timeline document and on a clip whose source is
a nested timeline. Variable names match `[A-Za-z_][A-Za-z0-9._-]*`. Values are
literal JSON values: a `{ "$var": ... }` object inside a variable definition is
data, not a reference. Definitions cannot reference other variables, so the
scope has no cycles and resolves in one pass.

### References

Inside a composition clip's `props`, an object with exactly one key `$var`
whose value is a variable name is a reference. It stands for the variable's
whole JSON value and may appear at any depth:

```json
"props": {
  "title": { "$var": "title" },
  "palette": { "$var": "palette" },
  "footer": "Fixed copy"
}
```

- References are whole values. There is no string interpolation, concatenation,
  path lookup, expression, or template syntax.
- An object that contains `$var` plus another key is invalid. `$var` values must
  be non-empty strings matching the variable-name pattern.
- A composition clip props object may itself be a single reference:
  `"props": { "$var": "sceneProps" }`.
- A variable may hold an object, array, number, boolean, string, or null; the
  value is inserted unchanged.
- Variables do not flow into include props. Include props stay literal, as
  ADR 0030 requires.

### Scope

Variables are resolved nearest-scope-first by name:

1. the nested timeline clip's `variables` override for this instance;
2. the nested timeline document's own `variables`;
3. the parent timeline clip's override for the scope that placed that parent;
4. the parent timeline document's `variables`;
5. and so on to the root timeline.

An instance override shadows only that instance. Two clips that place the same
nested timeline with different overrides resolve independently, and neither
changes the other's compositions. A nested timeline sees parent variables that
it does not shadow. The root timeline's own `variables` are visible to all its
composition clips and descendants.

Timeline variables are not composition props. A composition clip opts into a
variable by referencing it. A literal prop in the clip is explicit: a variable
with the same name never replaces it.

### Merge order

For one composition clip, the resolved props are built in this order:

1. composition props-schema defaults;
2. composition document defaults;
3. the clip's `props`, with every `{ "$var": "name" }` replaced by the nearest
   visible value;
4. the remaining explicit clip `props`, which are never replaced by variables;
5. CLI `--props` overrides for top-level composition clips, which merge last.

Steps 3 and 4 are one JSON object; they are listed separately because a
reference supplies a variable value while a non-reference value is an explicit
clip prop. The host then applies steps 1 and 2 through the existing props
schema and document-default path. Resolution validates the final props before
Chromium and the host re-applies the same defaults and validation at load.

CLI `--props` remains keyed by top-level composition clip ID. It does not reach
compositions inside a nested timeline; use nested instance variables for that.
Its values are literal props: a `$var` object there is not expanded.

### Diagnostics

- `TIMELINE_VARIABLE_NOT_FOUND`: a reference names a variable that is not in
  scope. The diagnostic carries the timeline, track, clip, nesting chain,
  variable name, and JSON path of the reference.
- `TIMELINE_VARIABLE_INVALID`: a `variables` object is malformed, a variable
  name or value is invalid, `variables` appears on a non-nested clip, or a
  reference-like object has the wrong shape.
- `PROPS_SCHEMA_INVALID`: the resolved props fail the composition schema. The
  diagnostic keeps the composition prop path and gains the timeline, track,
  clip, nesting chain, clip props JSON path, and the variable that supplied the
  failing value when one did.
- `PROPS_INVALID`: the resolved props are not a plain JSON object or cannot be
  merged.

Variables resolve before Chromium, so `check`, `still`, and `render` fail on a
missing variable without capturing frames and without publishing output. The
timeline preview resolves the same scope; a nested preview page receives the
instance's flattened visible values and applies them as its own nearest
overrides so preview and production render the same props.

### Determinism

Variables are immutable for a resolved timeline. They are read from the timeline
JSON and instance overrides, not from frame state, wall-clock time, environment
variables, or the filesystem. Changing a variable changes the resolved clip
props and therefore the composition's frame environment, exactly like changing
`props` in the JSON. Frame production still depends only on the frame, props,
and pre-loaded data.

## Alternatives considered

- **String interpolation (`"${title}"`).** Rejected: it invites escaping,
  partial expressions, and a template language, and it cannot pass structured
  JSON values safely.
- **A general expression language or path lookup (`$var.palette.fg`).** Rejected:
  expressions need an evaluator, a sandbox, and a much larger diagnostics
  surface. A whole-value reference covers structured data with a reference to a
  parent object.
- **Automatic merge of every variable into every composition clip.** Rejected:
  unrelated variables would leak into props, colliding with composition names
  and making schema validation surprising.
- **Deep-merging variable objects into defaults.** Rejected: composition props
  already use shallow merge. A variable is one value; if a creator wants a
  different nested object, they provide one.
- **Variables resolved in the browser at load.** Rejected: missing variables and
  invalid props must fail before Chromium, and preview/production must resolve
  once from the same timeline source.

## Consequences

- A nested timeline can be reused with different data without duplicating the
  document or adding wrapper compositions.
- Timeline JSON gains one document field, one nested-clip field, and one
  reserved reference key inside composition clip props.
- The resolved timeline carries concrete props per clip, so the renderer,
  static image cache, audio resolver, and preview consume the same data they did
  before.
- Preview nested pages gain an internal variable-override parameter. It is not
  an authoring surface.
- Includes remain literal and isolated; timeline variables target the root
  composition, not include props.

## Out of scope

- String interpolation, concatenation, conditionals, loops, or expressions.
- Variable references between variable definitions.
- Cross-project variables or environment-variable substitution.
- Variables in media paths, transforms, transitions, or audio settings.
- A timeline variable editor UI.
