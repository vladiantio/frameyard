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

## Static composition benchmark

`pnpm bench:static` renders the same 1280×720 visual twice: once as an animated
composition with 300 frames and once as a static composition with no time
metadata. It reports wall time, output bytes, and the speedup. Override the
frame count with `FRAMEYARD_STATIC_BENCH_FRAMES=<n>`. This is a regression check
for the single-capture path, not a general encoding benchmark.

```sh
pnpm bench:static
```

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
- `ENCODER=libx264|nvenc|qsv` and `QUALITY=<n>`: encoder A/B for the
  representative benchmark. Captures, FFV1 intermediates, and audio stay
  identical; only the final segment encode changes. Run each arm into its own
  `--output` directory.

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

# 6. Generate the 60-minute, one-layer composition-only production gate.
node bench/timeline-60min-gate.mjs --work /path/to/large-disk

# 7. Generate the representative 60-minute 50/50 production gate.
node bench/timeline-60min-representative.mjs --work /path/to/large-disk
```

The 60-minute gate is 108,000 frames, 120 composition clips of 900 frames,
and 360 ten-second segments. The representative generator tiles the 60-second
50/50 pattern 60 times, producing 360 clips and 540 segments; it re-encodes video
rather than stream-copying it, so the result is a conservative production
baseline. Both render through the production CLI rather than a bench-specific
pipeline, so use `FRAMEYARD_TIMINGS=1` and redirect stderr to profile them. The
generators print the exact render command.

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

## Keyframe timeline benchmark

`node bench/keyframe-timeline.mjs` generates a 1280×720, 30 fps timeline with a
full-frame image backdrop and a static composition card animated through `x`,
`y`, `scale`, `rotation`, and `opacity` with a `screen` blend. It renders with
the production segmented pipeline and reports wall time, segment count, and
output bytes.

```sh
pnpm build
node bench/keyframe-timeline.mjs --frames 300 --max-segment-frames 60 --workers 2
```

Use `--work`, `--output`, `--frames`, `--workers`, and `--max-segment-frames` to
point at another disk or workload. This is a measurement tool for the keyframe
composite path, not a CI gate; run it on the reference machine when evaluating a
change to the expression or mask implementation.

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

For production-path stage timings, set `FRAMEYARD_TIMINGS=1` and redirect stderr
to a file. The renderer emits one JSON line per stage (session open, capture,
PNG write, FFV1, composite, concat, audio, publish) without changing the
`--json` stdout result. Summarize it with:

```sh
FRAMEYARD_TIMINGS=1 node dist/cli.js render main --project examples/demo \
  --workers 4 2> timings.jsonl
node bench/summarize-timings.mjs timings.jsonl --segments
```

`FRAMEYARD_FFV1_THREADS=<n>` bounds the streaming FFV1 encoder; `0` uses
FFmpeg's default. Two threads is the default because four concurrent captures
already keep the CPU busy. `FRAMEYARD_CAPTURE_CONCURRENCY=<n>` overrides the
global layer-capture limit; the default is `min(workers * 2, 12)`.
`FRAMEYARD_DISABLE_DUAL_PIPE=1` forces the segmented fallback for a full-frame
composition base plus a static overlay, which is useful for A/B measurements.
`FRAMEYARD_DISABLE_VIDEO_DIRECT=1` forces the composite path for a single
full-frame video.

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
`docs/v0.x-design.md` §3.

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
