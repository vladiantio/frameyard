# Bindings

Bindings map immutable props into the composition DOM once per load. They are explicit HTML attributes; there is no template expression language.

## Attributes

| Attribute | Effect |
| --- | --- |
| `data-fy-text="path"` | Sets `textContent`. |
| `data-fy-attr-<name>="path"` | Sets an attribute. |
| `data-fy-class-<name>="path"` | Toggles one class. |
| `data-fy-if="path"` | Removes the element when false. |
| `data-fy-repeat="path"` on `<template>` | Clones the template content for each array item. |

```html
<h1 data-fy-text="title"></h1>
<img data-fy-attr-src="image" data-fy-attr-alt="alt">
<div data-fy-class-active="isActive"></div>
<p data-fy-if="showSubtitle" data-fy-text="subtitle"></p>

<template data-fy-repeat="items">
  <span data-fy-text="item.label" data-fy-attr-data-index="index"></span>
</template>
```

## Paths

- Dot-separated: `title`, `user.name`, `items.0.label`.
- Numeric segments index arrays.
- Only own properties are read. `__proto__`, `constructor`, and `prototype` are rejected.
- Inside a repeat clone, `item` and `index` shadow props.
- Missing paths are warnings. Text becomes empty, attributes/classes are removed, and `if` is false. A missing or non-array `repeat` path is an error.

## Value coercion

| Binding | Rule |
| --- | --- |
| `text` | Strings, numbers, and booleans are stringified; null/undefined become empty; objects/arrays warn and become empty. |
| `attr` | `true` writes an empty attribute; `false`/null/undefined remove it; strings/numbers are stringified; objects/arrays warn and remove. |
| `class` | JavaScript truthiness; objects/arrays warn and remove. |
| `if` | JavaScript truthiness. Empty arrays are truthy. |
| `repeat` | Must be an array; otherwise an error. |

`data-fy-attr-on*` is rejected. A bound `href`/`src` that resolves to a `javascript:` URL is rejected.

## Repeat scope

```html
<ul>
  <template data-fy-repeat="items">
    <li data-fy-text="item.label"></li>
  </template>
</ul>
```

- The `<template>` is replaced by the clones.
- `--fy-index` is set on each top-level clone for CSS stagger.
- Nested repeats are rejected. Use a controller for nested data.
- A repeat template cannot also use `data-fy-if` or `data-fy-text`.

## CSS variables

Primitive top-level props are also set as `--fy-prop-<name>` on the composition root:

```html
<div style="background: var(--fy-prop-accent)"></div>
```

Booleans are `1`/`0`. Null, undefined, objects, and arrays are omitted. Bindings are applied before the controller mounts; controller-created DOM is not re-bound.

## Ordering

Bindings apply top-down: repeat, then `if`, then text/attribute/class. A removed element does not process its children. `data-fy-if` and `data-fy-text` on the composition root are errors.
