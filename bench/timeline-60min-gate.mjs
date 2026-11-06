#!/usr/bin/env node
/**
 * Generates the 60-minute composition-only long-form gate:
 *
 *   108,000 frames at 30 fps (3,600 s)
 *   120 full-frame composition clips of 900 frames (30 s)
 *   360 ten-second segments
 *   one active composition layer per frame
 *
 * The gate is intentionally stricter than the representative 50/50 mix: every
 * frame is captured from Chromium. It exercises the production CLI path, not a
 * separate bench pipeline.
 *
 *   node bench/timeline-60min-gate.mjs --work /path/to/large-disk
 *   FRAMEYARD_TIMINGS=1 node dist/cli.js render main \
 *     --project /path/to/large-disk/project --workers 4 \
 *     --scratch /path/to/large-disk/scratch \
 *     --out /path/to/large-disk/output/main.mp4 --overwrite
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultTimelineBenchRoot,
  parseTimelineBenchArgs,
  printTimelineBenchOptions,
} from "./timeline-bench-config.mjs";

const options = parseTimelineBenchArgs(process.argv.slice(2));
if (options.help) {
  printTimelineBenchOptions(
    "timeline-60min-gate.mjs",
    "\nGenerates the 60-minute, one-layer composition-only production gate.\n",
  );
  process.exit(0);
}

const FPS = 30;
const CLIP_FRAMES = 900;
const CLIPS = 120;
const TOTAL_FRAMES = CLIP_FRAMES * CLIPS;
const workRoot = options.work ? path.resolve(options.work) : path.join(defaultTimelineBenchRoot, "60min");
const projectRoot = options.project ? path.resolve(options.project) : path.join(workRoot, "project");
const outputDir = options.output ? path.resolve(options.output) : path.join(workRoot, "output");
const scratchDir = options.scratch ? path.resolve(options.scratch) : path.join(workRoot, "scratch");

const base = `<style>
  .stage { position: absolute; inset: 0; overflow: hidden; background: #0b1016; }
  .grid {
    position: absolute; inset: 0; opacity: 0.22;
    background-image:
      linear-gradient(to right, #ffffff22 1px, transparent 1px),
      linear-gradient(to bottom, #ffffff22 1px, transparent 1px);
    background-size: 120px 120px;
  }
  h1 {
    position: absolute; left: 96px; top: 84px; margin: 0; color: #f4f7fb;
    font: 800 96px/1 system-ui, sans-serif; letter-spacing: -0.04em;
  }
  .sub { position: absolute; left: 100px; top: 196px; color: #8fa3b8; font: 500 30px/1.2 system-ui, sans-serif; }
  .bar {
    position: absolute; top: 54%; left: calc(var(--fy-progress) * 100%);
    width: 260px; height: 160px; border-radius: 32px;
    background: linear-gradient(135deg, #5fd6ff, #b8f36b);
    transform: translate(-50%, -50%);
    box-shadow: 0 40px 120px #5fd6ff55;
  }
  .rail { position: absolute; left: 90px; right: 90px; top: 54%; height: 1px; background: #ffffff22; }
</style>
<fy-composition width="1920" height="1080" fps="30" duration-in-frames="${CLIP_FRAMES}">
  <div class="stage">
    <div class="grid"></div>
    <h1>BASE</h1>
    <div class="sub">60-minute composition-only gate</div>
    <div class="rail"></div>
    <div class="bar"></div>
  </div>
</fy-composition>
`;

const clips = Array.from({ length: CLIPS }, (_, index) => ({
  id: `base-${String(index).padStart(3, "0")}`,
  track: "v1",
  source: { kind: "composition", id: "base" },
  start: index * CLIP_FRAMES,
  duration: CLIP_FRAMES,
  sourceIn: 0,
}));

const timeline = {
  version: 1,
  background: "#000000",
  tracks: [{ id: "v1", kind: "video", name: "Composition" }],
  clips,
};

const config = `export default {
  format: { width: 1920, height: 1080, fps: ${FPS} },
  compositions: {
    base: "./compositions/base.html",
  },
  timelines: {
    main: "./timelines/main.timeline.json",
  },
};
`;

await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
await mkdir(path.join(projectRoot, "timelines"), { recursive: true });
await mkdir(outputDir, { recursive: true });
await mkdir(scratchDir, { recursive: true });
await writeFile(
  path.join(projectRoot, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
);
await writeFile(path.join(projectRoot, "fy.config.js"), config);
await writeFile(path.join(projectRoot, "compositions", "base.html"), base);
await writeFile(path.join(projectRoot, "timelines", "main.timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

const outputPath = path.join(outputDir, "main.mp4");
process.stdout.write(
  `${JSON.stringify(
    {
      project: projectRoot,
      output: outputPath,
      scratch: scratchDir,
      totalFrames: TOTAL_FRAMES,
      totalSeconds: TOTAL_FRAMES / FPS,
      clips: CLIPS,
      segments: TOTAL_FRAMES / (FPS * 10),
    },
    null,
    2,
  )}\n\nRender with:\nFRAMEYARD_TIMINGS=1 node dist/cli.js render main --project ${projectRoot} --workers 4 --scratch ${scratchDir} --out ${outputPath} --overwrite\n`,
);
