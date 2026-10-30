# Deterministic HTML authoring

Frameyard compositions are full HTML documents. The preview server injects the framework import map and composition host; do not add a bundling step. Optional controllers are native JavaScript modules that import bare `frameyard/runtime`.

## Project configuration

`video.config.js` lists every composition explicitly:

```js
export default {
  compositions: {
    hello: "./compositions/hello.html",
  },
};
```

There is no directory scanning. A new composition document is invisible until it is listed. Entries must be `.html` files; JavaScript composition modules are rejected.

## Composition shape

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">
    { "title": "Hello", "accent": "#b8f36b" }
    </script>
    <style>
      @keyframes fade-up {
        from { opacity: 0; transform: translateY(24px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #title { animation: fade-up 1s ease-out both; }
    </style>
  </head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
      <h1 id="title"
          data-fy-text="title"
          data-fy-anim-start="0"
          data-fy-anim-duration="30"></h1>
      <div style="width: calc(var(--fy-progress) * 100%)"></div>
    </fy-composition>
  </body>
</html>
```

- `width`, `height`, `fps`, and `duration-in-frames` are fixed on the root.
- The `data-fy="props"` block is a JSON object. External props merge shallowly over it and are deep-frozen.
- There is exactly one `<fy-composition>` root, inside `<body>`.
- A doctype is required. Unsupported document features such as `<base>`, refresh/CSP meta tags, `<iframe>`, `<object>`, and `<embed>` are rejected.

## Bindings

```html
<h1 data-fy-text="title"></h1>
<img data-fy-attr-src="image" data-fy-attr-alt="alt">
<div data-fy-class-active="isActive"></div>
<p data-fy-if="showSubtitle" data-fy-text="subtitle"></p>
<template data-fy-repeat="items">
  <span data-fy-text="item.label" data-fy-attr-data-index="index"></span>
</template>
```

- Paths are dot-separated (`user.name`, `items.0.label`); numeric segments index arrays.
- `data-fy-text` sets `textContent`.
- `data-fy-attr-<name>` sets an attribute; `true` writes an empty attribute, `false`/`null`/`undefined` remove it.
- `data-fy-class-<name>` toggles one class.
- `data-fy-if` removes the element when the value is false.
- `data-fy-repeat` must be on a `<template>` and must reference an array. Each clone gets `item`, `index`, and `--fy-index`. Nested repeats are rejected; use a controller.
- Bindings apply once per load, before the controller mounts. Controller-created DOM is not re-bound.
- Missing paths warn and resolve to empty text, a removed attribute/class, or false for `if`.
- Primitive top-level props are also exposed as `--fy-prop-<name>` CSS custom properties. Booleans are `1`/`0`; objects and arrays are omitted.

## Animation

CSS `@keyframes` and the Web Animations API are paused and seeked by the runtime inside the composition root.

```css
@keyframes fade-up {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
#title { animation: fade-up 1s ease-out both; }
```

```html
<h1 data-fy-anim-start="30" data-fy-anim-duration="60" data-fy-anim-easing="ease-out"></h1>
```

- `data-fy-anim-start` is a non-negative frame count. `data-fy-anim-duration` is a positive frame count. `data-fy-anim-easing` is a CSS easing.
- One declarative animation per element. The CSS `animation` shorthand supplies keyframes, fill mode, and iteration count; the attributes override delay/duration/easing.
- The root exposes `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, and `--fy-duration-frames`. Use them in `calc()` for simple computed motion and progress bars.
- Do not use CSS transitions. They are diagnosed as non-deterministic.

## Controllers

An optional controller handles Canvas 2D, WebGL, karaoke, and per-frame computation CSS cannot express.

Inline for a small, single-use controller:

```html
<script type="text/fy-controller">
export default {
  mount({ root, props }) {
    // query elements, create canvases, load data
  },
  update({ frame, props, root }) {
    // synchronous and seek-safe
  },
  dispose() {
    // release module-scope state and listeners
  },
};
</script>
```

External for a reusable or complex controller:

```html
<script type="text/fy-controller" src="./hello.controller.js"></script>
```

- Exactly one controller is allowed. It may export `mount`, `update`, `dispose`, and `validateProps`; at least one is required. `mount` may be async; `update` and `validateProps` are synchronous.
- A validation-only controller may export just `validateProps(props)`.
- Inline source is served through a virtual module URL, so relative imports and `import.meta.url` work like an external module. A literal `</script>` inside inline source must be escaped.
- The controller is the only executable code. Other executable `<script>` elements and `on*` handlers are rejected.
- Controller `src` resolves relative to the composition document. Media and transcript `src` values resolve from the project root.
- Keep mutable state in module scope, never on `this`. Reset it in `dispose()`.

## Forbidden animation inputs

Do not use any of these as animation state:

- `Math.random()`
- `Date.now()` or `performance.now()`
- `setTimeout()` or `setInterval()`
- independent `requestAnimationFrame()` loops
- CSS transitions
- state left from a previously visited frame

Use `random("stable:key")` from `frameyard/runtime` for deterministic randomness. The value depends only on the key, not call order.

```js
import { random } from "frameyard/runtime";

const x = random("star:17:x") * 1920;
```

## Canvas and WebGL

Redraw Canvas 2D and WebGL from the current frame in the controller's `update()`:

```js
update({ frame }) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
  context.fillRect(0, 0, canvas.width, canvas.height);

  gl.clearColor(frame % 2 === 0 ? 0.1 : 0.2, 0.1, 0.13, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
```

Do not preserve and accumulate WebGL drawing across frames unless that accumulation is itself deterministic. Production sessions use software WebGL so output does not depend on the host GPU.

## Embedded video and audio

Declare local media in the composition document:

```html
<video
  src="assets/clip.webm"
  data-fy-start="30"
  data-fy-trim="0.5"
  data-fy-duration="4"
  data-fy-volume="0.8"
></video>

<audio
  src="assets/voice.wav"
  data-fy-start="30"
  data-fy-trim="0.25"
  data-fy-duration="4.2"
  data-fy-volume="0.8"
></audio>
```

- `data-fy-start` is the composition frame where the source starts. Default `0`.
- `data-fy-trim` is seconds trimmed from the source start. Default `0`.
- `data-fy-duration` optionally limits how many source seconds are used.
- `data-fy-volume` sets volume from `0` to `1`. Default `1`.

Do not call `play()`, `pause()`, or set `currentTime` in a controller. Media must be in the light DOM; shadow roots are not scanned. Sources must be local project-relative files; live streams, remote URLs, `<source>` children, and `<track>` children are not supported. The runtime loads the complete file during the loading phase and seeks video after each `update()`.

An unmuted video's audio is extracted and mixed into the output timeline. Set `muted` or `data-fy-audio="off"` for a silent visual asset.

## Transcripts

Declare canonical transcript requirements with:

```html
<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
```

`words` requires measured word timings. `check`, `still`, and `render` validate the transcript file. Visual presentation is the composition's responsibility; a controller can fetch the JSON and render timed text or karaoke. See [subtitles and karaoke](subtitles-karaoke.md).

## Loading assets

Remote data, images, fonts, and other assets must resolve during the loading phase before frame production. The production browser blocks network requests after loading begins. A fetch from `update()` is a bug.

Images declared in the document are awaited by the host. Static fonts should be loaded with `document.fonts.ready` or an explicit `FontFace` before frame production.

## Validation and inspection

```sh
npx frameyard check hello --json
npx frameyard still hello --frame 42 --out hello-42.png --json
```

`check` runs static validation before Chromium, then evaluates every frame and validates audio and declared transcripts without capturing or encoding. Read the structured `diagnostics` array. Do not replace `check` with a single still.

## Metadata is fixed

`width`, `height`, `fps`, and `duration-in-frames` cannot be derived from props. Choose a reusable resolution, frame rate, and duration; put variation in props. Frameyard does not change duration to fit audio.
