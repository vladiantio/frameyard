#!/usr/bin/env node
/**
 * 60-second, three-layer, audio-enabled gate for the segmented timeline
 * renderer. This is a measurement harness, not production code.
 *
 * It copies the spike project, extends both compositions to 1800 frames,
 * splits the timeline into six 10-second segments, and runs four segment
 * pipelines concurrently (two composition captures per segment, so eight
 * Chromium capture sessions at peak). Each segment is captured to FFV1,
 * composited with FFmpeg, and encoded; segments are concatenated and muxed
 * with a 60-second mixed audio bed.
 *
 * Run after bench/timeline-spike.mjs has created its project:
 *   node bench/timeline-spike.mjs --work out/bench/timeline/spike
 *   node bench/timeline-60s.mjs --source-project out/bench/timeline/spike/project --work out/bench/timeline/60s
 */
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { validateHtmlComposition } from "../dist/html/validate.js";
import { BROWSER_ARGS, BROWSER_CONTEXT_OPTIONS, openCompositionSession } from "../dist/renderer/browser.js";
import { startPreviewServer } from "../dist/server/server.js";
import {
  defaultTimelineBenchRoot,
  parseTimelineBenchArgs,
  printTimelineBenchOptions,
} from "./timeline-bench-config.mjs";

const exec = promisify(execFile);
const options = parseTimelineBenchArgs(process.argv.slice(2));
if (options.help) {
  printTimelineBenchOptions(
    "timeline-60s.mjs",
    "\nBuilds the 60-second, three-layer project from the spike project.\n",
  );
  process.exit(0);
}
const sourceProject = options.sourceProject
  ? path.resolve(options.sourceProject)
  : path.join(defaultTimelineBenchRoot, "spike", "project");
const workRoot = options.work ? path.resolve(options.work) : path.join(defaultTimelineBenchRoot, "60s");
const projectRoot = options.project ? path.resolve(options.project) : path.join(workRoot, "project");
const outputDir = options.output ? path.resolve(options.output) : path.join(workRoot, "output");
const scratchDir = options.scratch ? path.resolve(options.scratch) : path.join(workRoot, "scratch");
const FPS = 30;
const SEGMENT_FRAMES = 300;
const SEGMENTS = 6;
const TOTAL_FRAMES = SEGMENT_FRAMES * SEGMENTS;
const MAX_CONCURRENT_SEGMENTS = 4;

function ms(value) {
  return Number(value.toFixed(1));
}

function gb(bytes) {
  return Number((bytes / 1_000_000_000).toFixed(3));
}

async function prepare() {
  if (!(await stat(sourceProject).catch(() => null))) {
    throw new Error(
      `Spike project not found: ${sourceProject}. Run node bench/timeline-spike.mjs first or pass --source-project.`,
    );
  }
  await rm(projectRoot, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(path.dirname(projectRoot), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  await cp(sourceProject, projectRoot, { recursive: true });
  for (const entry of ["compositions/base.html", "compositions/overlay.html"]) {
    const target = path.join(projectRoot, entry);
    const source = await readFile(target, "utf8");
    if (!source.includes('duration-in-frames="300"')) {
      throw new Error(`Expected a 300-frame composition in ${entry}.`);
    }
    await writeFile(target, source.replaceAll('duration-in-frames="300"', 'duration-in-frames="1800"'));
  }
  await mkdir(path.join(scratchDir, "segments"), { recursive: true });
  await mkdir(outputDir, { recursive: true });
}

async function captureBase({ serverUrl, info, diagnostics, startFrame, outputDir, prefix }) {
  const session = await openCompositionSession({
    serverUrl,
    entry: "compositions/base.html",
    props: {},
    info,
    staticDiagnostics: diagnostics,
  });
  const started = performance.now();
  let bytes = 0;
  try {
    for (let offset = 0; offset < SEGMENT_FRAMES; offset += 1) {
      await session.seek(startFrame + offset);
      const png = await session.capture();
      await writeFile(path.join(outputDir, `${prefix}-${String(offset).padStart(4, "0")}.png`), png);
      bytes += png.length;
    }
  } finally {
    await session.close();
  }
  return { elapsedMs: performance.now() - started, bytes };
}

async function captureOverlayTransparent({ serverUrl, width, height, startFrame, outputDir, prefix }) {
  const started = performance.now();
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  let bytes = 0;
  try {
    const context = await browser.newContext({
      ...BROWSER_CONTEXT_OPTIONS,
      viewport: { width, height },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    await page.goto(new URL("compositions/overlay.html?__fy-manual=1", serverUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(() => Boolean(window.__fy || window.__fyError), undefined, { timeout: 30_000 });
    await page.evaluate(async () => {
      const api = window.__fy;
      await api.ready;
      await api.load({ props: {} });
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
    } catch {
      // The composition has no external assets; the host load is the boundary.
    }
    await page.route("**/*", (route) => route.abort("blockedbyclient"));

    for (let offset = 0; offset < SEGMENT_FRAMES; offset += 1) {
      await page.evaluate(
        async ({ frame }) => {
          const api = window.__fy;
          api.seek(frame);
          await api.settle();
        },
        { frame: startFrame + offset },
      );
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      const png = Buffer.from(result.data, "base64");
      await writeFile(path.join(outputDir, `${prefix}-${String(offset).padStart(4, "0")}.png`), png);
      bytes += png.length;
    }
    await cdp.detach();
    await context.close();
  } finally {
    await browser.close();
  }
  return { elapsedMs: performance.now() - started, bytes };
}

async function encodeFfv1(pattern, outputPath) {
  const started = performance.now();
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(FPS),
    "-i",
    pattern,
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-pix_fmt",
    "bgra",
    outputPath,
  ]);
  return performance.now() - started;
}

async function compositeSegment({ baseFfv1, overlayFfv1, imagePath, outputPath }) {
  const started = performance.now();
  await exec(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      baseFfv1,
      "-i",
      overlayFfv1,
      "-i",
      imagePath,
      "-filter_complex",
      [
        "[0:v]format=rgba[base0]",
        "[1:v]scale=800:450,format=rgba,colorchannelmixer=aa=0.95[over]",
        "[2:v]scale=400:400,format=rgba,colorchannelmixer=aa=0.90[img]",
        "[base0][over]overlay=1064:56:format=auto[b1]",
        "[b1][img]overlay=72:608:format=auto[out]",
        "[out]format=yuv420p[final]",
      ].join(";"),
      "-map",
      "[final]",
      "-frames:v",
      String(SEGMENT_FRAMES),
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return performance.now() - started;
}

async function processSegment({ index, serverUrl, baseInfo, baseDiagnostics, overlayInfo, imagePath }) {
  const segmentStarted = performance.now();
  const dir = path.join(scratchDir, "segments", `seg-${String(index).padStart(2, "0")}`);
  await mkdir(dir, { recursive: true });
  const startFrame = index * SEGMENT_FRAMES;

  const [baseCapture, overlayCapture] = await Promise.all([
    captureBase({
      serverUrl,
      info: baseInfo,
      diagnostics: baseDiagnostics,
      startFrame,
      outputDir: dir,
      prefix: "base",
    }),
    captureOverlayTransparent({
      serverUrl,
      width: overlayInfo.metadata.width,
      height: overlayInfo.metadata.height,
      startFrame,
      outputDir: dir,
      prefix: "overlay",
    }),
  ]);

  const baseFfv1 = path.join(dir, "base-lossless.mkv");
  const overlayFfv1 = path.join(dir, "overlay-lossless.mkv");
  const [baseEncodeMs, overlayEncodeMs] = await Promise.all([
    encodeFfv1(path.join(dir, "base-%04d.png"), baseFfv1),
    encodeFfv1(path.join(dir, "overlay-%04d.png"), overlayFfv1),
  ]);
  const [baseSize, overlaySize] = await Promise.all([stat(baseFfv1), stat(overlayFfv1)]);
  const segmentPath = path.join(scratchDir, "segments", `segment-${String(index).padStart(2, "0")}.mp4`);
  const compositeMs = await compositeSegment({
    baseFfv1,
    overlayFfv1,
    imagePath,
    outputPath: segmentPath,
  });
  const segmentSize = await stat(segmentPath);

  const pngBytes = baseCapture.bytes + overlayCapture.bytes;
  const ffv1Bytes = baseSize.size + overlaySize.size;
  const totalWritten = pngBytes + ffv1Bytes + segmentSize.size;

  // Keep the segment MP4 for concatenation; remove the per-frame and lossless
  // intermediates so peak scratch reflects the segmented pipeline.
  await rm(baseFfv1, { force: true });
  await rm(overlayFfv1, { force: true });
  for (const file of await readdir(dir)) {
    if (file.endsWith(".png")) {
      await rm(path.join(dir, file), { force: true });
    }
  }

  return {
    index,
    segmentPath,
    startFrame,
    elapsedMs: ms(performance.now() - segmentStarted),
    capture: {
      baseMs: ms(baseCapture.elapsedMs),
      overlayMs: ms(overlayCapture.elapsedMs),
      pngBytes,
    },
    ffv1: {
      baseBytes: baseSize.size,
      overlayBytes: overlaySize.size,
      baseEncodeMs: ms(baseEncodeMs),
      overlayEncodeMs: ms(overlayEncodeMs),
    },
    compositeMs: ms(compositeMs),
    segmentBytes: segmentSize.size,
    totalWrittenBytes: totalWritten,
  };
}

async function main() {
  await prepare();
  const baseValidation = await validateHtmlComposition({
    projectRoot,
    entry: "compositions/base.html",
    props: {},
  });
  const overlayValidation = await validateHtmlComposition({
    projectRoot,
    entry: "compositions/overlay.html",
    props: {},
  });
  for (const [name, validation] of [
    ["base", baseValidation],
    ["overlay", overlayValidation],
  ]) {
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!validation.info || errors.length > 0) {
      throw new Error(
        `Composition ${name} is invalid: ${errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
      );
    }
    if (validation.info.metadata.durationInFrames !== TOTAL_FRAMES) {
      throw new Error(`Expected ${TOTAL_FRAMES} composition frames, got ${validation.info.metadata.durationInFrames}.`);
    }
  }

  const imagePath = path.join(projectRoot, "assets", "badge.png");
  const server = await startPreviewServer({ projectRoot, port: 0, host: "127.0.0.1" });
  const started = performance.now();
  try {
    const results = Array.from({ length: SEGMENTS });
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= SEGMENTS) {
          return;
        }
        results[index] = await processSegment({
          index,
          serverUrl: server.url,
          baseInfo: baseValidation.info,
          baseDiagnostics: baseValidation.diagnostics,
          overlayInfo: overlayValidation.info,
          imagePath,
        });
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_SEGMENTS }, () => worker()));

    const listPath = path.join(outputDir, "segments.txt");
    await writeFile(listPath, `${results.map((result) => `file '${result.segmentPath}'`).join("\n")}\n`);
    const videoPath = path.join(outputDir, "video-60s.mp4");
    await exec("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", videoPath]);

    const bedA = path.join(outputDir, "audio-a.wav");
    const bedB = path.join(outputDir, "audio-b.wav");
    const audioPath = path.join(outputDir, "audio-60s.wav");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=60",
      "-c:a",
      "pcm_s16le",
      bedA,
    ]);
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=60",
      "-c:a",
      "pcm_s16le",
      bedB,
    ]);
    const audioStarted = performance.now();
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      bedA,
      "-i",
      bedB,
      "-filter_complex",
      "[0:a][1:a]amix=inputs=2:duration=longest,volume=0.25[out]",
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
    const audioMixMs = performance.now() - audioStarted;

    const finalPath = path.join(outputDir, "timeline-60s.mp4");
    const muxStarted = performance.now();
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      finalPath,
    ]);
    const muxMs = performance.now() - muxStarted;
    const finalSize = await stat(finalPath);
    const totalElapsedMs = performance.now() - started;

    const result = {
      benchmark: "segmented-timeline-60s",
      projectRoot,
      outputDir,
      scratchDir,
      format: { width: 1920, height: 1080, fps: FPS },
      timelineFrames: TOTAL_FRAMES,
      timelineSeconds: TOTAL_FRAMES / FPS,
      segmentFrames: SEGMENT_FRAMES,
      segments: SEGMENTS,
      maxConcurrentSegments: MAX_CONCURRENT_SEGMENTS,
      peakCaptureSessions: MAX_CONCURRENT_SEGMENTS * 2,
      layers: [
        "base composition 1920x1080 (0-60s)",
        "overlay composition 640x360 -> 800x450, alpha (0-60s)",
        "image 400x400 (0-60s)",
        "two mixed sine beds (audio)",
      ],
      totalElapsedMs: ms(totalElapsedMs),
      totalElapsedMinutes: Number((totalElapsedMs / 60000).toFixed(2)),
      segmentsDetail: results,
      totalWrittenGb: gb(results.reduce((sum, item) => sum + item.totalWrittenBytes, 0)),
      videoBytes: (await stat(videoPath)).size,
      finalBytes: finalSize.size,
      finalGb: gb(finalSize.size),
      audioMixMs: ms(audioMixMs),
      muxMs: ms(muxMs),
      outputs: {
        final: finalPath,
        video: videoPath,
        audio: audioPath,
        segments: listPath,
      },
    };
    await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
