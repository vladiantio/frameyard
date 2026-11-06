# Frameyard intro film

A 20-second, 1920×1080, 60 fps launch film for Frameyard, authored entirely
with HTML compositions and one JSON timeline.

- four scene compositions — `opening`, `studio`, `lattice`, and `brand`
- a persistent `chrome` HUD overlay with a live frame counter, progress bar,
  and chapter label driven by an external controller
- three 30-frame dissolves on one video track
- a deterministic Canvas 2D frame tunnel in `lattice.controller.js`
- Figtree, Space Mono, and Instrument Serif vendored as project fonts
- an original 120 BPM score, synthesized from scratch and mixed in Node
- deterministic film grain generated as a reusable PNG

The story runs **author → compose → render → frameyard**, and the timeline
mirrors it:

| Frames | Scene | Copy |
| --- | --- | --- |
| 0–300 | `opening` | “THE WEB / is the studio.” |
| 270–600 | `studio` | “THE TIMELINE / is the score.” |
| 570–900 | `lattice` | “THE FRAME / is the truth.” |
| 870–1200 | `brand` | FRAMEYARD lockup and `npx frameyard init my-video` |

The scene clips overlap by 30 frames, and `timelines/intro.timeline.json`
declares one dissolve per overlap. The HUD is a separate clip on its own track,
so it stays above every scene and survives the transitions.

## Run it

From the repository root:

```sh
pnpm build
node dist/cli.js lint intro --project examples/intro
node dist/cli.js check intro --project examples/intro
node dist/cli.js still intro --frame 1140 --project examples/intro --out examples/intro/out/intro-still.png
FRAMEYARD_POLICY=full node dist/cli.js render intro --project examples/intro
```

`render` writes `examples/intro/out/intro.mp4`. Preview the full timeline with:

```sh
node dist/cli.js dev --project examples/intro
```

## Assets

The score and grain are generated, not downloaded, and both scripts are
deterministic. Regenerate them with:

```sh
node examples/intro/scripts/make-score.mjs
node examples/intro/scripts/make-grain.mjs
```

`assets/score.ogg` is a 20-second, 48 kHz stereo mix, encoded as Ogg Vorbis
(q6) from the deterministic WAV master: D minor pads and a plucked arpeggio
through the first three movements, a D major impact and shimmer for the final
lockup, and a short fade at the tail.

The fonts are pinned in `fy.fonts.json` and served as generated
`@font-face` rules. Verify the files and hashes with:

```sh
node dist/cli.js font verify --project examples/intro
```

Each of the four scenes reads its copy from a `data-fy="props"` block, so a
composition render can override strings or the accent color through `--props`
without editing the HTML.
