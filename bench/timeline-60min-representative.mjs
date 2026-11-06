#!/usr/bin/env node
/**
 * Generates the representative 60-minute 50/50 production gate:
 *
 *   - 1920x1080, 30 fps, 108,000 frames
 *   - 60 copies of the 60-second 60/30/10 occupancy pattern
 *   - 50/50 composition/media by layer-seconds
 *   - 360 clips, 540 ten-second-or-shorter segments
 *
 * Pattern per minute:
 *   0-15s   base composition + PIP overlay composition (2 layers)
 *   15-18s  base composition + video overlay (2 layers)
 *   18-30s  base composition (1 layer)
 *   30-54s  full-frame video (1 layer)
 *   54-60s  full-frame video + video overlay + image (3 layers)
 *
 * Composition layer-seconds: base 30 + overlay 15 = 45.
 * Media layer-seconds: video 3+24+6+6 + image 6 = 45.
 *
 * The video is re-encoded rather than stream-copied, so the measurement is a
 * conservative production baseline.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultTimelineBenchRoot,
  parseTimelineBenchArgs,
  printTimelineBenchOptions,
  repoRoot,
} from "./timeline-bench-config.mjs";

const exec = promisify(execFile);
const options = parseTimelineBenchArgs(process.argv.slice(2));
if (options.help) {
  printTimelineBenchOptions(
    "timeline-60min-representative.mjs",
    "\nGenerates the representative 60-minute 50/50 production gate.\n",
  );
  process.exit(0);
}

const FPS = 30;
const CLIP_FRAMES = 1800;
const MINUTES = 60;
const workRoot = options.work
  ? path.resolve(options.work)
  : path.join(defaultTimelineBenchRoot, "representative-60min");
const projectRoot = options.project ? path.resolve(options.project) : path.join(workRoot, "project");
const outputDir = options.output ? path.resolve(options.output) : path.join(workRoot, "output");
const scratchDir = options.scratch ? path.resolve(options.scratch) : path.join(workRoot, "scratch");
const sourceVideo = path.resolve(repoRoot, "examples", "video", "assets", "clip.mp4");

const base = `<style>
  .stage { position: absolute; inset: 0; overflow: hidden; background: #0b1016; }
  .bar {
    position: absolute; top: 54%; left: calc(var(--fy-progress) * 100%);
    width: 260px; height: 160px; border-radius: 32px;
    background: linear-gradient(135deg, #5fd6ff, #b8f36b);
    transform: translate(-50%, -50%);
  }
</style>
<fy-composition width="1920" height="1080" fps="30" duration-in-frames="${CLIP_FRAMES}">
  <div class="stage"><div class="bar"></div></div>
</fy-composition>
`;

const overlay = `<style>html, body { background: transparent; }</style>
<fy-composition width="640" height="360" fps="30" duration-in-frames="${CLIP_FRAMES}">
  <div style="position: absolute; left: 50%; top: 50%; width: 210px; height: 210px; border-radius: 50%; background: radial-gradient(circle at 32% 28%, #ffffff, #5fd6ff 55%, #1a6dff); transform: translate(-50%, -50%) rotate(calc(var(--fy-progress) * 360deg));"></div>
</fy-composition>
`;

const clips = [];
for (let minute = 0; minute < MINUTES; minute += 1) {
  const baseStart = minute * CLIP_FRAMES;
  const id = (name) => `${name}-${String(minute).padStart(3, "0")}`;
  clips.push({
    id: id("base"),
    track: "v1",
    source: { kind: "composition", id: "base" },
    start: baseStart,
    duration: 900,
    sourceIn: 0,
  });
  clips.push({
    id: id("overlay"),
    track: "v2",
    source: { kind: "composition", id: "overlay" },
    start: baseStart,
    duration: 450,
    sourceIn: 0,
    transform: { fit: "contain", width: 800, height: 450, x: 504, y: -259 },
  });
  clips.push({
    id: id("video-pip"),
    track: "v2",
    source: { kind: "video", src: "assets/clip-1080.mp4" },
    start: baseStart + 450,
    duration: 90,
    sourceIn: 450,
    transform: { fit: "cover", opacity: 0.28 },
    audio: { muted: true },
  });
  clips.push({
    id: id("video"),
    track: "v1",
    source: { kind: "video", src: "assets/clip-1080.mp4" },
    start: baseStart + 900,
    duration: 900,
    sourceIn: 900,
    transform: { fit: "cover" },
    audio: { muted: true },
  });
  clips.push({
    id: id("video-over"),
    track: "v2",
    source: { kind: "video", src: "assets/clip-1080.mp4" },
    start: baseStart + 1620,
    duration: 180,
    sourceIn: 0,
    transform: { fit: "cover", opacity: 0.28 },
    audio: { muted: true },
  });
  clips.push({
    id: id("image"),
    track: "v3",
    source: { kind: "image", src: "assets/badge.png" },
    start: baseStart + 1620,
    duration: 180,
    transform: { fit: "contain", width: 400, height: 400, x: 72, y: -308 },
  });
}

const timeline = {
  version: 1,
  background: "#000000",
  tracks: [
    { id: "v1", kind: "video", name: "Base" },
    { id: "v2", kind: "video", name: "Overlay" },
    { id: "v3", kind: "video", name: "Decor" },
  ],
  clips,
};

const config = `export default {
  format: { width: 1920, height: 1080, fps: ${FPS} },
  compositions: {
    base: "./compositions/base.html",
    overlay: "./compositions/overlay.html",
  },
  timelines: {
    main: "./timelines/main.timeline.json",
  },
};
`;

await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
await mkdir(path.join(projectRoot, "timelines"), { recursive: true });
await mkdir(path.join(projectRoot, "assets"), { recursive: true });
await mkdir(outputDir, { recursive: true });
await mkdir(scratchDir, { recursive: true });
await writeFile(
  path.join(projectRoot, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
);
await writeFile(path.join(projectRoot, "fy.config.js"), config);
await writeFile(path.join(projectRoot, "compositions", "base.html"), base);
await writeFile(path.join(projectRoot, "compositions", "overlay.html"), overlay);
await writeFile(path.join(projectRoot, "timelines", "main.timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

await exec("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-stream_loop",
  "-1",
  "-i",
  sourceVideo,
  "-f",
  "lavfi",
  "-i",
  "anullsrc=r=48000:cl=stereo",
  "-t",
  "60",
  "-vf",
  "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
  "-r",
  String(FPS),
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-g",
  "30",
  "-keyint_min",
  "30",
  "-sc_threshold",
  "0",
  "-shortest",
  "-c:a",
  "aac",
  "-b:a",
  "64k",
  path.join(projectRoot, "assets", "clip-1080.mp4"),
]);

await exec("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=#5fd6ff:s=400x400:d=1",
  "-frames:v",
  "1",
  path.join(projectRoot, "assets", "badge.png"),
]);

const outputPath = path.join(outputDir, "main.mp4");
process.stdout.write(
  `${JSON.stringify(
    {
      project: projectRoot,
      output: outputPath,
      scratch: scratchDir,
      totalFrames: MINUTES * CLIP_FRAMES,
      totalSeconds: (MINUTES * CLIP_FRAMES) / FPS,
      clips: clips.length,
      segments: MINUTES * 9,
    },
    null,
    2,
  )}\n\nRender with:\nFRAMEYARD_TIMINGS=1 node dist/cli.js render main --project ${projectRoot} --workers 8 --scratch ${scratchDir} --out ${outputPath} --overwrite\n`,
);
