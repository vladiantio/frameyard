#!/usr/bin/env node
/**
 * 60-second, three-layer, 50/50 gate: one composition, one video, one image,
 * eight concurrent segment pipelines (eight Chromium capture sessions), audio.
 *
 * Run after bench/timeline-60s.mjs has created the 1800-frame project:
 *   node bench/timeline-60s.mjs --work out/bench/timeline/60s
 *   node bench/timeline-5050-60s.mjs --project out/bench/timeline/60s/project --output out/bench/timeline/5050-60s
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
  printTimelineBenchOptions("timeline-5050-60s.mjs", "\nMeasures the 50/50 60-second gate with eight workers.\n");
  process.exit(0);
}
const projectRoot = options.project
  ? path.resolve(options.project)
  : path.join(defaultTimelineBenchRoot, "60s", "project");
const outputDir = options.output ? path.resolve(options.output) : path.join(defaultTimelineBenchRoot, "5050-60s");
const scratchDir = options.scratch ? path.resolve(options.scratch) : outputDir;
const FPS = 30;
const SEGMENT_FRAMES = 225;
const SEGMENTS = 8;
const TOTAL_FRAMES = SEGMENT_FRAMES * SEGMENTS;
const MAX_CONCURRENT_SEGMENTS = 8;

function ms(value) {
  return Number(value.toFixed(1));
}

function gb(bytes) {
  return Number((bytes / 1_000_000_000).toFixed(3));
}

async function captureBase({ serverUrl, info, diagnostics, startFrame, outputDir }) {
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
      await writeFile(path.join(outputDir, `base-${String(offset).padStart(4, "0")}.png`), png);
      bytes += png.length;
    }
  } finally {
    await session.close();
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

async function compositeSegment({ baseFfv1, videoPath, imagePath, startFrame, outputPath }) {
  const started = performance.now();
  const startSeconds = startFrame / FPS;
  const durationSeconds = SEGMENT_FRAMES / FPS;
  await exec(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      baseFfv1,
      "-ss",
      String(startSeconds),
      "-t",
      String(durationSeconds),
      "-i",
      videoPath,
      "-i",
      imagePath,
      "-filter_complex",
      [
        "[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=rgba,colorchannelmixer=aa=0.28[vid]",
        "[2:v]scale=400:400,format=rgba,colorchannelmixer=aa=0.90[img]",
        "[0:v][vid]overlay=0:0:format=auto[b1]",
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

async function processSegment({ index, serverUrl, baseInfo, baseDiagnostics, videoPath, imagePath }) {
  const segmentStarted = performance.now();
  const dir = path.join(scratchDir, "segments", `seg-${String(index).padStart(2, "0")}`);
  await mkdir(dir, { recursive: true });
  const startFrame = index * SEGMENT_FRAMES;

  const baseCapture = await captureBase({
    serverUrl,
    info: baseInfo,
    diagnostics: baseDiagnostics,
    startFrame,
    outputDir: dir,
  });
  const baseFfv1 = path.join(dir, "base-lossless.mkv");
  const baseEncodeMs = await encodeFfv1(path.join(dir, "base-%04d.png"), baseFfv1);
  const baseSize = await stat(baseFfv1);
  const segmentPath = path.join(scratchDir, "segments", `segment-${String(index).padStart(2, "0")}.mp4`);
  const compositeMs = await compositeSegment({
    baseFfv1,
    videoPath,
    imagePath,
    startFrame,
    outputPath: segmentPath,
  });
  const segmentSize = await stat(segmentPath);

  await rm(baseFfv1, { force: true });
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
    capture: { baseMs: ms(baseCapture.elapsedMs), pngBytes: baseCapture.bytes },
    ffv1: { baseBytes: baseSize.size, baseEncodeMs: ms(baseEncodeMs) },
    compositeMs: ms(compositeMs),
    segmentBytes: segmentSize.size,
    totalWrittenBytes: baseCapture.bytes + baseSize.size + segmentSize.size,
  };
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(path.join(scratchDir, "segments"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const baseValidation = await validateHtmlComposition({
    projectRoot,
    entry: "compositions/base.html",
    props: {},
  });
  const errors = baseValidation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!baseValidation.info || errors.length > 0) {
    throw new Error(errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; "));
  }
  if (baseValidation.info.metadata.durationInFrames !== TOTAL_FRAMES) {
    throw new Error(
      `Expected ${TOTAL_FRAMES} composition frames, got ${baseValidation.info.metadata.durationInFrames}.`,
    );
  }

  const sourceVideo = path.join(projectRoot, "assets", "clip.mp4");
  const loopedVideo = path.join(scratchDir, "video-loop-60s.mp4");
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-stream_loop",
    "4",
    "-i",
    sourceVideo,
    "-t",
    "60",
    "-c",
    "copy",
    loopedVideo,
  ]);
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

    const result = {
      benchmark: "segmented-timeline-5050-60s",
      projectRoot,
      outputDir,
      scratchDir,
      format: { width: 1920, height: 1080, fps: FPS },
      timelineFrames: TOTAL_FRAMES,
      timelineSeconds: TOTAL_FRAMES / FPS,
      segmentFrames: SEGMENT_FRAMES,
      segments: SEGMENTS,
      maxConcurrentSegments: MAX_CONCURRENT_SEGMENTS,
      peakCaptureSessions: MAX_CONCURRENT_SEGMENTS,
      layers: [
        "base composition 1920x1080 (0-60s)",
        "looped video 1280x720 -> 1920x1080 @ 0.28 (0-60s)",
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
