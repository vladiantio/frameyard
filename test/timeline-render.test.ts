import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";
import { captureTimelineStill, checkTimeline, renderTimeline } from "../src/renderer/timeline.ts";

const exec = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const roots: string[] = [];

const compositionHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }
      .dot { position: absolute; left: calc(var(--fy-progress) * 100%); top: 50%; width: 30px; height: 30px; border-radius: 50%; background: #b8f36b; }
    </style>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div class="dot"></div>
    </fy-composition>
  </body>
</html>
`;

async function createProject(): Promise<{ root: string; outPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-render-"));
  roots.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "compositions", "intro.html"), compositionHtml);
  await copyFile(
    path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
    path.join(root, "assets", "chime.wav"),
  );
  await writeFile(
    path.join(root, "timelines", "main.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [
          { id: "v1", kind: "video" },
          { id: "a1", kind: "audio" },
        ],
        clips: [
          {
            id: "intro",
            track: "v1",
            source: { kind: "composition", id: "intro" },
            start: 0,
            duration: 10,
          },
          {
            id: "music",
            track: "a1",
            source: { kind: "audio", src: "assets/chime.wav" },
            start: 0,
            duration: 10,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "video.config.js"),
    `export default {
      format: { width: 320, height: 180, fps: 10 },
      compositions: { intro: "./compositions/intro.html" },
      timelines: { main: "./timelines/main.json" },
    };\n`,
  );
  return { root, outPath: path.join(root, "out", "main.mp4") };
}

async function probe(filePath: string) {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,width,height,nb_read_frames,duration",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(stdout) as { streams: Array<Record<string, unknown>> };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("timeline rendering", () => {
  it("checks every timeline frame and its audio without capturing", async () => {
    const { root } = await createProject();
    const project = await loadProject(root);

    const result = await checkTimeline({ project, timelineId: "main" });

    expect(result.timeline).toBe("main");
    expect(result.entry).toBe("timelines/main.json");
    expect(result.framesChecked).toBe(10);
    expect(result.tracks).toBe(2);
    expect(result.clips).toBe(2);
    expect(result.audio.clips).toBe(1);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  }, 120_000);

  it("captures a timeline still through the clip composite path", async () => {
    const { root } = await createProject();
    const project = await loadProject(root);
    const stillPath = path.join(root, "out", "frame.png");

    const result = await captureTimelineStill({
      project,
      timelineId: "main",
      frame: 5,
      outPath: stillPath,
    });

    expect(result.timeline).toBe("main");
    expect(result.frame).toBe(5);
    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect((await stat(stillPath)).size).toBeGreaterThan(0);
    const streams = (await probe(stillPath)).streams;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      width: 320,
      height: 180,
    });
  }, 120_000);

  it("renders a composition and timeline audio through the segmented pipeline", async () => {
    const { root, outPath } = await createProject();
    const project = await loadProject(root);

    const result = await renderTimeline({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
    });

    expect(result.timeline).toBe("main");
    expect(result.entry).toBe("timelines/main.json");
    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect(result.fps).toBe(10);
    expect(result.durationInFrames).toBe(10);
    expect(result.framesRendered).toBe(10);
    expect(result.segments).toBe(1);
    expect(result.audio.clips).toBe(1);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect((await stat(outPath)).size).toBeGreaterThan(0);

    const streams = (await probe(outPath)).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ width: 320, height: 180, nb_read_frames: "10" });
    expect(audio).toBeDefined();
  }, 120_000);
});

async function customRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-render-"));
  roots.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  return root;
}

async function mediaPixel(framePath: string, x = 10, y = 10): Promise<[number, number, number]> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      framePath,
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  return [buffer[0] ?? 0, buffer[1] ?? 0, buffer[2] ?? 0];
}

describe("timeline rendering media and alpha", () => {
  it("renders image and video clips across multiple segments", async () => {
    const root = await customRoot();
    await copyFile(
      path.join(repoRoot, "examples", "video", "assets", "clip.mp4"),
      path.join(root, "assets", "clip.mp4"),
    );
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#2255cc:s=320x180:d=1",
      "-frames:v",
      "1",
      path.join(root, "assets", "frame.png"),
    ]);
    await writeFile(
      path.join(root, "timelines", "main.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "image",
              track: "v1",
              source: { kind: "image", src: "assets/frame.png" },
              start: 0,
              duration: 5,
            },
            {
              id: "video",
              track: "v1",
              source: { kind: "video", src: "assets/clip.mp4" },
              start: 5,
              duration: 5,
              sourceIn: 0,
              audio: { muted: true },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "video.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimeline({ project, timelineId: "main", outPath, workers: 2 });

    expect(result.durationInFrames).toBe(10);
    expect(result.segments).toBe(2);
    expect(result.audio.clips).toBe(0);
    const streams = (await probe(outPath)).streams;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      width: 320,
      height: 180,
      nb_read_frames: "10",
    });
  }, 120_000);

  it("includes audio declared inside a composition clip", async () => {
    const root = await customRoot();
    await copyFile(
      path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
      path.join(root, "assets", "chime.wav"),
    );
    await writeFile(
      path.join(root, "compositions", "intro.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; width: 100%; height: 100%; background: #202830; }</style>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <audio src="assets/chime.wav" data-fy-start="0" data-fy-duration="0.6"></audio>
    </fy-composition>
  </body>
</html>
`,
    );
    await writeFile(
      path.join(root, "timelines", "main.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "intro",
              track: "v1",
              source: { kind: "composition", id: "intro" },
              start: 0,
              duration: 10,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "video.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { intro: "./compositions/intro.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimeline({ project, timelineId: "main", outPath, workers: 1 });

    expect(result.audio.clips).toBe(1);
    expect(result.durationInFrames).toBe(10);
    const streams = (await probe(outPath)).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({ width: 320, height: 180, nb_read_frames: "10" });
    expect(streams.find((stream) => stream.codec_type === "audio")).toBeDefined();
  }, 120_000);

  it("preserves composition alpha when compositing overlay tracks", async () => {
    const root = await customRoot();
    await copyFile(
      path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
      path.join(root, "assets", "chime.wav"),
    );
    await writeFile(
      path.join(root, "compositions", "base.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }</style>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>
  </body>
</html>
`,
    );
    await writeFile(
      path.join(root, "compositions", "overlay.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      .dot { position: absolute; left: 140px; top: 70px; width: 40px; height: 40px; background: #b8f36b; }
    </style>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div class="dot"></div>
    </fy-composition>
  </body>
</html>
`,
    );
    await writeFile(
      path.join(root, "timelines", "main.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [
            { id: "v1", kind: "video" },
            { id: "v2", kind: "video" },
          ],
          clips: [
            {
              id: "base",
              track: "v1",
              source: { kind: "composition", id: "base" },
              start: 0,
              duration: 10,
            },
            {
              id: "overlay",
              track: "v2",
              source: { kind: "composition", id: "overlay" },
              start: 0,
              duration: 10,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "video.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html", overlay: "./compositions/overlay.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    await renderTimeline({ project, timelineId: "main", outPath, workers: 2 });

    const [red, green, blue] = await mediaPixel(outPath);
    expect(red).toBeGreaterThan(120);
    expect(red).toBeGreaterThan(green + 40);
    expect(red).toBeGreaterThan(blue + 40);
  }, 120_000);
});

describe("nested timeline rendering", () => {
  it("renders a nested timeline as a group with alpha", async () => {
    const root = await customRoot();
    await copyFile(
      path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
      path.join(root, "assets", "chime.wav"),
    );
    await writeFile(
      path.join(root, "compositions", "base.html"),
      `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }</style></head><body><fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition></body></html>`,
    );
    await writeFile(
      path.join(root, "compositions", "overlay.html"),
      `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; width: 100%; height: 100%; background: transparent; } .dot { position: absolute; left: 140px; top: 70px; width: 40px; height: 40px; background: #b8f36b; }</style></head><body><fy-composition width="320" height="180" fps="10" duration-in-frames="10"><div class="dot"></div></fy-composition></body></html>`,
    );
    await writeFile(
      path.join(root, "timelines", "lower.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [
            { id: "v1", kind: "video" },
            { id: "a1", kind: "audio" },
          ],
          clips: [
            {
              id: "overlay",
              track: "v1",
              source: { kind: "composition", id: "overlay" },
              start: 0,
              duration: 10,
            },
            {
              id: "nested-music",
              track: "a1",
              source: { kind: "audio", src: "assets/chime.wav" },
              start: 0,
              duration: 10,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "timelines", "main.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [
            { id: "v1", kind: "video" },
            { id: "v2", kind: "video" },
          ],
          clips: [
            {
              id: "base",
              track: "v1",
              source: { kind: "composition", id: "base" },
              start: 0,
              duration: 10,
            },
            {
              id: "nested",
              track: "v2",
              source: { kind: "timeline", id: "lower" },
              start: 0,
              duration: 10,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "video.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html", overlay: "./compositions/overlay.html" },
        timelines: { main: "./timelines/main.json", lower: "./timelines/lower.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimeline({ project, timelineId: "main", outPath, workers: 2 });

    expect(result.audio.clips).toBe(1);
    const streams = (await probe(outPath)).streams;
    expect(streams.find((stream) => stream.codec_type === "audio")).toBeDefined();

    const [red, green, blue] = await mediaPixel(outPath, 10, 10);
    expect(red).toBeGreaterThan(120);
    expect(red).toBeGreaterThan(green + 40);
    expect(red).toBeGreaterThan(blue + 40);

    const [centerRed, centerGreen] = await mediaPixel(outPath, 160, 90);
    expect(centerGreen).toBeGreaterThan(centerRed + 40);

    const checked = await checkTimeline({ project, timelineId: "main" });
    expect(checked.framesChecked).toBe(10);
    expect(checked.audio.clips).toBe(1);
    expect(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const stillPath = path.join(root, "out", "nested-frame.png");
    const still = await captureTimelineStill({
      project,
      timelineId: "main",
      frame: 5,
      outPath: stillPath,
    });
    expect(still.width).toBe(320);
    expect(still.height).toBe(180);
    const [stillRed, stillGreen] = await mediaPixel(stillPath, 160, 90);
    expect(stillGreen).toBeGreaterThan(stillRed + 40);
  }, 120_000);
});
