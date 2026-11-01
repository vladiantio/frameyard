#!/usr/bin/env node
/**
 * Representative 60-second gate: 50/50 composition/media by layer-seconds,
 * 60% one visual layer, 30% two, 10% three, audio, eight segment workers.
 *
 * Timeline (1800 frames, 30 fps):
 *   0-15s   base composition + overlay composition (2 layers)
 *   15-18s  base composition + full-frame video overlay (2 layers)
 *   18-30s  base composition (1 layer)
 *   30-54s  video (1 layer)
 *   54-60s  video + offset video overlay + image (3 layers)
 *
 * Composition layer-seconds: base 30s + overlay 15s = 45.
 * Media layer-seconds: video 3+24+6+6 + image 6 = 45.
 *
 * Run after bench/timeline-60s.mjs has created the 1800-frame project.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    "timeline-representative-60s.mjs",
    "\nMeasures the representative 50/50, 60/30/10 60-second gate.\n",
  );
  process.exit(0);
}
const projectRoot = options.project
  ? path.resolve(options.project)
  : path.join(defaultTimelineBenchRoot, "60s", "project");
const outputDir = options.output
  ? path.resolve(options.output)
  : path.join(defaultTimelineBenchRoot, "representative-60s");
const scratchDir = options.scratch ? path.resolve(options.scratch) : outputDir;
const FPS = 30;
const TOTAL_FRAMES = 1800;
const MAX_CONCURRENT_SEGMENTS = options.workers ?? Number(process.env.WORKERS ?? 8);
const VIDEO_1080 = options.video1080 || process.env.VIDEO_1080 === "1";
const COPY_VIDEO = options.copyVideo || process.env.COPY_VIDEO === "1";

const SEGMENTS = [
  {
    id: "s1",
    start: 0,
    end: 225,
    layers: [
      { kind: "composition", entry: "base", sourceStart: 0 },
      { kind: "composition", entry: "overlay", sourceStart: 0, pip: true },
    ],
  },
  {
    id: "s2",
    start: 225,
    end: 450,
    layers: [
      { kind: "composition", entry: "base", sourceStart: 225 },
      { kind: "composition", entry: "overlay", sourceStart: 225, pip: true },
    ],
  },
  {
    id: "s3",
    start: 450,
    end: 540,
    layers: [
      { kind: "composition", entry: "base", sourceStart: 450 },
      { kind: "video", opacity: 0.28 },
    ],
  },
  { id: "s4", start: 540, end: 780, layers: [{ kind: "composition", entry: "base", sourceStart: 540 }] },
  { id: "s5", start: 780, end: 900, layers: [{ kind: "composition", entry: "base", sourceStart: 780 }] },
  { id: "s6", start: 900, end: 1140, layers: [{ kind: "video", opacity: 1 }] },
  { id: "s7", start: 1140, end: 1380, layers: [{ kind: "video", opacity: 1 }] },
  { id: "s8", start: 1380, end: 1620, layers: [{ kind: "video", opacity: 1 }] },
  {
    id: "s9",
    start: 1620,
    end: 1800,
    layers: [{ kind: "video", opacity: 1 }, { kind: "video", opacity: 0.28, offsetSeconds: 6 }, { kind: "image" }],
  },
];

function ms(value) {
  return Number(value.toFixed(1));
}

function gb(bytes) {
  return Number((bytes / 1_000_000_000).toFixed(3));
}

async function captureComposition({
  serverUrl,
  entry,
  info,
  diagnostics,
  startFrame,
  frames,
  outputDir,
  prefix,
  transparent,
}) {
  if (!transparent) {
    const session = await openCompositionSession({
      serverUrl,
      entry: `compositions/${entry}.html`,
      props: {},
      info,
      staticDiagnostics: diagnostics,
    });
    const started = performance.now();
    let bytes = 0;
    try {
      for (let offset = 0; offset < frames; offset += 1) {
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

  const started = performance.now();
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  let bytes = 0;
  try {
    const context = await browser.newContext({
      ...BROWSER_CONTEXT_OPTIONS,
      viewport: { width: info.metadata.width, height: info.metadata.height },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.goto(new URL(`compositions/${entry}.html?__fy-manual=1`, serverUrl).href, {
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
    for (let offset = 0; offset < frames; offset += 1) {
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

async function compositeSegment({ segment, layerFiles, videoPath, imagePath, outputPath }) {
  const args = ["-y", "-v", "error"];
  const filters = [];
  let inputIndex = 0;
  let baseLabel = null;

  for (const [layerIndex, layer] of segment.layers.entries()) {
    if (layer.kind === "composition") {
      args.push("-i", layerFiles[layerIndex]);
      const label = `c${inputIndex}`;
      filters.push(`[${inputIndex}:v]format=rgba[${label}]`);
      if (!baseLabel && !layer.pip) {
        baseLabel = label;
      } else {
        filters.push(`[${label}]scale=800:450,format=rgba,colorchannelmixer=aa=0.95[o${layerIndex}]`);
      }
      inputIndex += 1;
      continue;
    }
    if (layer.kind === "image") {
      args.push("-i", imagePath);
      filters.push(`[${inputIndex}:v]scale=400:400,format=rgba,colorchannelmixer=aa=0.90[o${layerIndex}]`);
      inputIndex += 1;
      continue;
    }
    if (layer.kind === "video") {
      const startSeconds = (segment.start + (layer.offsetSeconds ?? 0) / (1 / FPS)) / FPS;
      const durationSeconds = (segment.end - segment.start) / FPS;
      args.push("-ss", String(startSeconds), "-t", String(durationSeconds), "-i", videoPath);
      const label = `v${inputIndex}`;
      const opacity = layer.opacity ?? 1;
      filters.push(
        `[${inputIndex}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=rgba,colorchannelmixer=aa=${opacity}[${label}]`,
      );
      if (opacity === 1) {
        baseLabel = label;
      } else {
        filters.push(`[${label}]null[o${layerIndex}]`);
      }
      inputIndex += 1;
    }
  }

  if (!baseLabel) {
    throw new Error(`Segment ${segment.id} has no base layer.`);
  }
  let current = baseLabel;
  let overlayIndex = 0;
  for (const [layerIndex, layer] of segment.layers.entries()) {
    if (layer.kind === "composition" && !layer.pip) {
      continue;
    }
    if (layer.kind === "video" && (layer.opacity ?? 1) === 1) {
      continue;
    }
    const next = `b${overlayIndex}`;
    const x = layer.kind === "image" ? 72 : layer.pip ? 1064 : 0;
    const y = layer.kind === "image" ? 608 : layer.pip ? 56 : 0;
    filters.push(`[${current}][o${layerIndex}]overlay=${x}:${y}:format=auto[${next}]`);
    current = next;
    overlayIndex += 1;
  }
  filters.push(`[${current}]format=yuv420p[final]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[final]",
    "-frames:v",
    String(segment.end - segment.start),
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
  );
  const started = performance.now();
  await exec("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
  return performance.now() - started;
}

async function processSegment({ segment, serverUrl, infoByEntry, videoPath, imagePath }) {
  const segmentStarted = performance.now();
  const dir = path.join(scratchDir, "segments", segment.id);
  await mkdir(dir, { recursive: true });
  const frames = segment.end - segment.start;

  if (
    COPY_VIDEO &&
    segment.layers.length === 1 &&
    segment.layers[0].kind === "video" &&
    (segment.layers[0].opacity ?? 1) === 1
  ) {
    const segmentPath = path.join(scratchDir, "segments", `${segment.id}.mp4`);
    const started = performance.now();
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      String(segment.start / FPS),
      "-t",
      String(frames / FPS),
      "-i",
      videoPath,
      "-an",
      "-c",
      "copy",
      segmentPath,
    ]);
    const segmentSize = await stat(segmentPath);
    return {
      id: segment.id,
      segmentPath,
      start: segment.start,
      end: segment.end,
      frames,
      layers: 1,
      elapsedMs: ms(performance.now() - segmentStarted),
      captureMs: 0,
      encodeMs: 0,
      compositeMs: ms(performance.now() - started),
      pngBytes: 0,
      ffv1Bytes: 0,
      segmentBytes: segmentSize.size,
      totalWrittenBytes: segmentSize.size,
      copiedVideo: true,
    };
  }

  const compositionLayers = segment.layers
    .map((layer, layerIndex) => ({ layer, layerIndex }))
    .filter(({ layer }) => layer.kind === "composition");

  const captures = await Promise.all(
    compositionLayers.map(async ({ layer, layerIndex }) => {
      const validation = infoByEntry[layer.entry];
      const capture = await captureComposition({
        serverUrl,
        entry: layer.entry,
        info: validation.info,
        diagnostics: validation.diagnostics,
        startFrame: layer.sourceStart,
        frames,
        outputDir: dir,
        prefix: `${layer.entry}-${layerIndex}`,
        transparent: layer.entry === "overlay",
      });
      const pattern = path.join(dir, `${layer.entry}-${layerIndex}-%04d.png`);
      const ffv1 = path.join(dir, `${layer.entry}-${layerIndex}.mkv`);
      const encodeMs = await encodeFfv1(pattern, ffv1);
      const size = await stat(ffv1);
      return { layerIndex, capture, ffv1, encodeMs, size };
    }),
  );

  const layerFiles = {};
  const ffv1Bytes = captures.reduce((sum, capture) => sum + capture.size.size, 0);
  const pngBytes = captures.reduce((sum, capture) => sum + capture.capture.bytes, 0);
  const captureMs = Math.max(0, ...captures.map((capture) => capture.capture.elapsedMs));
  const encodeMs = Math.max(0, ...captures.map((capture) => capture.encodeMs));
  for (const capture of captures) {
    layerFiles[capture.layerIndex] = capture.ffv1;
  }

  const segmentPath = path.join(scratchDir, "segments", `${segment.id}.mp4`);
  const compositeMs = await compositeSegment({
    segment,
    layerFiles,
    videoPath,
    imagePath,
    outputPath: segmentPath,
  });
  const segmentSize = await stat(segmentPath);

  for (const capture of captures) {
    await rm(capture.ffv1, { force: true });
  }
  for (const file of await readdir(dir)) {
    if (file.endsWith(".png")) {
      await rm(path.join(dir, file), { force: true });
    }
  }

  return {
    id: segment.id,
    segmentPath,
    start: segment.start,
    end: segment.end,
    frames,
    layers: segment.layers.length,
    elapsedMs: ms(performance.now() - segmentStarted),
    captureMs: ms(captureMs),
    encodeMs: ms(encodeMs),
    compositeMs: ms(compositeMs),
    pngBytes,
    ffv1Bytes,
    segmentBytes: segmentSize.size,
    totalWrittenBytes: pngBytes + ffv1Bytes + segmentSize.size,
  };
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(path.join(scratchDir, "segments"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const infoByEntry = {};
  const diagnosticsByEntry = {};
  for (const entry of ["base", "overlay"]) {
    const validation = await validateHtmlComposition({
      projectRoot,
      entry: `compositions/${entry}.html`,
      props: {},
    });
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!validation.info || errors.length > 0) {
      throw new Error(
        `${entry}: ${errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
      );
    }
    if (validation.info.metadata.durationInFrames !== TOTAL_FRAMES) {
      throw new Error(`${entry} must have ${TOTAL_FRAMES} frames.`);
    }
    infoByEntry[entry] = validation;
    diagnosticsByEntry[entry] = validation.diagnostics;
  }

  const sourceVideo = path.join(projectRoot, "assets", "clip.mp4");
  const loopedVideo = path.join(scratchDir, VIDEO_1080 ? "video-loop-120s-1080.mp4" : "video-loop-120s.mp4");
  if (VIDEO_1080) {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-stream_loop",
      "9",
      "-i",
      sourceVideo,
      "-t",
      "120",
      "-vf",
      "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
      "-r",
      String(FPS),
      "-an",
      "-force_key_frames",
      "30,38,46,54",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      loopedVideo,
    ]);
  } else {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-stream_loop",
      "9",
      "-i",
      sourceVideo,
      "-t",
      "120",
      "-an",
      "-c",
      "copy",
      loopedVideo,
    ]);
  }
  const imagePath = path.join(projectRoot, "assets", "badge.png");

  const server = await startPreviewServer({ projectRoot, port: 0, host: "127.0.0.1" });
  const started = performance.now();
  try {
    const results = Array.from({ length: SEGMENTS.length });
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= SEGMENTS.length) {
          return;
        }
        results[index] = await processSegment({
          segment: SEGMENTS[index],
          serverUrl: server.url,
          infoByEntry,
          diagnosticsByEntry,
          videoPath: loopedVideo,
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

    const oneLayerFrames = results
      .filter((result) => result.layers === 1)
      .reduce((sum, result) => sum + result.frames, 0);
    const twoLayerFrames = results
      .filter((result) => result.layers === 2)
      .reduce((sum, result) => sum + result.frames, 0);
    const threeLayerFrames = results
      .filter((result) => result.layers === 3)
      .reduce((sum, result) => sum + result.frames, 0);

    const result = {
      benchmark: "segmented-timeline-representative-60s",
      projectRoot,
      outputDir,
      scratchDir,
      format: { width: 1920, height: 1080, fps: FPS },
      timelineFrames: TOTAL_FRAMES,
      timelineSeconds: TOTAL_FRAMES / FPS,
      maxConcurrentSegments: MAX_CONCURRENT_SEGMENTS,
      occupancy: {
        oneLayerSeconds: oneLayerFrames / FPS,
        twoLayerSeconds: twoLayerFrames / FPS,
        threeLayerSeconds: threeLayerFrames / FPS,
        oneLayerPercent: Number(((oneLayerFrames / TOTAL_FRAMES) * 100).toFixed(1)),
        twoLayerPercent: Number(((twoLayerFrames / TOTAL_FRAMES) * 100).toFixed(1)),
        threeLayerPercent: Number(((threeLayerFrames / TOTAL_FRAMES) * 100).toFixed(1)),
      },
      layerSeconds: {
        composition: 45,
        media: 45,
        note: "Base composition 30s + overlay composition 15s; base video 30s + overlay video 9s + image 6s.",
      },
      totalElapsedMs: ms(totalElapsedMs),
      totalElapsedMinutes: Number((totalElapsedMs / 60000).toFixed(2)),
      segmentsDetail: results,
      totalWrittenGb: gb(results.reduce((sum, item) => sum + item.totalWrittenBytes, 0)),
      videoBytes: (await stat(videoPath)).size,
      finalBytes: finalSize.size,
      finalGb: gb(finalSize.size),
      audioMixMs: ms(audioMixMs),
      muxMs: ms(muxMs),
      outputs: { final: finalPath, video: videoPath, audio: audioPath, segments: listPath },
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
