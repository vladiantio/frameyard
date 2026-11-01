#!/usr/bin/env node
/**
 * Lossless-segment benchmark for the long-form timeline decision.
 *
 * Reuses the generated project from bench/timeline-spike.mjs, captures
 * 10 seconds of the base and overlay compositions as PNG frames on the USB HDD,
 * encodes them to FFV1, composites them with FFmpeg, and reports measured sizes
 * and times. It is a measurement tool, not production code.
 *
 * Run after the live-host spike has created its project:
 *   node bench/timeline-spike.mjs --work out/bench/timeline/spike
 *   node bench/timeline-lossless-segment.mjs --project out/bench/timeline/spike/project --output out/bench/timeline/lossless
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateHtmlComposition } from "../dist/html/validate.js";
import { openCompositionSession } from "../dist/renderer/browser.js";
import { startPreviewServer } from "../dist/server/server.js";
import {
  defaultTimelineBenchRoot,
  parseTimelineBenchArgs,
  printTimelineBenchOptions,
} from "./timeline-bench-config.mjs";

const exec = promisify(execFile);
const options = parseTimelineBenchArgs(process.argv.slice(2));
if (options.help) {
  printTimelineBenchOptions("timeline-lossless-segment.mjs", "\nMeasures a 10-second lossless segment.\n");
  process.exit(0);
}
const projectRoot = options.project
  ? path.resolve(options.project)
  : path.join(defaultTimelineBenchRoot, "spike", "project");
const outputDir = options.output ? path.resolve(options.output) : path.join(defaultTimelineBenchRoot, "lossless");
const scratchDir = options.scratch ? path.resolve(options.scratch) : outputDir;
const framesRoot = path.join(scratchDir, "frames");
const encodedRoot = path.join(outputDir, "encoded");
const FPS = 30;
const SEGMENT_SECONDS = 10;
const FRAMES = FPS * SEGMENT_SECONDS;

function formatMs(ms) {
  return Number(ms.toFixed(2));
}

function formatGb(bytes) {
  return Number((bytes / 1_000_000_000).toFixed(3));
}

async function captureComposition({ serverUrl, entry, outputDir, name, info, diagnostics }) {
  const session = await openCompositionSession({
    serverUrl,
    entry,
    props: {},
    info,
    staticDiagnostics: diagnostics,
  });
  const started = performance.now();
  let bytes = 0;
  try {
    for (let frame = 0; frame < FRAMES; frame += 1) {
      await session.seek(frame);
      const png = await session.capture();
      await writeFile(path.join(outputDir, `${name}-${String(frame).padStart(4, "0")}.png`), png);
      bytes += png.length;
    }
  } finally {
    await session.close();
  }
  return { elapsedMs: performance.now() - started, pngBytes: bytes };
}

async function encodeFfv1(inputPattern, outputPath) {
  const started = performance.now();
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(FPS),
    "-i",
    inputPattern,
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

async function main() {
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
  }

  await rm(outputDir, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(path.join(framesRoot, "base"), { recursive: true });
  await mkdir(path.join(framesRoot, "overlay"), { recursive: true });
  await mkdir(encodedRoot, { recursive: true });

  const server = await startPreviewServer({ projectRoot, port: 0, host: "127.0.0.1" });
  try {
    const captureStarted = performance.now();
    const [baseCapture, overlayCapture] = await Promise.all([
      captureComposition({
        serverUrl: server.url,
        entry: "compositions/base.html",
        outputDir: path.join(framesRoot, "base"),
        name: "base",
        info: baseValidation.info,
        diagnostics: baseValidation.diagnostics,
      }),
      captureComposition({
        serverUrl: server.url,
        entry: "compositions/overlay.html",
        outputDir: path.join(framesRoot, "overlay"),
        name: "overlay",
        info: overlayValidation.info,
        diagnostics: overlayValidation.diagnostics,
      }),
    ]);
    const captureElapsedMs = performance.now() - captureStarted;

    const baseFrames = (await readdir(path.join(framesRoot, "base"))).length;
    const overlayFrames = (await readdir(path.join(framesRoot, "overlay"))).length;
    if (baseFrames !== FRAMES || overlayFrames !== FRAMES) {
      throw new Error(`Expected ${FRAMES} frames per composition; got base=${baseFrames}, overlay=${overlayFrames}.`);
    }

    const baseFfv1 = path.join(encodedRoot, "base-lossless.mkv");
    const overlayFfv1 = path.join(encodedRoot, "overlay-lossless.mkv");
    const [baseEncodeMs, overlayEncodeMs] = await Promise.all([
      encodeFfv1(path.join(framesRoot, "base", "base-%04d.png"), baseFfv1),
      encodeFfv1(path.join(framesRoot, "overlay", "overlay-%04d.png"), overlayFfv1),
    ]);
    const [baseSize, overlaySize] = await Promise.all([stat(baseFfv1), stat(overlayFfv1)]);

    const finalPath = path.join(encodedRoot, "segment-final.mp4");
    const compositeStarted = performance.now();
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
        path.join(projectRoot, "assets", "clip.mp4"),
        "-i",
        path.join(projectRoot, "assets", "badge.png"),
        "-filter_complex",
        [
          "[0:v]format=rgba[base0]",
          "[2:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=rgba,colorchannelmixer=aa=0.28[vid]",
          "[1:v]scale=800:450,format=rgba,colorchannelmixer=aa=0.95[over]",
          "[3:v]scale=400:400,format=rgba,colorchannelmixer=aa=0.90[img]",
          "[base0][vid]overlay=0:0:format=auto[b1]",
          "[b1][over]overlay=1608:56:format=auto[b2]",
          "[b2][img]overlay=72:608:format=auto[out]",
          "[out]format=yuv420p[final]",
        ].join(";"),
        "-map",
        "[final]",
        "-frames:v",
        String(FRAMES),
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
        finalPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const compositeElapsedMs = performance.now() - compositeStarted;
    const finalSize = await stat(finalPath);

    const timelineMinutes = 60;
    const htmlShare = 0.5;
    const htmlMinutes = timelineMinutes * htmlShare;
    const workers = 8;
    const compositionLayers = 2;
    const segmentsPerComposition = (htmlMinutes * 60) / SEGMENT_SECONDS;
    const compositionSegments = segmentsPerComposition * compositionLayers;
    const extrapolatedFfv1Bytes = (baseSize.size + overlaySize.size) * segmentsPerComposition;
    const hddWriteBytesPerSecond = 100_000_000;
    const extrapolatedWriteSeconds = extrapolatedFfv1Bytes / hddWriteBytesPerSecond;
    // Each composition segment is captured by one Chromium session. Use the
    // per-composition time, not the wall time of two sessions running in
    // parallel, so the worker estimate is not optimistic by the layer count.
    const extrapolatedCaptureSeconds = ((baseCapture.elapsedMs / 1000) * compositionSegments) / workers;
    const extrapolatedFfv1EncodeSeconds =
      (((baseEncodeMs + overlayEncodeMs) / 1000) * segmentsPerComposition) / workers;
    const extrapolatedEncodeSeconds =
      ((compositeElapsedMs / 1000) * (timelineMinutes * 60)) / SEGMENT_SECONDS / workers;
    const estimatedTotalSeconds =
      extrapolatedCaptureSeconds + extrapolatedFfv1EncodeSeconds + extrapolatedEncodeSeconds;

    const result = {
      benchmark: "lossless-segment",
      projectRoot,
      outputDir,
      format: { width: 1920, height: 1080, fps: FPS },
      segmentSeconds: SEGMENT_SECONDS,
      layers: [
        "base composition 1920x1080",
        "video 1920x1080 @ 0.28",
        "overlay composition 640x360 -> 800x450 @ 0.95",
        "image 400x400",
      ],
      capture: {
        elapsedMs: formatMs(captureElapsedMs),
        baseCompositionMs: formatMs(baseCapture.elapsedMs),
        overlayCompositionMs: formatMs(overlayCapture.elapsedMs),
        basePngBytes: baseCapture.pngBytes,
        overlayPngBytes: overlayCapture.pngBytes,
        basePngGb: formatGb(baseCapture.pngBytes),
        overlayPngGb: formatGb(overlayCapture.pngBytes),
      },
      ffv1: {
        baseBytes: baseSize.size,
        overlayBytes: overlaySize.size,
        baseGb: formatGb(baseSize.size),
        overlayGb: formatGb(overlaySize.size),
        baseEncodeMs: formatMs(baseEncodeMs),
        overlayEncodeMs: formatMs(overlayEncodeMs),
      },
      final: {
        path: finalPath,
        bytes: finalSize.size,
        gb: formatGb(finalSize.size),
        compositeEncodeMs: formatMs(compositeElapsedMs),
      },
      extrapolation: {
        timelineMinutes,
        htmlShare,
        htmlMinutes,
        workers,
        compositionLayers,
        segmentsPerComposition,
        compositionSegments,
        ffv1Bytes: extrapolatedFfv1Bytes,
        ffv1Gb: formatGb(extrapolatedFfv1Bytes),
        hddWriteBytesPerSecond,
        hddWriteSeconds: Number(extrapolatedWriteSeconds.toFixed(1)),
        hddWriteMinutes: Number((extrapolatedWriteSeconds / 60).toFixed(1)),
        captureSecondsWithWorkers: Number(extrapolatedCaptureSeconds.toFixed(1)),
        captureMinutesWithWorkers: Number((extrapolatedCaptureSeconds / 60).toFixed(1)),
        ffv1EncodeSecondsWithWorkers: Number(extrapolatedFfv1EncodeSeconds.toFixed(1)),
        finalEncodeSecondsWithWorkers: Number(extrapolatedEncodeSeconds.toFixed(1)),
        finalEncodeMinutesWithWorkers: Number((extrapolatedEncodeSeconds / 60).toFixed(1)),
        estimatedTotalSeconds: Number(estimatedTotalSeconds.toFixed(1)),
        estimatedTotalMinutes: Number((estimatedTotalSeconds / 60).toFixed(1)),
        note: "Extrapolation assumes two composition layers for 50% of the timeline, 8 workers, and 100 MB/s sequential HDD writes. It excludes media decode, audio, ffmpeg startup, the final concat, and CPU contention between capture and encoding.",
      },
      outputs: {
        baseFfv1,
        overlayFfv1,
        final: finalPath,
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
