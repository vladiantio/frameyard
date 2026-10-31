# Frameyard WebGL example

A 12-second, 1920×1080 composition that renders a procedural light field with a
WebGL fragment shader and layers HTML/CSS typography over it:

- a WebGL 1 fullscreen triangle with one cached program and cached uniforms
- shader motion derived only from the composition frame
- props for the kicker, title, subtitle, and accent color
- frame-scheduled CSS typography and a frame-state progress bar
- controller-updated frame and time readouts

The composition lives in `compositions/webgl.html`; the external controller is
`compositions/webgl.controller.js`. Draw every frame from `update()` and do not
rely on the previous drawing buffer. Production sessions pin software WebGL so
the captured pixels do not depend on the host GPU.

From the repository root:

```sh
pnpm build
node dist/cli.js check webgl --project examples/webgl
node dist/cli.js still webgl --frame 210 --project examples/webgl --out webgl-still.png
node dist/cli.js render webgl --project examples/webgl --props examples/webgl/props/webgl.json
```

Start the interactive preview with:

```sh
node dist/cli.js dev --project examples/webgl
```
