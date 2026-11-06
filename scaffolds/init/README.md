# My Frameyard project

Coding agents should read `AGENTS.md` for the project rules and the lint, check, still, and render workflow.

The reusable composition is a partial HTML fragment at `compositions/hello.html`. The edit is `timelines/main.timeline.json`, which places that composition as a clip in the project format. The project format is fixed in `fy.config.js`.

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

Install a font when the design needs one:

```sh
npx frameyard font search "space grotesk" --subset latin --json
npx frameyard font add space-grotesk --subset latin
```

Or vendor a local font:

```sh
npx frameyard font add --file ./fonts/SpaceGrotesk.woff2 \
  --family "Space Grotesk" --license OFL-1.1 --license-file ./fonts/OFL.txt
npx frameyard font verify
```

The server injects the font sheet into every composition; use the family name in CSS. Commit `fy.fonts.json`, `assets/fonts/`, and license files. See `AGENTS.md` for the policy limits.

Or run the pinned scripts from `package.json`:

```sh
npm run dev
npm run check -- main
npm run render -- main --props props/main.json
npm run still -- main --frame 42 --out main-42.png
```
