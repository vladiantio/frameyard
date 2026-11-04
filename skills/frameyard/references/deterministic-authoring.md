# Deterministic HTML authoring

Frameyard compositions are partial HTML fragments. The preview server wraps them in the document shell and injects the framework import map and composition host; do not add a bundling step. Optional controllers are native JavaScript modules that import bare `frameyard/runtime`.

## Project configuration

`video.config.js` lists every composition explicitly:

```js
export default {
  compositions: {
    hello: "./compositions/hello.html",
  },
};
```

There is no directory scanning. A new composition fragment is invisible until it is listed. Entries must be `.html` files; JavaScript composition modules are rejected.

## Composition shape

```html
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
<fy-composition width="1920" height="1080" fps="30" duration-in-frames="900">
  <h1 id="title"
      data-fy-text="title"
      data-fy-anim-start="0"
      data-fy-anim-duration="30"></h1>
  <div style="width: calc(var(--fy-progress) * 100%)"></div>
</fy-composition>
```

- `duration-in-frames` is required for an animated composition. `width`, `height`, and `fps` are optional: a missing value inherits the project `format`, and a declared value wins. Declare `width` and `height` together or not at all. A composition that declares neither `duration-in-frames` nor `fps` is static.
- The `data-fy="props"` block is a top-level JSON object. External props merge shallowly over it and are deep-frozen.
- There is exactly one `<fy-composition>` root, and it must be a top-level element in the fragment.
- Do not add `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`; Frameyard owns the shell. Props, the controller, and import maps are top-level siblings of the root. Top-level `<style>` and `<link rel="stylesheet">` elements are hoisted into the generated head; styles inside the root stay in the body.
- An optional top-level `<script type="importmap">` adds bare specifiers for controllers. `frameyard` and `frameyard/` specifiers are reserved.
- The reserved `data-fy-host` attribute and `data-fy="format"` block are framework-only. Unsupported features such as `<base>`, refresh/CSP meta tags, `<iframe>`, `<object>`, and `<embed>` are rejected.

## Static compositions

A static composition declares neither `duration-in-frames` nor `fps`. It has no frame clock: Frameyard loads it, applies bindings, runs `mount()`, pauses CSS animations at time 0, and captures one PNG. `update()` is not called and `--fy-frame`, `--fy-time`, `--fy-progress`, `--fy-fps`, `--fy-duration`, and `--fy-duration-frames` are not set.

- Use `<img>`, CSS backgrounds, SVG, and canvas drawn once from `mount()`.
- Do not use `data-fy-anim-*`, `<video>`, `<audio>`, or `<fy-transcript>`; these are validation errors. Put media and captions on a timeline.
- Do not rely on `update()` or frame-state variables. A controller that exports `update()` loads with a `STATIC_UPDATE_IGNORED` warning.
- CSS animations and transitions are paused at 0 with a `STATIC_ANIMATION_PAUSED` warning; remove them for a predictable still.
- In a timeline, a static composition clip needs an explicit `duration` and `sourceIn: 0`.
- `render` writes a PNG and rejects video flags. Use a timeline image clip when the deliverable must be video.

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

## Timeline clip keyframes

CSS `@keyframes` animate elements *inside* a composition. A timeline clip's `keyframes` animate the clip's placement in the edit: `x`, `y`, `scale`, `rotation`, and `opacity`. The two mechanisms compose: a composition may animate internally while its timeline clip also fades or moves.

Timeline keyframes use clip-local integer frames, not composition frames or seconds. Keyframe values are derived only from the integer frame and the declared easing, so they are seek-safe. Preview evaluates the exact CSS timing function; production generates per-frame FFmpeg expressions and approximates the curve. See [timelines](timelines.md) for the contract.

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
- Controller `src` resolves relative to the composition URL. Media and transcript `src` values resolve from the project root.
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

Declare local media in the composition fragment:

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

Images declared in the fragment are awaited by the host. Static fonts should be loaded with `document.fonts.ready` or an explicit `FontFace` before frame production.

## Validation and inspection

```sh
npx frameyard check hello --json
npx frameyard still hello --frame 42 --out hello-42.png --json
npx frameyard still hello --frame 0,118-126 --out out/stills --json
```

`check` runs static validation before Chromium, then evaluates every animated frame and validates audio and declared transcripts without capturing or encoding. A static composition is inspected once. Read the structured `diagnostics` array. Do not replace `check` with a single still. Inspect several representative frames in one `still` call with a range or list; the batch seeks sequentially in one session and is limited to 32 unique frames. A static composition exposes only frame 0.

## Metadata is fixed

`width`, `height`, `fps`, and `duration-in-frames` cannot be derived from props. An animated composition always declares `duration-in-frames`; a static composition declares neither time attribute. `width`, `height`, and `fps` are either declared or inherited from the project `format`, and the resolved values are fixed for the load. A composition that declares no dimensions in a project without `format` fails with `COMPOSITION_FORMAT_UNRESOLVED`. The resolved format is part of the immutable frame environment, so viewport units and percentage layout are valid but depend on it. Put variation in props. Frameyard does not change duration to fit audio.
