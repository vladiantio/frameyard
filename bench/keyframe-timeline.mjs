import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadProject } from "../dist/project.js";
import { renderTimeline } from "../dist/renderer/timeline.js";

const exec = promisify(execFile);

function parseArgs(argv) {
  const options = {
    work: "out/bench/keyframes",
    output: undefined,
    frames: 300,
    workers: 2,
    maxSegmentFrames: 60,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node bench/keyframe-timeline.mjs [options]

Options:
  --work <dir>                 Base directory for the generated project.
  --output <dir>               Output directory for the render. Defaults to --work.
  --frames <n>                 Timeline frame count. Defaults to 300.
  --workers <n>                Segment worker count. Defaults to 2.
  --max-segment-frames <n>     Segment length. Defaults to 60.

The benchmark renders a static composition card with animated position, scale,
rotation, opacity, and a screen blend over a full-frame image. It reports the
render wall time and output size; it is a measurement tool, not a gate.`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;
    switch (argument) {
      case "--work":
        options.work = value;
        break;
      case "--output":
        options.output = value;
        break;
      case "--frames":
        options.frames = Number(value);
        break;
      case "--workers":
        options.workers = Number(value);
        break;
      case "--max-segment-frames":
        options.maxSegmentFrames = Number(value);
        break;
      default:
        throw new Error(`Unknown option ${argument}.`);
    }
  }
  for (const [name, value] of [
    ["frames", options.frames],
    ["workers", options.workers],
    ["maxSegmentFrames", options.maxSegmentFrames],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer.`,
      );
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
await mkdir(options.work, { recursive: true });
const root = await mkdtemp(path.join(options.work, "run-"));
const output = options.output ?? root;
await mkdir(path.join(root, "compositions"), { recursive: true });
await mkdir(path.join(root, "timelines"), { recursive: true });
await mkdir(path.join(root, "assets"), { recursive: true });
await mkdir(output, { recursive: true });

await writeFile(
  path.join(root, "compositions", "card.html"),
  `<style>
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
    .card {
      position: absolute; inset: 40px; border-radius: 28px;
      background: linear-gradient(135deg, rgba(184,243,107,.28), rgba(95,214,255,.1) 60%, rgba(8,11,16,.9));
      border: 1px solid rgba(184,243,107,.45);
    }
  </style>
  <fy-composition width="640" height="360"><div class="card"></div></fy-composition>
`,
);

const frames = options.frames;
const enter = Math.max(1, Math.round(frames * 0.08));
const hold = Math.max(enter + 1, Math.round(frames * 0.8));
const timeline = {
  version: 1,
  background: "#080b10",
  tracks: [
    { id: "v1", kind: "video" },
    { id: "v2", kind: "video" },
  ],
  clips: [
    {
      id: "backdrop",
      track: "v1",
      source: { kind: "image", src: "assets/backdrop.png" },
      start: 0,
      duration: frames,
      sourceIn: 0,
    },
    {
      id: "card",
      track: "v2",
      source: { kind: "composition", id: "card" },
      start: 0,
      duration: frames,
      sourceIn: 0,
      blend: "screen",
      keyframes: {
        opacity: [
          { frame: 0, value: 0 },
          { frame: enter, value: 1, easing: "ease-out" },
          { frame: hold, value: 1 },
          { frame: frames, value: 0, easing: "ease-in" },
        ],
        x: [
          { frame: 0, value: -120, easing: "ease-out" },
          { frame: enter, value: 0 },
          { frame: hold, value: 0 },
          { frame: frames, value: 120, easing: "ease-in" },
        ],
        y: [
          { frame: 0, value: 48, easing: "ease-out" },
          { frame: enter, value: 0 },
          { frame: hold, value: 0 },
          { frame: frames, value: -32, easing: "ease-in" },
        ],
        scale: [
          { frame: 0, value: 0.42, easing: "ease-out" },
          { frame: enter, value: 0.5 },
          { frame: hold, value: 0.5 },
          { frame: frames, value: 0.46, easing: "ease-in" },
        ],
        rotation: [
          { frame: 0, value: -8, easing: "ease-out" },
          { frame: enter, value: 0 },
          { frame: hold, value: 0 },
          { frame: frames, value: 8, easing: "ease-in" },
        ],
      },
    },
  ],
};

await writeFile(path.join(root, "timelines", "main.json"), `${JSON.stringify(timeline, null, 2)}\n`);
await writeFile(
  path.join(root, "fy.config.js"),
  `export default {
    format: { width: 1280, height: 720, fps: 30 },
    compositions: { card: "./compositions/card.html" },
    timelines: { main: "./timelines/main.json" },
  };\n`,
);

await exec("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=#0a1018:s=1280x720:d=1",
  "-frames:v",
  "1",
  path.join(root, "assets", "backdrop.png"),
]);

const project = await loadProject(root);
const videoPath = path.join(output, "keyframes.mp4");
const startedAt = performance.now();
const result = await renderTimeline({
  project,
  timelineId: "main",
  outPath: videoPath,
  workers: options.workers,
  maxSegmentFrames: options.maxSegmentFrames,
  encoder: "software",
  overwrite: true,
});
const wallMs = performance.now() - startedAt;

const summary = {
  project: root,
  output: videoPath,
  frames: result.framesRendered,
  segments: result.segments,
  workers: result.workers,
  maxSegmentFrames: options.maxSegmentFrames,
  elapsedMs: result.elapsedMs,
  wallMs,
  bytes: result.bytes,
  diagnostics: result.diagnostics,
};
console.log(JSON.stringify(summary, null, 2));
