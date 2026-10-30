# Frameyard demo

A 30-second, 1920×1080 HTML composition that exercises the current core:

- HTML and CSS layout, including seeked CSS keyframe animation
- deterministic Canvas 2D starfield in an external controller
- SVG path drawing and data bars updated from the frame
- JSON props for the title, subtitle, and accent color
- an `<audio>` timeline with repeated local chime clips
- frame-state CSS variables for the progress bar

The composition lives in `compositions/demo.html`; the optional controller is
`compositions/demo.controller.js`.

From the repository root:

```sh
pnpm build
node dist/cli.js check demo --project examples/demo
node dist/cli.js still demo --frame 240 --project examples/demo --out demo-still.png
node dist/cli.js render demo --project examples/demo --props examples/demo/props/demo.json --out demo.mp4
```

Start the interactive preview with:

```sh
node dist/cli.js dev --project examples/demo
```
