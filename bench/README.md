# Render benchmark

`pnpm bench` builds the runtime and runs `scripts/bench-render.mjs`. The script
opens the production composition host in a real Chromium session, measures seek,
capture, and FFmpeg encode cost, and optionally runs the production render end to
end.

## Reference workloads

- `examples/demo`: 1920×1080, 900 frames, CSS animations, and audio.
- `bench/fixtures`: controlled 1920×1080, 90-frame compositions covering flat
  fills, gradients, text, blur, a full-screen WebGL shader, and an embedded
  video. The fixtures are intentionally small enough to run often but still
  exercise the production capture path. The video fixture uses a 3-second
  320×180 VP9 test clip generated with FFmpeg's `testsrc2`.

## Common commands

```sh
# Build first when invoking the script directly.
pnpm build

# Fast smoke test: sample 12 frames, no full render.
node scripts/bench-render.mjs --fixtures --quick

# Sample only capture and seek, with no encode or full render.
node scripts/bench-render.mjs --project examples/demo --frames 24 --warmup 4 --no-full --no-encode

# Measure the production render with four browser sessions.
node scripts/bench-render.mjs --project examples/demo --concurrency 4 --frames 24
```

`pnpm bench --fixtures --quick` also works; use the direct `node` form when
passing `--browser-arg` values that start with `--`.

## Timeline benchmarks

The timeline benchmarks are measurement tools, not production commands. They
default to generated directories under `out/bench/timeline/` (gitignored) and
accept explicit paths for larger disks. Run `node <script> --help` for the
shared options.

Common options:

- `--work <dir>`: base directory for generated projects and outputs.
- `--project <dir>`: existing generated project.
- `--source-project <dir>`: project to copy or reuse.
- `--output <dir>`: artifacts (stills, segments, final MP4, result JSON).
- `--scratch <dir>`: intermediate segments and frames. Defaults to `--output`.
- `--workers <n>`: segment concurrency for the representative benchmark.

Run the chain in order:

```sh
# 1. Generate the spike project and frame comparisons.
node bench/timeline-spike.mjs

# 2. Measure a 10-second lossless segment (FFV1 + FFmpeg composite).
node bench/timeline-lossless-segment.mjs

# 3. Build the 60-second three-layer project and measure it.
node bench/timeline-60s.mjs

# 4. Measure the continuous 50/50 stress case.
node bench/timeline-5050-60s.mjs

# 5. Measure the representative 50/50, 60/30/10 case.
node bench/timeline-representative-60s.mjs --workers 4
```

Point long runs at a larger disk without editing source:

```sh
node bench/timeline-representative-60s.mjs \
  --project out/bench/timeline/60s/project \
  --output /path/to/bench-output \
  --scratch /path/to/bench-scratch \
  --workers 4
```

The scripts use the built modules under `dist/`; run `pnpm build` after changing
source. Results are written to `<output>/result.json`. The full 60-minute
production gate is a separate CLI render; use a composition-heavy timeline and
`node dist/cli.js render <id> --workers <n> --scratch <dir>`.

## Browser-flag experiments

`--browser-arg <flag>` adds a Chromium flag for one benchmark run, and
`--no-browser-arg <flag>` removes a production flag. Both are repeatable and
bench-only:

```sh
# Compare production flags with software compositing removed.
node scripts/bench-render.mjs --fixtures --quick --capture png-fast \
  --no-browser-arg=--disable-gpu-compositing

# Try a candidate flag without editing source.
node scripts/bench-render.mjs --project examples/demo --frames 24 \
  --browser-arg=--enable-gpu-rasterization
```

Production browser flags live in `src/renderer/browser.ts`. Never patch
`dist/` for an experiment; `dist/` is generated and `pnpm build` overwrites it.
The JSON result records the effective additions and removals under `settings`.

## Reading the results

- `seek` is the host seek plus media settle; it is usually a few milliseconds.
- `capture` is `Page.captureScreenshot`; it dominates typical 1080p frames.
- `encode` overlaps capture in a production render; it matters when capture is
  very cheap.
- `fullRender` is the real CLI path, including startup, audio inspection, and
  process cleanup.

Timings are machine-dependent. For an A/B comparison, alternate the two variants
and compare medians rather than single runs. `--json` records the requested
additions and removals plus the effective browser args under `settings`.

## Determinism

Compare captured **PNG** pixels, or `still` output, when checking determinism.
The `pixelCheck` field compares decoded `png` and `png-fast` captures, and the
CLI end-to-end suite compares PNGs from two concurrent `still` sessions.

Do not use encoded MP4 bytes or a decoded-video hash as a determinism check.
x264 threading and rate control can change decoded pixels at larger frame
counts even when the captured PNGs are identical. See `AGENTS.md` and
`docs/v0.1-design.md` §3.

## Known findings

- `Page.captureScreenshot` has a large fixed per-frame cost. At 1080p, capture
  usually dominates seek and encode. See
  `docs/adr/0009-composite-production-frames-in-software.md`.
- Software compositing (`--disable-gpu-compositing`) is faster than routing
  captures through GPU-process compositing while keeping WebGL on SwiftShader.
  Video and 2D capture costs improve substantially; WebGL capture can pay a
  small penalty. Measure both with `--fixtures`.
- Capture gains do not always translate one-for-one to full-render time.
  Encoding, browser startup, and media settle can dominate a short composition,
  so measure `fullRender` as well as `capture`.
- A JPEG intermediate is not a meaningful win once software compositing removes
  the copy bottleneck, and it sacrifices lossless frames.
- The double `requestAnimationFrame` after a media seek is a deliberate
  determinism guarantee, not incidental overhead. See ADR 0006.
- Parallel rendering stays opt-in. Measure `--concurrency` on the target
  machine; higher is not always faster. See ADR 0005.
