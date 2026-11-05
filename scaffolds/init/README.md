# My Frameyard project

Coding agents should read `AGENTS.md` for the project rules and the lint, check, still, and render workflow.

The reusable composition is a partial HTML fragment at `compositions/hello.html`. The edit is `timelines/main.timeline.json`, which places that composition as a clip in the project format. The project format is fixed in `video.config.js`.

Start the preview:

```sh
npx frameyard dev
```

The preview lists the timeline next to the compositions. Open the timeline to scrub it and inspect the program monitor.

Validate and render the timeline:

```sh
npx frameyard doctor
npx frameyard check main
npx frameyard render main --props props/main.json
```

`props/main.json` maps composition clip IDs to props overrides. The video is written to `out/main.mp4` in the project. Pass `--out <file.mp4>` to choose another path. Timelines with heavy composition work accept `--workers <n>` and `--scratch <dir>`.

The composition can still be previewed and rendered on its own:

```sh
npx frameyard check hello
npx frameyard render hello --props props/hello.json
```

Or run the pinned scripts from `package.json`:

```sh
npm run dev
npm run check -- main
npm run render -- main --props props/main.json
npm run still -- main --frame 42 --out main-42.png
```
