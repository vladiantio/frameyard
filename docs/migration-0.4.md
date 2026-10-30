# Migrating to Frameyard 0.4

0.4 replaces JavaScript composition modules with declarative HTML documents. The CLI commands, props files, audio and transcript asset formats, rendering pipeline, and determinism guarantees are unchanged. This guide maps the old authoring surface to the new one.

## 1. Change the config entry

Before:

```js
export default {
  compositions: {
    hello: "./compositions/hello.js",
  },
};
```

After:

```js
export default {
  compositions: {
    hello: "./compositions/hello.html",
  },
};
```

Entries must be `.html`. There is still no directory scanning.

## 2. Move metadata and defaults into the document

Before:

```js
export default defineComposition({
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 150,
  defaultProps: { title: "Hello", accent: "#b8f36b" },
  // ...
});
```

After:

```html
<fy-composition width="1280" height="720" fps="30" duration-in-frames="150">
  <!-- composition content -->
</fy-composition>

<script type="application/json" data-fy="props">
{ "title": "Hello", "accent": "#b8f36b" }
</script>
```

## 3. Move markup out of `mount()`

Before:

```js
mount({ container }) {
  container.innerHTML = "<h1 id='title'></h1>";
  title = container.querySelector("#title");
}
```

After:

```html
<h1 data-fy-text="title"></h1>
```

The controller remains available for DOM that must be created per frame or from data that CSS cannot express.

## 4. Replace `update()` with bindings and CSS

Before:

```js
update({ frame, props }) {
  title.textContent = props.title;
  const intro = Math.min(1, frame / 24);
  title.style.opacity = String(intro);
  title.style.transform = `translateY(${(1 - intro) * 28}px)`;
  sweep.style.width = `${(frame / 149) * 100}%`;
}
```

After:

```html
<h1 class="title"
    data-fy-text="title"
    data-fy-anim-start="0"
    data-fy-anim-duration="24"></h1>
<div class="sweep" style="width: calc(var(--fy-progress) * 100%)"></div>
```

```css
.title {
  animation: fade-up 1s ease-out both;
}

@keyframes fade-up {
  from { opacity: 0; transform: translateY(28px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

Use `data-fy-anim-start`, `data-fy-anim-duration`, and `data-fy-anim-easing` for frame-based scheduling. Use `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, and `--fy-duration` for computed CSS values. If the motion cannot be expressed in CSS, move it to the controller.

## 5. Replace prop-driven DOM with bindings

| Old | New |
| --- | --- |
| `el.textContent = props.title` | `data-fy-text="title"` |
| `el.setAttribute("src", props.image)` | `data-fy-attr-src="image"` |
| `el.classList.toggle("active", props.isActive)` | `data-fy-class-active="isActive"` |
| `if (props.show) ...` | `data-fy-if="show"` |
| `props.items.map(...)` | `<template data-fy-repeat="items">...</template>` |
| `container.style.setProperty("--accent", props.accent)` | `style="color: var(--fy-prop-accent)"` |

Bindings resolve dot paths such as `user.name`. They apply once per load; props are immutable. `data-fy-repeat` provides `item` and `index` in the cloned scope and sets `--fy-index`; nested repeats are not supported.

## 6. Move audio and transcripts to HTML

Before:

```js
audio: [
  {
    src: "assets/voice.wav",
    startFrame: 30,
    trimStart: 0.25,
    trimDuration: 4.2,
    volume: 0.8,
  },
],
transcripts: [
  { src: "assets/voice.transcript.json", words: true },
],
```

After:

```html
<audio src="assets/voice.wav"
       data-fy-start="30"
       data-fy-trim="0.25"
       data-fy-duration="4.2"
       data-fy-volume="0.8"></audio>

<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
```

Audio, video, and `<fy-transcript>` `src` values resolve from the project root. The controller `src` and ordinary HTML assets (`img`, stylesheets) resolve relative to the composition document.

## 7. Rename media attributes

All `data-frameyard-*` media attributes become `data-fy-*`:

| Old | New |
| --- | --- |
| `data-frameyard-start` | `data-fy-start` |
| `data-frameyard-trim` | `data-fy-trim` |
| `data-frameyard-duration` | `data-fy-duration` |
| `data-frameyard-volume` | `data-fy-volume` |
| `data-frameyard-audio` | `data-fy-audio` |

## 8. Move imperative code into a controller

Before:

```js
export default defineComposition({
  // metadata, defaults, audio, transcripts
  mount({ container, props }) { /* ... */ },
  update({ frame, props }) { /* ... */ },
  dispose() { /* ... */ },
  validateProps(props) { /* ... */ },
});
```

After — inline for a small, single-use controller:

```html
<script type="text/fy-controller">
export default {
  validateProps(props) { /* ... */ },
  mount({ root, props }) { /* ... */ },
  update({ frame, props, root }) { /* ... */ },
  dispose() { /* ... */ },
};
</script>
```

After — external for a reusable or complex controller:

```html
<script type="text/fy-controller" src="./hello.controller.js"></script>
```

```js
export default {
  validateProps(props) { /* ... */ },
  mount({ root, props }) { /* ... */ },
  update({ frame, props, root }) { /* ... */ },
  dispose() { /* ... */ },
};
```

A composition has exactly one controller. Inline keeps the composition in one file and is the default for small, single-use controllers. Extract to an external module when the controller grows, is reused, needs separate imports or tests, or drives Canvas 2D, WebGL, or karaoke. The host serves inline source through a virtual module URL, so relative imports and `import.meta.url` behave as they do in an external module.

Inline source is raw text inside `<script>`; a literal `</script>` in a string must be escaped as `<\/script>`. If the controller contains HTML strings or grows large, prefer an external module.

The controller is for Canvas 2D, WebGL, karaoke, arrays that exceed `data-fy-repeat`, and per-frame computation CSS cannot express. It has no metadata, defaults, audio, or transcripts. `mount()` may be asynchronous; `update()` and `validateProps()` are synchronous and seek-safe.

## 9. Remove executable scripts and inline handlers

Only the controller, inline or external, may execute. Remove `<script type="module">` blocks and `on*` attributes; import libraries from the controller instead. JSON data blocks (`type="application/json"`) and the `text/fy-controller` block are allowed. `javascript:` URLs and unsupported visual elements inside the composition (`iframe`, `object`, `embed`) are rejected. The preview's own host iframe is not a composition element.

## 10. Validation and diagnostics

`check`, `still`, and `render` run a Node-side static composition validation before Chromium. It catches metadata, root/controller count, default-props JSON, unknown `data-fy-*` attributes, missing binding paths, repeat misuse, animation attributes, executable scripts, inline handlers, `javascript:` URLs, unsupported visual elements, and missing audio/transcript references.

Errors and warnings are structured:

```json
{
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

`check` exits nonzero on static errors without launching Chromium. Warnings allow frame evaluation but should be treated as actionable. `check`, `still`, and `render` JSON results now include `entry`, `controller`, and top-level `warnings`.

Props domain validation remains controller-only in 0.4. If an HTML-only composition needs required or typed props, add a tiny inline controller with `validateProps`:

```html
<script type="text/fy-controller">
export default {
  validateProps(props) {
    return typeof props.title === "string" ? [] : ["title must be a string"];
  },
};
</script>
```

## 11. Update preview and render expectations

No command changes. Preview loads the composition in a same-origin iframe; `check`, `still`, and `render` navigate directly to the same document. The composition host is injected by the server, so keep composition entries listed in `video.config.js` and run through `frameyard dev` or `frameyard render`, not `file://`.

## Migration checklist

- [ ] Change `video.config.js` entries to `.html`.
- [ ] Move metadata to `<fy-composition>`.
- [ ] Move `defaultProps` to the `data-fy="props"` JSON block.
- [ ] Move `mount()` markup into the document.
- [ ] Replace text, attribute, and class assignments with `data-fy-*` bindings.
- [ ] Replace conditionals and loops with `data-fy-if` and `data-fy-repeat`.
- [ ] Use the controller for nested data; nested `data-fy-repeat` is rejected.
- [ ] Replace `update()` motion with CSS animations, `data-fy-anim-*`, and frame-state variables.
- [ ] Move Canvas 2D, WebGL, karaoke, and complex computation into a controller.
- [ ] Choose an inline or external controller; keep exactly one per composition.
- [ ] If props need domain validation, add an inline `validateProps` controller.
- [ ] Move `audio` and `transcripts` to `<audio>` and `<fy-transcript>`.
- [ ] Rename `data-frameyard-*` media attributes to `data-fy-*`.
- [ ] Remove executable scripts, inline handlers, `javascript:` URLs, and unsupported visual elements inside the composition.
- [ ] Run `check`; treat static errors and warnings as actionable.
- [ ] Inspect representative stills and render.
