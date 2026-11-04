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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
        path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
            kind: "image",
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
            kind: "image",
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
          kind: "image",
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
          kind: "image",
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
          kind: "image",
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
          kind: "image",
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
          kind: "image",
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
      path.join(root, "video.config.js"),
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
          kind: "image",
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
          kind: "image",
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
          kind: "image",
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
          kind: "image",
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
      path.join(root, "video.config.js"),
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
      path.join(root, "video.config.js"),
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
