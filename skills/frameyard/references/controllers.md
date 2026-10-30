# Controllers

A composition controller is optional JavaScript for what HTML and CSS cannot express: Canvas 2D, WebGL, karaoke, complex computed motion, or data-driven DOM. It is the only executable code in a composition.

## Inline or external

Inline for a small, single-use controller:

```html
<script type="text/fy-controller">
export default {
  mount({ root, props }) {
    // create canvases, query elements, load data
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

External for reuse, tests, or a large controller:

```html
<script type="text/fy-controller" src="./hello.controller.js"></script>
```

```js
export default {
  mount({ root, props }) {},
  update({ frame, props, root }) {},
  dispose() {},
};
```

Exactly one controller is allowed. Inline source is served through a virtual module URL, so relative imports and `import.meta.url` work like an external module. A literal `</script>` inside inline source must be escaped.

## Lifecycle

- `mount({ root, props })` runs once per load and may be asynchronous. Use it to query the root, create canvases, and start loading local data.
- `update({ frame, props, root })` runs on every seek. It must be synchronous and seek-safe: derive the frame from `frame` and `props` only.
- `dispose()` releases resources and resets module-scope state. The host calls it before remounting or disposing the document.
- `validateProps(props)` is optional and synchronous. Return an array of human-readable errors, or `void`.
- A validation-only controller may export just `validateProps`.

Keep mutable state in module scope, never on `this`. The controller module is imported once per document; `load` remounts it without re-importing, so `dispose` must reset module state.

## Props validation

```html
<script type="text/fy-controller">
export default {
  validateProps(props) {
    const errors = [];
    if (typeof props.title !== "string") errors.push("title must be a string");
    return errors;
  },
};
</script>
```

Validation runs before the old mount is disposed. Invalid props reject `load` with `PROPS_INVALID` and keep the current composition mounted.

## Canvas and WebGL

```js
let canvas;
let context;

export default {
  mount({ root }) {
    canvas = root.querySelector("#field");
    context = canvas.getContext("2d");
  },
  update({ frame }) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
    context.fillRect(0, 0, canvas.width, canvas.height);
  },
  dispose() {
    canvas = undefined;
    context = undefined;
  },
};
```

Redraw WebGL from the current frame; do not depend on the previous drawing buffer. Production pins SwiftShader.

## Randomness and clocks

Import `random` from `frameyard/runtime`:

```js
import { random } from "frameyard/runtime";

const x = random("star:17:x") * 1920;
```

Never use `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions as animation inputs. The host diagnoses common cases in `mount` and `update`.

## Media

Prefer declarative `<video>`/`<audio>` elements with `data-fy-*` attributes. The host pauses and seeks them; do not call `play()`, `pause()`, or set `currentTime` in `update()`. Media created by the controller is allowed in `mount`; media added or changed in `update` cannot be prepared without network access.

Media and transcript `src` values resolve from the project root. The controller `src` resolves relative to the composition document.

## Karaoke

Read the declared transcript JSON, convert source milliseconds to frames, and render the active segment or word from `frame`:

```js
const FPS = 30;
const clipStartFrame = 30;
const trimStart = 0.25;

function wordProgress(word, frame) {
  const start = clipStartFrame + (word.startMs / 1000 - trimStart) * FPS;
  const end = clipStartFrame + (word.endMs / 1000 - trimStart) * FPS;
  return Math.max(0, Math.min(1, (frame - start) / Math.max(1, end - start)));
}
```

Never interpolate segment timings to fake word timings.
