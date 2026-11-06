import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";
import { compositeTimelineFrame } from "../src/renderer/ffmpeg.ts";
import {
  captureTimelineStill,
  captureTimelineStills,
  checkTimeline,
  clampTimelineWorkers,
  renderTimeline,
} from "../src/renderer/timeline.ts";
import type { BlendMode } from "../src/timeline/schema.ts";
import { BARCODE, barcodeCompositionHtml, barcodeCropFilter, decodeBarcodeFrames } from "./helpers/frame-probe.ts";
import { mediaPixel, mediaPixelRgba } from "./helpers/media.ts";

const exec = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const roots: string[] = [];

/**
 * Pins software encoding so segmented-render tests do not depend on the host
 * GPU. Pass `encoder` explicitly to exercise `auto` or a hardware encoder.
 */
function renderTimelineForTest(options: Parameters<typeof renderTimeline>[0]) {
  return renderTimeline({ encoder: "software", ...options });
}

const compositionHtml = `<style>
      html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }
      .dot { position: absolute; left: calc(var(--fy-progress) * 100%); top: 50%; width: 30px; height: 30px; border-radius: 50%; background: #b8f36b; }
    </style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div class="dot"></div>
    </fy-composition>
`;

const inheritedCompositionHtml = compositionHtml.replace(
  '<fy-composition width="320" height="180" fps="10" duration-in-frames="10">',
  '<fy-composition duration-in-frames="10">',
);

const staticCompositionHtml = `<style>
      html, body { margin: 0; width: 100%; height: 100%; background: #123456; }
    </style>
    <fy-composition></fy-composition>
`;

const throwingCompositionHtml = `<fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div class="dot"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update({ frame }) {
    if (frame === 2) throw new Error("frame boom");
  },
};
    </script>
`;

async function createProject(compositionSource = compositionHtml): Promise<{ root: string; outPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-render-"));
  roots.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "compositions", "intro.html"), compositionSource);
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
    path.join(root, "fy.config.js"),
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
    "stream=codec_type,codec_name,codec_tag_string,width,height,nb_read_frames,duration:format=format_name",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(stdout) as {
    streams: Array<Record<string, unknown>>;
    format?: { format_name?: string };
  };
}

/** W3C blend math in 0-255 space, matching the FFmpeg recipe. */
function cssBlend(mode: BlendMode, backdrop: number, source: number): number {
  const cb = backdrop / 255;
  const cs = source / 255;
  let result = cs;
  switch (mode) {
    case "normal":
      break;
    case "multiply":
      result = cb * cs;
      break;
    case "screen":
      result = cb + cs - cb * cs;
      break;
    case "overlay":
      result = cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      break;
    case "darken":
      result = Math.min(cb, cs);
      break;
    case "lighten":
      result = Math.max(cb, cs);
      break;
    case "color-dodge":
      result = cs === 1 ? 1 : Math.min(1, cb / (1 - cs));
      break;
    case "color-burn":
      result = cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
      break;
    case "hard-light":
      result = cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      break;
    case "soft-light":
      result =
        cs <= 0.5
          ? cb - (1 - 2 * cs) * cb * (1 - cb)
          : cb + (2 * cs - 1) * ((cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)) - cb);
      break;
    case "difference":
      result = Math.abs(cb - cs);
      break;
    case "exclusion":
      result = cb + cs - 2 * cb * cs;
      break;
  }
  return Math.round(result * 255);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("timeline rendering", () => {
  it("caps workers at the encoder session limit", () => {
    expect(clampTimelineWorkers(16, "h264_nvenc")).toBe(8);
    expect(clampTimelineWorkers(4, "h264_nvenc")).toBe(4);
    expect(clampTimelineWorkers(16, "libx264")).toBe(16);
    expect(clampTimelineWorkers(16, "h264_qsv")).toBe(16);
  });

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

  it("captures a composition that inherits the project format at project size", async () => {
    const { root } = await createProject(inheritedCompositionHtml);
    const project = await loadProject(root);
    const stillPath = path.join(root, "out", "inherited.png");

    const result = await captureTimelineStill({
      project,
      timelineId: "main",
      frame: 5,
      outPath: stillPath,
    });

    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    const streams = (await probe(stillPath)).streams;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      width: 320,
      height: 180,
    });
  }, 120_000);

  it("captures a batch of timeline stills through the clip composite path", async () => {
    const { root } = await createProject();
    const project = await loadProject(root);
    const outDir = path.join(root, "out", "frames");

    const result = await captureTimelineStills({
      project,
      timelineId: "main",
      frames: [0, 5, 9],
      outPaths: [0, 5, 9].map((frame) => path.join(outDir, `still-main-${frame}.png`)),
    });

    expect(result.timeline).toBe("main");
    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect(result.frames.map((entry) => entry.frame)).toEqual([0, 5, 9]);
    expect(result).not.toHaveProperty("frame");
    expect(result).not.toHaveProperty("path");

    for (const frame of [0, 5, 9]) {
      const batchPath = path.join(outDir, `still-main-${frame}.png`);
      expect((await stat(batchPath)).size).toBeGreaterThan(0);

      const singlePath = path.join(root, "out", `single-${frame}.png`);
      const single = await captureTimelineStill({
        project,
        timelineId: "main",
        frame,
        outPath: singlePath,
      });
      expect(single.frame).toBe(frame);
      expect(await mediaPixel(batchPath, 10, 90)).toEqual(await mediaPixel(singlePath, 10, 90));
      expect(await mediaPixel(batchPath, 180, 90)).toEqual(await mediaPixel(singlePath, 180, 90));
    }
  }, 120_000);

  it("publishes no timeline stills when a frame fails", async () => {
    const { root } = await createProject();
    await writeFile(path.join(root, "compositions", "intro.html"), throwingCompositionHtml);
    const project = await loadProject(root);
    const outDir = path.join(root, "out", "batch-failure");
    const frames = [0, 1, 2, 3];

    await expect(
      captureTimelineStills({
        project,
        timelineId: "main",
        frames,
        outPaths: frames.map((frame) => path.join(outDir, `still-main-${frame}.png`)),
      }),
    ).rejects.toMatchObject({
      code: "COMPOSITION_ERROR",
      details: { frames, failedFrame: 2 },
    });

    expect(await readdir(outDir)).toEqual([]);
  }, 120_000);

  it("renders a composition and timeline audio through the segmented pipeline", async () => {
    const { root, outPath } = await createProject();
    const project = await loadProject(root);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      encoder: "software",
    });

    expect(result.timeline).toBe("main");
    expect(result.entry).toBe("timelines/main.json");
    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect(result.fps).toBe(10);
    expect(result.durationInFrames).toBe(10);
    expect(result.framesRendered).toBe(10);
    expect(result.segments).toBe(1);
    expect(result.workers).toBe(2);
    expect(result.codec).toBe("h264");
    expect(result.encoder).toBe("libx264");
    expect(result.audio.clips).toBe(1);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect((await stat(outPath)).size).toBeGreaterThan(0);

    const streams = (await probe(outPath)).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ width: 320, height: 180, nb_read_frames: "10" });
    expect(audio).toBeDefined();
  }, 120_000);

  it("renders a static composition clip as a reused image layer across segments", async () => {
    const { root, outPath } = await createProject(staticCompositionHtml);
    const project = await loadProject(root);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 3,
    });

    expect(result.framesRendered).toBe(10);
    expect(result.segments).toBe(4);
    const video = (await probe(outPath)).streams.find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({ width: 320, height: 180, nb_read_frames: "10" });

    const pixels: Array<[number, number, number]> = [];
    for (const frame of [0, 9]) {
      const framePath = path.join(root, "out", `static-${frame}.png`);
      await exec("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        String(frame / 10),
        "-i",
        outPath,
        "-frames:v",
        "1",
        framePath,
      ]);
      pixels.push(await mediaPixel(framePath, 160, 90));
    }

    expect(pixels[0]).toEqual(pixels[1]);
    expect(pixels[0]?.[2]).toBeGreaterThan(pixels[0]?.[0] ?? 0);
    expect(pixels[0]?.[2]).toBeGreaterThan(20);
  }, 120_000);

  it("renders HEVC across concatenated segments with the hvc1 tag", async () => {
    const { root, outPath } = await createProject();
    const project = await loadProject(root);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 4,
      codec: "hevc",
      encoder: "software",
    });

    expect(result.codec).toBe("hevc");
    expect(result.encoder).toBe("libx265");
    expect(result.segments).toBeGreaterThan(1);
    expect(result.framesRendered).toBe(10);

    const streams = (await probe(outPath)).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({
      codec_name: "hevc",
      codec_tag_string: "hvc1",
      nb_read_frames: "10",
    });
    expect(streams.find((stream) => stream.codec_type === "audio")).toBeDefined();
  }, 120_000);

  it("delivers MKV and WebM with the matching container and audio codec", async () => {
    const { root } = await createProject();
    const project = await loadProject(root);

    const mkvPath = path.join(root, "out", "main.mkv");
    const mkv = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath: mkvPath,
      workers: 2,
      container: "mkv",
      encoder: "software",
    });
    expect(mkv).toMatchObject({ codec: "h264", container: "mkv", encoder: "libx264" });
    const mkvProbe = await probe(mkvPath);
    expect(mkvProbe.format?.format_name).toContain("matroska");
    expect(mkvProbe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "h264",
      nb_read_frames: "10",
    });
    expect(mkvProbe.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "aac" });

    const webmPath = path.join(root, "out", "main.webm");
    const webm = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath: webmPath,
      workers: 2,
      container: "webm",
      // VP9 has no hardware encoder in the matrix, so `auto` must fall back to
      // the software encoder on every host.
      encoder: "auto",
    });
    expect(webm).toMatchObject({ codec: "vp9", container: "webm", encoder: "libvpx-vp9" });
    const webmProbe = await probe(webmPath);
    expect(webmProbe.format?.format_name).toContain("webm");
    expect(webmProbe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "vp9",
      nb_read_frames: "10",
    });
    expect(webmProbe.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "opus" });
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
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 2 });

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

  it("fits a clip into an explicit transform box", async () => {
    const root = await customRoot();
    await writeFile(
      path.join(root, "compositions", "base.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }</style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>
`,
    );
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#b8f36b:s=100x50:d=1",
      "-frames:v",
      "1",
      path.join(root, "assets", "green.png"),
    ]);
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
              duration: 1,
            },
            {
              id: "green",
              track: "v2",
              source: { kind: "image", src: "assets/green.png" },
              start: 0,
              duration: 1,
              transform: { fit: "cover", width: 80, height: 60, x: 0, y: 0 },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const stillPath = path.join(root, "out", "box.png");
    const project = await loadProject(root);

    const result = await captureTimelineStill({ project, timelineId: "main", frame: 0, outPath: stillPath });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const inside = await mediaPixel(stillPath, 160, 90);
    expect(inside[1]).toBeGreaterThan(inside[0] + 40);
    const nearEdge = await mediaPixel(stillPath, 122, 90);
    expect(nearEdge[1]).toBeGreaterThan(nearEdge[0] + 40);
    const outside = await mediaPixel(stillPath, 118, 90);
    expect(outside[0]).toBeGreaterThan(outside[1] + 40);
    const above = await mediaPixel(stillPath, 160, 58);
    expect(above[0]).toBeGreaterThan(above[1] + 40);
  }, 120_000);

  it.each([
    {
      name: "WebM",
      extension: "webm",
      codec: ["-c:v", "libvpx-vp9", "-lossless", "1", "-g", "60", "-an"],
    },
    {
      name: "MP4",
      extension: "mp4",
      codec: ["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-an"],
    },
  ])(
    "keeps $name video frames aligned through overlay compositing",
    async ({ extension, codec }) => {
      const root = await customRoot();
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=64x36:r=30:d=2,geq=lum='16+219*abs(sin(PI*N/2))':cb=128:cr=128,format=yuv420p",
        ...codec,
        path.join(root, "assets", `flash.${extension}`),
      ]);
      await writeFile(
        path.join(root, "timelines", "main.json"),
        `${JSON.stringify(
          {
            version: 1,
            tracks: [{ id: "v1", kind: "video" }],
            clips: [
              {
                id: "flash",
                track: "v1",
                source: { kind: "video", src: `assets/flash.${extension}` },
                start: 0,
                duration: 60,
                audio: { muted: true },
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        path.join(root, "fy.config.js"),
        `export default {
        format: { width: 64, height: 36, fps: 30 },
        timelines: { main: "./timelines/main.json" },
      };\n`,
      );
      const outPath = path.join(root, "out", "main.mp4");
      const project = await loadProject(root);

      const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });

      expect(result.framesRendered).toBe(60);
      const { stdout } = await exec(
        "ffmpeg",
        ["-v", "error", "-i", outPath, "-vf", "format=gray,crop=1:1:32:18", "-f", "rawvideo", "-"],
        { encoding: "buffer", maxBuffer: 4096 },
      );
      const pixels = [...(stdout as unknown as Buffer)];
      expect(pixels).toHaveLength(60);
      for (const [frame, value] of pixels.entries()) {
        expect(value > 128, `frame ${frame} luminance ${value}`).toBe(frame % 2 === 1);
      }
    },
    120_000,
  );

  it("keeps composition frames aligned through overlay compositing", async () => {
    const root = await customRoot();
    await writeFile(path.join(root, "compositions", "barcode.html"), barcodeCompositionHtml());
    await writeFile(
      path.join(root, "timelines", "main.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "barcode",
              track: "v1",
              source: { kind: "composition", id: "barcode" },
              start: 0,
              duration: BARCODE.frames,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 30 },
        compositions: { barcode: "./compositions/barcode.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });

    expect(result.framesRendered).toBe(BARCODE.frames);
    const { stdout } = await exec(
      "ffmpeg",
      ["-v", "error", "-i", outPath, "-vf", barcodeCropFilter(), "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
    const { mismatches } = decodeBarcodeFrames(stdout as unknown as Buffer, BARCODE.frames);
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("includes audio declared inside a composition clip", async () => {
    const root = await customRoot();
    await copyFile(
      path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
      path.join(root, "assets", "chime.wav"),
    );
    await writeFile(
      path.join(root, "compositions", "intro.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #202830; }</style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <audio src="assets/chime.wav" data-fy-start="0" data-fy-duration="0.6"></audio>
    </fy-composition>
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
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { intro: "./compositions/intro.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });

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
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }</style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>
`,
    );
    await writeFile(
      path.join(root, "compositions", "overlay.html"),
      `<style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      .dot { position: absolute; left: 140px; top: 70px; width: 40px; height: 40px; background: #b8f36b; }
    </style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div class="dot"></div>
    </fy-composition>
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
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html", overlay: "./compositions/overlay.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 2 });

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
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #e23b3b; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>`,
    );
    await writeFile(
      path.join(root, "compositions", "overlay.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: transparent; } .dot { position: absolute; left: 140px; top: 70px; width: 40px; height: 40px; background: #b8f36b; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="10"><div class="dot"></div></fy-composition>`,
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
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html", overlay: "./compositions/overlay.html" },
        timelines: { main: "./timelines/main.json", lower: "./timelines/lower.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 2 });

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

  it("keeps nested timeline frames aligned through overlay compositing", async () => {
    const root = await customRoot();
    await writeFile(path.join(root, "compositions", "barcode.html"), barcodeCompositionHtml());
    await writeFile(
      path.join(root, "timelines", "lower.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "barcode",
              track: "v1",
              source: { kind: "composition", id: "barcode" },
              start: 0,
              duration: BARCODE.frames,
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
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "nested",
              track: "v1",
              source: { kind: "timeline", id: "lower" },
              start: 0,
              duration: BARCODE.frames,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: ${BARCODE.width}, height: ${BARCODE.height}, fps: ${BARCODE.fps} },
        compositions: { barcode: "./compositions/barcode.html" },
        timelines: { main: "./timelines/main.json", lower: "./timelines/lower.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });

    expect(result.framesRendered).toBe(BARCODE.frames);
    const { stdout } = await exec(
      "ffmpeg",
      ["-v", "error", "-i", outPath, "-vf", barcodeCropFilter(), "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
    const { mismatches } = decodeBarcodeFrames(stdout as unknown as Buffer, BARCODE.frames);
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe("timeline blend modes", () => {
  async function solidPng(filePath: string, color: string, size = "64x64"): Promise<void> {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${size}:d=1`,
      "-frames:v",
      "1",
      filePath,
    ]);
  }

  it("composites every supported mode against the accumulated backdrop", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const sourcePath = path.join(root, "assets", "source.png");
    await solidPng(basePath, "0x336699");
    await solidPng(sourcePath, "0xff8800");
    const backdrop = await mediaPixel(basePath);
    const source = await mediaPixel(sourcePath);
    const modes: BlendMode[] = [
      "normal",
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "color-dodge",
      "color-burn",
      "hard-light",
      "soft-light",
      "difference",
      "exclusion",
    ];

    for (const mode of modes) {
      const outputPath = path.join(root, "out", `${mode}.png`);
      await compositeTimelineFrame({
        outputPath,
        width: 64,
        height: 64,
        fps: 10,
        background: "#000000",
        layers: [
          {
            input: "image",
            path: basePath,
            sourceWidth: 64,
            sourceHeight: 64,
            fit: "stretch",
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            blend: "normal",
          },
          {
            input: "image",
            path: sourcePath,
            sourceWidth: 64,
            sourceHeight: 64,
            fit: "stretch",
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            blend: mode,
          },
        ],
      });

      const actual = await mediaPixel(outputPath);
      for (let channel = 0; channel < 3; channel += 1) {
        const expected = cssBlend(mode, backdrop[channel] as number, source[channel] as number);
        expect(
          Math.abs((actual[channel] as number) - expected),
          `${mode} channel ${channel}: ${actual.join(",")} vs ${expected}`,
        ).toBeLessThanOrEqual(3);
      }
    }
  }, 120_000);

  it("stacks multiple blended layers in track order", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const redPath = path.join(root, "assets", "red.png");
    const greenPath = path.join(root, "assets", "green.png");
    await solidPng(basePath, "0x336699");
    await solidPng(redPath, "0xff8800");
    await solidPng(greenPath, "0x00ff80");
    const backdrop = await mediaPixel(basePath);
    const red = await mediaPixel(redPath);
    const green = await mediaPixel(greenPath);
    const outputPath = path.join(root, "out", "stacked.png");

    await compositeTimelineFrame({
      outputPath,
      width: 64,
      height: 64,
      fps: 10,
      background: "#000000",
      layers: [
        {
          input: "image",
          path: basePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "normal",
        },
        {
          input: "image",
          path: redPath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "multiply",
        },
        {
          input: "image",
          path: greenPath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "screen",
        },
      ],
    });

    const actual = await mediaPixel(outputPath);
    for (let channel = 0; channel < 3; channel += 1) {
      const first = cssBlend("multiply", backdrop[channel] as number, red[channel] as number);
      const expected = cssBlend("screen", first, green[channel] as number);
      expect(Math.abs((actual[channel] as number) - expected)).toBeLessThanOrEqual(4);
    }
  }, 120_000);

  it("blends only where the source has alpha", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const sourcePath = path.join(root, "assets", "alpha.png");
    await solidPng(basePath, "0x336699");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=1",
      "-vf",
      "format=rgba,colorchannelmixer=aa=0,drawbox=x=16:y=16:w=16:h=32:color=red@1:t=fill:replace=1,drawbox=x=40:y=16:w=8:h=32:color=red@0.5:t=fill:replace=1",
      "-frames:v",
      "1",
      sourcePath,
    ]);
    const backdrop = await mediaPixelRgba(basePath);
    const outputPath = path.join(root, "out", "alpha.png");
    await compositeTimelineFrame({
      outputPath,
      width: 64,
      height: 64,
      fps: 10,
      background: "#000000",
      layers: [
        {
          input: "image",
          path: basePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "normal",
        },
        {
          input: "image",
          path: sourcePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "multiply",
        },
      ],
    });

    const transparent = await mediaPixelRgba(outputPath, 5, 5);
    const actualOpaque = await mediaPixelRgba(outputPath, 20, 20);
    const actualSemi = await mediaPixelRgba(outputPath, 44, 20);
    const opaque = await mediaPixelRgba(sourcePath, 20, 20);
    const semi = await mediaPixelRgba(sourcePath, 44, 20);

    for (let channel = 0; channel < 3; channel += 1) {
      expect(transparent[channel], "transparent source leaves the backdrop").toBe(backdrop[channel]);
      const blended = cssBlend("multiply", backdrop[channel] as number, opaque[channel] as number);
      const mixed = Math.round(
        (1 - (semi[3] as number) / 255) * (backdrop[channel] as number) + ((semi[3] as number) / 255) * blended,
      );
      expect(Math.abs((actualOpaque[channel] as number) - blended)).toBeLessThanOrEqual(3);
      expect(Math.abs((actualSemi[channel] as number) - mixed)).toBeLessThanOrEqual(3);
    }
  }, 120_000);

  it("renders blended composition layers across independent segments", async () => {
    const root = await customRoot();
    await writeFile(
      path.join(root, "compositions", "base.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #336699; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="20"></fy-composition>`,
    );
    await writeFile(
      path.join(root, "compositions", "top.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #ff8800; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="20"></fy-composition>`,
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
              duration: 20,
            },
            {
              id: "top",
              track: "v2",
              source: { kind: "composition", id: "top" },
              start: 0,
              duration: 20,
              blend: "multiply",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html", top: "./compositions/top.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
    const outPath = path.join(root, "out", "main.mp4");
    const project = await loadProject(root);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 10,
    });

    expect(result.segments).toBe(2);
    expect(result.framesRendered).toBe(20);
    expect((await probe(outPath)).streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      width: 320,
      height: 180,
      nb_read_frames: "20",
    });
    const [red, green, blue] = await mediaPixel(outPath, 160, 90);
    expect(Math.abs(red - 51)).toBeLessThanOrEqual(6);
    expect(Math.abs(green - 54)).toBeLessThanOrEqual(6);
    expect(blue).toBeLessThan(20);
  }, 120_000);

  it("blends only inside a transformed and offset clip box", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const sourcePath = path.join(root, "assets", "source.png");
    await solidPng(basePath, "0x336699");
    await solidPng(sourcePath, "0xff8800", "16x16");
    const backdrop = await mediaPixel(basePath);
    const source = await mediaPixel(sourcePath);
    const outputPath = path.join(root, "out", "offset.png");

    await compositeTimelineFrame({
      outputPath,
      width: 64,
      height: 64,
      fps: 10,
      background: "#000000",
      layers: [
        {
          input: "image",
          path: basePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "normal",
        },
        {
          input: "image",
          path: sourcePath,
          sourceWidth: 16,
          sourceHeight: 16,
          width: 16,
          height: 16,
          fit: "stretch",
          x: 10,
          y: 10,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "multiply",
        },
      ],
    });

    const outside = await mediaPixel(outputPath, 5, 5);
    const inside = await mediaPixel(outputPath, 42, 42);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(outside[channel], "outside the clip box").toBe(backdrop[channel]);
      const expected = cssBlend("multiply", backdrop[channel] as number, source[channel] as number);
      expect(Math.abs((inside[channel] as number) - expected)).toBeLessThanOrEqual(3);
    }
  }, 120_000);

  it("applies clip opacity to the blended source alpha", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const sourcePath = path.join(root, "assets", "source.png");
    await solidPng(basePath, "0x336699");
    await solidPng(sourcePath, "0xff8800");
    const backdrop = await mediaPixel(basePath);
    const source = await mediaPixel(sourcePath);
    const outputPath = path.join(root, "out", "opacity.png");

    await compositeTimelineFrame({
      outputPath,
      width: 64,
      height: 64,
      fps: 10,
      background: "#000000",
      layers: [
        {
          input: "image",
          path: basePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: "normal",
        },
        {
          input: "image",
          path: sourcePath,
          sourceWidth: 64,
          sourceHeight: 64,
          fit: "stretch",
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 0.5,
          blend: "multiply",
        },
      ],
    });

    const actual = await mediaPixel(outputPath);
    for (let channel = 0; channel < 3; channel += 1) {
      const blended = cssBlend("multiply", backdrop[channel] as number, source[channel] as number);
      const expected = Math.round(0.5 * (backdrop[channel] as number) + 0.5 * blended);
      expect(Math.abs((actual[channel] as number) - expected)).toBeLessThanOrEqual(3);
    }
  }, 120_000);

  it("keeps a transparent nested timeline's blend isolated from the parent backdrop", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await solidPng(path.join(root, "assets", "green.png"), "0x00ff00", "320x180");
    await writeFile(
      path.join(root, "compositions", "base.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #ff0000; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="1"></fy-composition>`,
    );
    await writeFile(
      path.join(root, "timelines", "nested.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "green",
              track: "v1",
              source: { kind: "image", src: "assets/green.png" },
              start: 0,
              duration: 1,
              blend: "multiply",
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
              id: "red",
              track: "v1",
              source: { kind: "composition", id: "base" },
              start: 0,
              duration: 1,
            },
            {
              id: "nested",
              track: "v2",
              source: { kind: "timeline", id: "nested" },
              start: 0,
              duration: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { base: "./compositions/base.html" },
        timelines: { main: "./timelines/main.json", nested: "./timelines/nested.json" },
      };\n`,
    );
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "nested-blend.png");

    await captureTimelineStill({ project, timelineId: "main", frame: 0, outPath });

    const [red, green, blue] = await mediaPixel(outPath, 160, 90);
    expect(green, "the nested blend must not see the parent's red backdrop").toBeGreaterThan(200);
    expect(red).toBeLessThan(60);
    expect(blue).toBeLessThan(60);
  }, 120_000);

  it("composites blend modes on image, composition, video, and nested timeline clips", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await solidPng(path.join(root, "assets", "base.png"), "0x336699", "320x180");
    await solidPng(path.join(root, "assets", "top.png"), "0xff8800", "320x180");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xff8800:s=320x180:r=10:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      path.join(root, "assets", "top.mp4"),
    ]);
    await writeFile(
      path.join(root, "compositions", "top.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #ff8800; }</style><fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>`,
    );
    await writeFile(
      path.join(root, "timelines", "nested.json"),
      `${JSON.stringify(
        {
          version: 1,
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "top",
              track: "v1",
              source: { kind: "image", src: "assets/top.png" },
              start: 0,
              duration: 10,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const baseClip = (start: number) => ({
      id: `base-${start}`,
      track: "v1",
      source: { kind: "image", src: "assets/base.png" },
      start,
      duration: 1,
    });
    const topClip = (start: number, source: Record<string, unknown>) => ({
      id: `top-${start}`,
      track: "v2",
      source,
      start,
      duration: 1,
      blend: "multiply",
    });
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
            baseClip(0),
            topClip(0, { kind: "image", src: "assets/top.png" }),
            baseClip(1),
            topClip(1, { kind: "composition", id: "top" }),
            baseClip(2),
            topClip(2, { kind: "video", src: "assets/top.mp4" }),
            baseClip(3),
            topClip(3, { kind: "timeline", id: "nested" }),
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: { top: "./compositions/top.html" },
        timelines: { main: "./timelines/main.json", nested: "./timelines/nested.json" },
      };\n`,
    );
    const project = await loadProject(root);
    const frames = [0, 1, 2, 3];
    const outPaths = frames.map((frame) => path.join(root, "out", `blend-${frame}.png`));

    await captureTimelineStills({ project, timelineId: "main", frames, outPaths });

    for (const [index, outPath] of outPaths.entries()) {
      const [red, green, blue] = await mediaPixel(outPath, 160, 90);
      expect(red, `frame ${frames[index]} red`).toBeGreaterThanOrEqual(40);
      expect(red, `frame ${frames[index]} red`).toBeLessThanOrEqual(65);
      expect(green, `frame ${frames[index]} green`).toBeGreaterThanOrEqual(40);
      expect(green, `frame ${frames[index]} green`).toBeLessThanOrEqual(70);
      expect(blue, `frame ${frames[index]} blue`).toBeLessThan(25);
    }
  }, 120_000);
});

describe("timeline keyframe rendering", () => {
  async function keyframeImage(filePath: string, color: string, size = "40x40"): Promise<void> {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${size}:d=1`,
      "-frames:v",
      "1",
      filePath,
    ]);
  }

  async function writeMainTimeline(
    root: string,
    timeline: unknown,
    compositions?: Record<string, string>,
  ): Promise<void> {
    await writeFile(path.join(root, "timelines", "main.json"), `${JSON.stringify(timeline, null, 2)}\n`);
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: ${JSON.stringify(compositions ?? {})},
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
  }

  async function extractFrame(videoPath: string, frame: number, outputPath: string): Promise<void> {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      outputPath,
    ]);
  }

  it("renders keyframed position and opacity across independent segments", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b");
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "marker",
          track: "v1",
          source: { kind: "image", src: "assets/green.png" },
          start: 0,
          duration: 20,
          transform: { fit: "contain", width: 40, height: 40 },
          keyframes: {
            x: [
              { frame: 0, value: 0 },
              { frame: 19, value: 100 },
            ],
            y: [
              { frame: 0, value: 0 },
              { frame: 19, value: 50 },
            ],
            opacity: [
              { frame: 0, value: 1 },
              { frame: 19, value: 0.5 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");

    const checked = await checkTimeline({ project, timelineId: "main" });
    expect(checked.framesChecked).toBe(20);
    expect(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 5,
    });
    expect(result.segments).toBe(4);
    expect(result.framesRendered).toBe(20);

    const frame0 = path.join(root, "out", "frame-0.png");
    const frame19 = path.join(root, "out", "frame-19.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 19, frame19);

    const start = await mediaPixel(frame0, 160, 90);
    expect(start[1]).toBeGreaterThan(start[0] + 40);
    expect(start[1]).toBeGreaterThan(start[2] + 40);

    const moved = await mediaPixel(frame19, 260, 140);
    const movedAway = await mediaPixel(frame19, 160, 90);
    expect(moved[1]).toBeGreaterThan(moved[0] + 20);
    expect(movedAway[1]).toBeLessThan(30);

    const stillPath = path.join(root, "out", "still-19.png");
    await captureTimelineStill({ project, timelineId: "main", frame: 19, outPath: stillPath });
    const still = await mediaPixel(stillPath, 260, 140);
    expect(Math.abs((still[1] as number) - (moved[1] as number))).toBeLessThanOrEqual(10);

    const singleSegmentPath = path.join(root, "out", "single.mp4");
    await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath: singleSegmentPath,
      workers: 1,
      maxSegmentFrames: 20,
    });
    const singleFrame = path.join(root, "out", "single-19.png");
    await extractFrame(singleSegmentPath, 19, singleFrame);
    const single = await mediaPixel(singleFrame, 260, 140);
    expect(Math.abs((single[1] as number) - (moved[1] as number))).toBeLessThanOrEqual(10);
  }, 120_000);

  it("applies keyframed opacity before a blend mode", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const basePath = path.join(root, "assets", "base.png");
    const sourcePath = path.join(root, "assets", "source.png");
    await keyframeImage(basePath, "0x336699", "64x64");
    await keyframeImage(sourcePath, "0xff8800", "64x64");
    const backdrop = await mediaPixel(basePath, 32, 32);
    const source = await mediaPixel(sourcePath, 32, 32);
    await writeMainTimeline(root, {
      version: 1,
      tracks: [
        { id: "v1", kind: "video" },
        { id: "v2", kind: "video" },
      ],
      clips: [
        {
          id: "base",
          track: "v1",
          source: { kind: "image", src: "assets/base.png" },
          start: 0,
          duration: 10,
          transform: { fit: "stretch" },
        },
        {
          id: "top",
          track: "v2",
          source: { kind: "image", src: "assets/source.png" },
          start: 0,
          duration: 10,
          transform: { fit: "stretch" },
          blend: "screen",
          keyframes: {
            opacity: [
              { frame: 0, value: 0 },
              { frame: 10, value: 1 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 2, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "blend-0.png");
    const frame9 = path.join(root, "out", "blend-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const transparent = await mediaPixel(frame0, 160, 90);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs((transparent[channel] as number) - (backdrop[channel] as number))).toBeLessThanOrEqual(4);
    }

    const ninety = await mediaPixel(frame9, 160, 90);
    for (let channel = 0; channel < 3; channel += 1) {
      const blended = cssBlend("screen", backdrop[channel] as number, source[channel] as number);
      const expected = Math.round(0.9 * blended + 0.1 * (backdrop[channel] as number));
      expect(Math.abs((ninety[channel] as number) - expected), `channel ${channel}`).toBeLessThanOrEqual(5);
    }
  }, 120_000);

  it("renders a hold easing as a step", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b", "320x180");
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "card",
          track: "v1",
          source: { kind: "image", src: "assets/green.png" },
          start: 0,
          duration: 10,
          transform: { fit: "stretch" },
          keyframes: {
            opacity: [
              { frame: 0, value: 0, easing: "hold" },
              { frame: 5, value: 1 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame4 = path.join(root, "out", "hold-4.png");
    const frame5 = path.join(root, "out", "hold-5.png");
    await extractFrame(outPath, 4, frame4);
    await extractFrame(outPath, 5, frame5);

    const before = await mediaPixel(frame4, 160, 90);
    const after = await mediaPixel(frame5, 160, 90);
    expect(before[1]).toBeLessThan(30);
    expect(after[1]).toBeGreaterThan(after[0] + 40);
  }, 120_000);

  it("applies keyframes to a video clip", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#b8f36b:s=160x90:r=10:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(root, "assets", "green.mp4"),
    ]);
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "video",
          track: "v1",
          source: { kind: "video", src: "assets/green.mp4" },
          start: 0,
          duration: 10,
          sourceIn: 0,
          transform: { fit: "contain", width: 160, height: 90 },
          audio: { muted: true },
          keyframes: {
            x: [
              { frame: 0, value: 0 },
              { frame: 9, value: 100 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "video-0.png");
    const frame9 = path.join(root, "out", "video-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const start = await mediaPixel(frame0, 100, 90);
    const moved = await mediaPixel(frame9, 260, 90);
    const original = await mediaPixel(frame9, 100, 90);
    expect(start[1]).toBeGreaterThan(start[0] + 40);
    expect(moved[1]).toBeGreaterThan(moved[0] + 40);
    expect(original[1]).toBeLessThan(30);
  }, 120_000);

  it("keeps the full rectangle visible through a 360-degree rotation", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const sourcePath = path.join(root, "assets", "rectangle.png");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#b8f36b:s=120x60:d=1",
      "-frames:v",
      "1",
      sourcePath,
    ]);
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "rotated",
          track: "v1",
          source: { kind: "image", src: "assets/rectangle.png" },
          start: 0,
          duration: 360,
          transform: { fit: "contain", width: 120, height: 60 },
          keyframes: {
            rotation: [
              { frame: 0, value: 0 },
              { frame: 360, value: 360 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "rotation.mp4");
    await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 60,
    });

    const { stdout } = await exec(
      "ffmpeg",
      ["-v", "error", "-i", outPath, "-vf", "format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    const buffer = stdout as unknown as Buffer;
    const width = 320;
    const height = 180;
    const channels = 3;
    const frameBytes = width * height * channels;
    expect(buffer.length).toBe(360 * frameBytes);

    const sourceWidth = 120;
    const sourceHeight = 60;
    // Without the expanded rotate bound FFmpeg clips to the 120x60 input box;
    // at 45 degrees the visible height would be 60 instead of roughly 127.
    for (let frame = 0; frame < 360; frame += 1) {
      const radians = (frame * Math.PI) / 180;
      const expectedWidth = sourceWidth * Math.abs(Math.cos(radians)) + sourceHeight * Math.abs(Math.sin(radians));
      const expectedHeight = sourceWidth * Math.abs(Math.sin(radians)) + sourceHeight * Math.abs(Math.cos(radians));
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = frame * frameBytes + (y * width + x) * channels;
          const red = buffer[offset] as number;
          const green = buffer[offset + 1] as number;
          const blue = buffer[offset + 2] as number;
          if (green > 100 && green > red + 30 && green > blue + 30) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      expect(maxX, `frame ${frame} has visible green pixels`).toBeGreaterThanOrEqual(0);
      const actualWidth = maxX - minX + 1;
      const actualHeight = maxY - minY + 1;
      expect(Math.abs(actualWidth - expectedWidth), `frame ${frame} width`).toBeLessThanOrEqual(4);
      expect(Math.abs(actualHeight - expectedHeight), `frame ${frame} height`).toBeLessThanOrEqual(4);
      expect(Math.abs((minX + maxX) / 2 - width / 2), `frame ${frame} center x`).toBeLessThanOrEqual(3);
      expect(Math.abs((minY + maxY) / 2 - height / 2), `frame ${frame} center y`).toBeLessThanOrEqual(3);
    }
  }, 120_000);

  it("keeps static rotated corners inside the expanded layer", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b", "100x100");
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "rotated",
          track: "v1",
          source: { kind: "image", src: "assets/green.png" },
          start: 0,
          duration: 10,
          transform: { fit: "contain", width: 100, height: 100, rotation: 45 },
        },
      ],
    });
    const project = await loadProject(root);
    const stillPath = path.join(root, "out", "static-corners.png");
    await captureTimelineStill({ project, timelineId: "main", frame: 0, outPath: stillPath });

    const corner = await mediaPixel(stillPath, 225, 90);
    const center = await mediaPixel(stillPath, 160, 90);
    expect(corner[1]).toBeGreaterThan(corner[0] + 40);
    expect(center[1]).toBeGreaterThan(center[0] + 40);
  }, 120_000);

  it("keeps rotated corners inside the expanded layer", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b", "100x100");
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "rotated",
          track: "v1",
          source: { kind: "image", src: "assets/green.png" },
          start: 0,
          duration: 10,
          transform: { fit: "contain", width: 100, height: 100 },
          keyframes: {
            rotation: [
              { frame: 0, value: 0 },
              { frame: 9, value: 45 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "corners-0.png");
    const frame9 = path.join(root, "out", "corners-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const before = await mediaPixel(frame0, 225, 90);
    const rotated = await mediaPixel(frame9, 225, 90);
    expect(before[1]).toBeLessThan(30);
    expect(rotated[1]).toBeGreaterThan(rotated[0] + 40);
  }, 120_000);

  it("applies parent keyframes to a nested timeline group", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b", "320x180");
    await writeFile(
      path.join(root, "timelines", "inner.json"),
      `${JSON.stringify(
        {
          version: 1,
          background: "#000000",
          tracks: [{ id: "v1", kind: "video" }],
          clips: [
            {
              id: "green",
              track: "v1",
              source: { kind: "image", src: "assets/green.png" },
              start: 0,
              duration: 10,
              transform: { fit: "stretch" },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "nested",
          track: "v1",
          source: { kind: "timeline", id: "inner" },
          start: 0,
          duration: 10,
          sourceIn: 0,
          keyframes: {
            x: [
              { frame: 0, value: 0 },
              { frame: 9, value: 160 },
            ],
          },
        },
      ],
    });
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        timelines: { main: "./timelines/main.json", inner: "./timelines/inner.json" },
      };\n`,
    );
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "nested-0.png");
    const frame9 = path.join(root, "out", "nested-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const start = await mediaPixel(frame0, 80, 90);
    const moved = await mediaPixel(frame9, 240, 90);
    const original = await mediaPixel(frame9, 80, 90);
    expect(start[1]).toBeGreaterThan(start[0] + 40);
    expect(moved[1]).toBeGreaterThan(moved[0] + 40);
    expect(original[1]).toBeLessThan(30);
  }, 120_000);

  it("renders keyframed scale, including zero", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await keyframeImage(path.join(root, "assets", "green.png"), "0xb8f36b");
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "scaled",
          track: "v1",
          source: { kind: "image", src: "assets/green.png" },
          start: 0,
          duration: 10,
          keyframes: {
            scale: [
              { frame: 0, value: 0 },
              { frame: 9, value: 2 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "scale-0.png");
    const frame9 = path.join(root, "out", "scale-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const zeroCenter = await mediaPixel(frame0, 160, 90);
    const zeroEdge = await mediaPixel(frame0, 280, 90);
    const scaledCenter = await mediaPixel(frame9, 160, 90);
    const scaledEdge = await mediaPixel(frame9, 280, 90);
    expect(zeroCenter[1]).toBeLessThan(30);
    expect(zeroEdge[1]).toBeLessThan(30);
    expect(scaledCenter[1]).toBeGreaterThan(scaledCenter[0] + 40);
    expect(scaledEdge[1]).toBeGreaterThan(scaledEdge[0] + 40);
  }, 120_000);

  it("renders keyframed rotation", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    const dotFilter = `format=rgba,geq=r='if(gte(X,70)*lt(X,90)*gte(Y,45)*lt(Y,55),184,0)':g='if(gte(X,70)*lt(X,90)*gte(Y,45)*lt(Y,55),243,0)':b='if(gte(X,70)*lt(X,90)*gte(Y,45)*lt(Y,55),107,0)':a='if(gte(X,70)*lt(X,90)*gte(Y,45)*lt(Y,55),255,0)'`;
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=100x100:d=1",
      "-vf",
      dotFilter,
      "-frames:v",
      "1",
      path.join(root, "assets", "dot.png"),
    ]);
    await writeMainTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "rotated",
          track: "v1",
          source: { kind: "image", src: "assets/dot.png" },
          start: 0,
          duration: 10,
          transform: { fit: "contain", width: 100, height: 100 },
          keyframes: {
            rotation: [
              { frame: 0, value: 0 },
              { frame: 9, value: 90 },
            ],
          },
        },
      ],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");
    await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1, maxSegmentFrames: 5 });

    const frame0 = path.join(root, "out", "rotation-0.png");
    const frame9 = path.join(root, "out", "rotation-9.png");
    await extractFrame(outPath, 0, frame0);
    await extractFrame(outPath, 9, frame9);

    const rotationStart = await mediaPixel(frame0, 190, 90);
    const rotationStartCenter = await mediaPixel(frame0, 160, 90);
    expect(rotationStart[1]).toBeGreaterThan(rotationStart[0] + 40);
    expect(rotationStartCenter[1]).toBeLessThan(30);

    const rotationEndOriginal = await mediaPixel(frame9, 190, 90);
    expect(rotationEndOriginal[1]).toBeLessThan(30);
    const rotationEndPerpendicularA = await mediaPixel(frame9, 160, 120);
    const rotationEndPerpendicularB = await mediaPixel(frame9, 160, 60);
    expect(Math.max(rotationEndPerpendicularA[1], rotationEndPerpendicularB[1])).toBeGreaterThan(
      rotationEndPerpendicularA[0] + 40,
    );
  }, 120_000);
});

describe("timeline transitions", () => {
  async function solidImage(filePath: string, color: string): Promise<void> {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:d=1`,
      "-frames:v",
      "1",
      filePath,
    ]);
  }

  async function writeTimeline(
    root: string,
    timeline: unknown,
    compositions: Record<string, string> = {},
  ): Promise<void> {
    await writeFile(path.join(root, "timelines", "main.json"), `${JSON.stringify(timeline, null, 2)}\n`);
    await writeFile(
      path.join(root, "fy.config.js"),
      `export default {
        format: { width: 320, height: 180, fps: 10 },
        compositions: ${JSON.stringify(compositions)},
        timelines: { main: "./timelines/main.json" },
      };\n`,
    );
  }

  async function extractFrame(videoPath: string, frame: number, outputPath: string): Promise<void> {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      outputPath,
    ]);
  }

  async function meanVolume(filePath: string, start: number, end: number): Promise<number> {
    const { stderr } = await exec("ffmpeg", [
      "-v",
      "info",
      "-i",
      filePath,
      "-af",
      `atrim=${start}:${end},volumedetect`,
      "-f",
      "null",
      "-",
    ]);
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    if (!match) {
      throw new Error(`Could not read mean_volume from ${filePath}.`);
    }
    return Number(match[1]);
  }

  it("dissolves from the outgoing clip to the incoming clip", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await solidImage(path.join(root, "assets", "red.png"), "0xff0000");
    await solidImage(path.join(root, "assets", "green.png"), "0x00ff00");
    await writeTimeline(root, {
      version: 1,
      background: "#000000",
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        { id: "a", track: "v1", source: { kind: "image", src: "assets/red.png" }, start: 0, duration: 10 },
        { id: "b", track: "v1", source: { kind: "image", src: "assets/green.png" }, start: 6, duration: 10 },
      ],
      transitions: [{ from: "a", to: "b", kind: "dissolve" }],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");

    const checked = await checkTimeline({ project, timelineId: "main" });
    expect(checked.transitions).toBe(1);
    expect(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const result = await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath,
      workers: 2,
      maxSegmentFrames: 2,
    });
    expect(result.transitions).toBe(1);
    expect(result.framesRendered).toBe(16);

    const frames = new Map<number, string>();
    for (const frame of [0, 6, 8, 9, 10, 15]) {
      const file = path.join(root, "out", `frame-${frame}.png`);
      await extractFrame(outPath, frame, file);
      frames.set(frame, file);
    }
    const at = (frame: number) => mediaPixel(frames.get(frame) as string, 160, 90);

    const start = await at(0);
    expect(start[0]).toBeGreaterThan(220);
    expect(start[1]).toBeLessThan(30);

    const overlapStart = await at(6);
    expect(overlapStart[0]).toBeGreaterThan(220);
    expect(overlapStart[1]).toBeLessThan(30);

    const middle = await at(8);
    expect(Math.abs((middle[0] as number) - 128)).toBeLessThanOrEqual(12);
    expect(Math.abs((middle[1] as number) - 128)).toBeLessThanOrEqual(12);
    expect(middle[2]).toBeLessThan(30);

    const threeQuarters = await at(9);
    expect(threeQuarters[1]).toBeGreaterThan((threeQuarters[0] as number) + 60);

    const end = await at(10);
    expect(end[1]).toBeGreaterThan(220);
    expect(end[0]).toBeLessThan(30);

    const stillPath = path.join(root, "out", "still-8.png");
    await captureTimelineStill({ project, timelineId: "main", frame: 8, outPath: stillPath });
    const still = await mediaPixel(stillPath, 160, 90);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs((still[channel] as number) - (middle[channel] as number))).toBeLessThanOrEqual(12);
    }

    const singleSegmentPath = path.join(root, "out", "single.mp4");
    await renderTimelineForTest({
      project,
      timelineId: "main",
      outPath: singleSegmentPath,
      workers: 1,
      maxSegmentFrames: 100,
    });
    const singleFrame = path.join(root, "out", "single-8.png");
    await extractFrame(singleSegmentPath, 8, singleFrame);
    const single = await mediaPixel(singleFrame, 160, 90);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs((single[channel] as number) - (middle[channel] as number))).toBeLessThanOrEqual(6);
    }
  }, 180_000);

  it("crossfades the audio contributed by both clips with equal power", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=60:duration=3:sample_rate=48000",
      "-ac",
      "2",
      path.join(root, "assets", "tone.wav"),
    ]);
    await writeFile(
      path.join(root, "compositions", "tone.html"),
      `<style>html, body { margin: 0; width: 100%; height: 100%; background: #203040; }</style>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <audio src="assets/tone.wav" data-fy-start="0" data-fy-duration="1"></audio>
    </fy-composition>
`,
    );
    await writeTimeline(
      root,
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "a",
            track: "v1",
            source: { kind: "composition", id: "tone" },
            start: 0,
            duration: 10,
          },
          {
            id: "b",
            track: "v1",
            source: { kind: "composition", id: "tone" },
            start: 6,
            duration: 10,
          },
        ],
        transitions: [{ from: "a", to: "b", kind: "dissolve" }],
      },
      { tone: "./compositions/tone.html" },
    );
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });
    expect(result.audio.clips).toBe(2);

    const startDb = await meanVolume(outPath, 0.05, 0.15);
    const middleDb = await meanVolume(outPath, 0.85, 0.95);

    // Equal power sums two correlated tones to +3 dB. A linear crossfade would
    // stay at 0 dB and an uncrossfaded overlap would reach +6 dB.
    expect(middleDb - startDb).toBeGreaterThan(2);
    expect(middleDb - startDb).toBeLessThan(3.6);
  }, 180_000);

  it("crossfades two audio clips that live directly on an audio track", async () => {
    const root = await customRoot();
    await mkdir(path.join(root, "out"), { recursive: true });
    await solidImage(path.join(root, "assets", "bed.png"), "0x102030");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=60:duration=3:sample_rate=48000",
      "-ac",
      "2",
      path.join(root, "assets", "tone.wav"),
    ]);
    await writeTimeline(root, {
      version: 1,
      tracks: [
        { id: "v1", kind: "video" },
        { id: "a1", kind: "audio", gain: 1 },
      ],
      clips: [
        { id: "bed", track: "v1", source: { kind: "image", src: "assets/bed.png" }, start: 0, duration: 16 },
        { id: "a", track: "a1", source: { kind: "audio", src: "assets/tone.wav" }, start: 0, duration: 10 },
        { id: "b", track: "a1", source: { kind: "audio", src: "assets/tone.wav" }, start: 6, duration: 10 },
      ],
      transitions: [{ from: "a", to: "b", kind: "crossfade" }],
    });
    const project = await loadProject(root);
    const outPath = path.join(root, "out", "main.mp4");

    const checked = await checkTimeline({ project, timelineId: "main" });
    expect(checked.transitions).toBe(1);
    expect(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const result = await renderTimelineForTest({ project, timelineId: "main", outPath, workers: 1 });
    expect(result.audio.clips).toBe(2);

    const startDb = await meanVolume(outPath, 0.05, 0.15);
    const middleDb = await meanVolume(outPath, 0.85, 0.95);
    expect(middleDb - startDb).toBeGreaterThan(2);
    expect(middleDb - startDb).toBeLessThan(3.6);
  }, 180_000);
});
