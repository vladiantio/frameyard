# Static composition example

`compositions/still.html` declares neither `duration-in-frames` nor `fps`, so
Frameyard treats it as a static composition. The project `format` supplies the
1280×720 dimensions. Rendering the composition writes a single PNG; the
timeline uses the same composition as an image layer for 90 frames.

```sh
node dist/cli.js check still --project examples/static
node dist/cli.js render still --project examples/static --out examples/static/out/still.png
node dist/cli.js check still-timeline --project examples/static
node dist/cli.js render still-timeline --project examples/static --out examples/static/out/still-timeline.mp4
```

`render still` defaults to `out/still.png`. Static compositions render to PNG;
`--container`, `--codec`, `--encoder`, and `--concurrency` are not valid for
them. Use the timeline when you need a video, audio, or a duration.
