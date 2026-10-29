# Deterministic authoring

Frameyard compositions are ordinary native JavaScript ES modules. The preview server injects an import map for `frameyard` and `frameyard/runtime`; do not add a bundling step or import from `node_modules` in composition code.

## Project configuration

`video.config.js` lists every composition explicitly:

```js
export default {
  compositions: {
    hello: "./compositions/hello.js",
  },
};
```

There is no directory scanning. A new composition file is invisible until it is listed.

## Composition shape

```js
import { defineComposition } from "frameyard";
import { random } from "frameyard/runtime";

let title;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 900,
  defaultProps: { title: "Hello" },
  validateProps(props) {
    return typeof props.title === "string" ? [] : ["title must be a string"];
  },
  mount({ container, props }) {
    container.innerHTML = "<h1 id='title'></h1>";
    title = container.querySelector("#title");
    title.textContent = props.title;
  },
  update({ frame, props }) {
    title.textContent = props.title;
    title.style.transform = `translateX(${random("title:" + frame) * 40}px)`;
  },
  dispose() {
    title = undefined;
  },
});
```

- `mount()` runs once and may await loading work.
- `update({ frame, props })` is synchronous and seek-safe.
- `dispose()` releases resources and module-scope references.
- Props are JSON-serializable, deep-frozen, and merged shallowly over `defaultProps`.
- Keep mutable state in module-scope variables, never on `this`.

## Forbidden animation inputs

Do not use any of these as animation state:

- `Math.random()`
- `Date.now()` or `performance.now()`
- `setTimeout()` or `setInterval()`
- independent `requestAnimationFrame()` loops
- CSS transitions
- state left from a previously visited frame

Use `random("stable:key")` for deterministic randomness. The value depends only on the key, not call order.

```js
import { random } from "frameyard/runtime";

const x = random("star:17:x") * width;
```

## CSS and Canvas

CSS `@keyframes` and the Web Animations API are paused and seeked by the runtime inside the composition container. They are valid animation drivers. CSS transitions are diagnosed as non-deterministic and should not be used.

Canvas 2D must be redrawn from the current frame:

```js
update({ frame }) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
  context.fillRect(0, 0, canvas.width, canvas.height);
}
```

## Loading assets

Remote data, images, fonts, and other assets must resolve during `mount()` or before the first frame. The production browser blocks network requests after loading begins. A fetch from `update()` is a bug.

Images inserted in `mount()` are awaited by the runtime. Static fonts should be loaded with `document.fonts.ready` or an explicit `FontFace` before frame production.

## Validation and inspection

```sh
npx frameyard check hello --json
npx frameyard still hello --frame 42 --out hello-42.png --json
```

`check` mounts the composition, evaluates every frame, and validates audio and declared transcripts without capturing or encoding. Do not replace it with a single still.

## Metadata is fixed

`width`, `height`, `fps`, and `durationInFrames` cannot be derived from props. Choose a reusable resolution, frame rate, and duration; put variation in props. Frameyard does not change duration to fit audio.
