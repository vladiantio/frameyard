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

## Canvas and WebGL

CSS `@keyframes` and the Web Animations API are paused and seeked by the runtime inside the composition container. They are valid animation drivers. CSS transitions are diagnosed as non-deterministic and should not be used.

Canvas 2D and WebGL must be redrawn from the current frame:

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

## Embedded video

Place local `<video>` elements in `mount()` and let the runtime seek them:

```html
<video
  src="assets/clip.webm"
  data-frameyard-start="30"
  data-frameyard-trim="0.5"
  data-frameyard-duration="4"
  data-frameyard-volume="0.8"
></video>
```

- `data-frameyard-start` is the composition frame where the source starts. Default `0`.
- `data-frameyard-trim` is seconds trimmed from the source start. Default `0`.
- `data-frameyard-duration` optionally limits how many source seconds are used.
- `data-frameyard-volume` sets embedded-audio volume from `0` to `1`. Default `1`.

Do not call `play()`, `pause()`, or set `currentTime` in `update()`. Create video elements and set the `data-frameyard-*` attributes in `mount()`. Videos must be in the composition container's light DOM; shadow roots are not scanned. The runtime pauses every video, loads the complete local file during the loading phase, and seeks it after each `update()` before capture. Video sources must be local, seekable project files; live streams, remote URLs, and videos added or changed during `update()` are not supported.

An unmuted video's audio is extracted and mixed into the output timeline. Set `muted` or `data-frameyard-audio="off"` for a silent visual asset. The same start, trim, duration, and volume attributes place its audio.

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
