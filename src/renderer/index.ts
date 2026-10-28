import { link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompositionMetadata, Props } from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import type { Project } from "../project.js";
import { startPreviewServer } from "../server/server.js";
import { inspectTimelineAudio, type AudioInspection } from "./audio.js";
import { openCompositionSession, type CompositionSession } from "./browser.js";
import { assertFfmpegCapabilities, mixAudioTimeline, startVideoEncoder } from "./ffmpeg.js";
import { inspectTranscriptClips, type TranscriptInspection } from "./transcripts.js";

export interface ProgressEvent {
  frame: number;
  total: number;
  elapsedMs: number;
}

interface SessionOptions {
  project: Project;
  compositionId: string;
  props?: unknown;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface CheckResult {
  composition: string;
  metadata: CompositionMetadata;
  framesChecked: number;
  audio: {
    clips: number;
    warnings: string[];
    details: AudioInspection["clips"];
  };
  transcripts: {
    clips: number;
    warnings: string[];
    details: TranscriptInspection["clips"];
  };
  elapsedMs: number;
}

export interface StillResult {
  composition: string;
  frame: number;
  path: string;
  width: number;
  height: number;
  elapsedMs: number;
}

export interface RenderResult {
  composition: string;
  path: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
  framesRendered: number;
  bytes: number;
  audio: {
    clips: number;
    warnings: string[];
  };
  transcripts: {
    clips: number;
    warnings: string[];
  };
  elapsedMs: number;
}

function compositionEntry(project: Project, id: string): string {
  const composition = project.compositions.get(id);
  if (!composition) {
    const available = [...project.compositions.keys()].join(", ") || "(none)";
    throw new FrameyardError(
      "COMPOSITION_NOT_FOUND",
      `Composition "${id}" is not listed in video.config.js. Available: ${available}.`,
    );
  }
  return composition.entry;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FrameyardError("RENDER_FAILED", "Operation cancelled.");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureOutputAvailable(outPath: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await pathExists(outPath))) {
    throw new FrameyardError(
      "OUTPUT_EXISTS",
      `Output already exists: ${outPath}. Pass --overwrite to replace it.`,
    );
  }
  await mkdir(path.dirname(outPath), { recursive: true });
}

async function publishFile(tempPath: string, outPath: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    await rename(tempPath, outPath);
    return;
  }

  try {
    await link(tempPath, outPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Output already exists: ${outPath}. Pass --overwrite to replace it.`,
      );
    }
    throw new FrameyardError("RENDER_FAILED", `Could not publish output ${outPath}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function withSession<T>(
  options: SessionOptions,
  callback: (session: CompositionSession) => Promise<T>,
): Promise<T> {
  throwIfAborted(options.signal);
  const entry = compositionEntry(options.project, options.compositionId);
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  let session: CompositionSession | undefined;

  try {
    try {
      session = await openCompositionSession({
        serverUrl: server.url,
        entry,
        props: options.props,
      });
      return await callback(session);
    } catch (error) {
      if (isFrameyardError(error)) {
        throw new FrameyardError(
          error.code,
          `Composition "${options.compositionId}": ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // Preserve the command's original error.
      }
    }
    try {
      await server.close();
    } catch {
      // Preserve the command's original error.
    }
  }
}

function reportProgress(options: SessionOptions, frame: number, total: number, startedAt: number): void {
  options.onProgress?.({ frame, total, elapsedMs: performance.now() - startedAt });
}

export async function checkComposition(options: SessionOptions): Promise<CheckResult> {
  const startedAt = performance.now();
  return withSession(options, async (session) => {
    const total = session.metadata.durationInFrames;
    const audio = await inspectTimelineAudio({
      projectRoot: options.project.root,
      clips: session.audioClips,
      fps: session.metadata.fps,
      durationInFrames: total,
      signal: options.signal,
    });
    const transcripts = await inspectTranscriptClips({
      projectRoot: options.project.root,
      clips: session.transcriptClips,
      signal: options.signal,
    });

    for (let frame = 0; frame < total; frame += 1) {
      throwIfAborted(options.signal);
      await session.seek(frame);
      reportProgress(options, frame + 1, total, startedAt);
    }

    return {
      composition: options.compositionId,
      metadata: session.metadata,
      framesChecked: total,
      audio: { clips: audio.clips.length, warnings: audio.warnings, details: audio.clips },
      transcripts: {
        clips: transcripts.clips.length,
        warnings: transcripts.warnings,
        details: transcripts.clips,
      },
      elapsedMs: performance.now() - startedAt,
    };
  });
}

export async function captureStill(
  options: SessionOptions & {
    frame: number;
    outPath: string;
    overwrite?: boolean;
  },
): Promise<StillResult> {
  if (!Number.isInteger(options.frame) || options.frame < 0) {
    throw new FrameyardError("FRAME_OUT_OF_RANGE", `--frame must be a non-negative integer; received ${options.frame}.`);
  }
  if (path.extname(options.outPath).toLowerCase() !== ".png") {
    throw new FrameyardError("USAGE", `Still output must use a .png extension: ${options.outPath}`);
  }

  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(options.outPath, overwrite);
  const startedAt = performance.now();

  return withSession(options, async (session) => {
    const total = session.metadata.durationInFrames;
    if (options.frame >= total) {
      throw new FrameyardError(
        "FRAME_OUT_OF_RANGE",
        `Frame ${options.frame} is outside the valid range 0..${total - 1}.`,
      );
    }

    await inspectTranscriptClips({
      projectRoot: options.project.root,
      clips: session.transcriptClips,
      signal: options.signal,
    });

    throwIfAborted(options.signal);
    await session.seek(options.frame);
    const png = await session.capture();

    const tempPath = path.join(
      path.dirname(options.outPath),
      `.${path.basename(options.outPath)}.frameyard-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, png);
      await ensureOutputAvailable(options.outPath, overwrite);
      await publishFile(tempPath, options.outPath, overwrite);
    } finally {
      await rm(tempPath, { force: true });
    }

    return {
      composition: options.compositionId,
      frame: options.frame,
      path: options.outPath,
      width: session.metadata.width,
      height: session.metadata.height,
      elapsedMs: performance.now() - startedAt,
    };
  });
}

export async function renderComposition(
  options: SessionOptions & {
    outPath: string;
    overwrite?: boolean;
  },
): Promise<RenderResult> {
  if (path.extname(options.outPath).toLowerCase() !== ".mp4") {
    throw new FrameyardError("USAGE", `Render output must use an .mp4 extension: ${options.outPath}`);
  }

  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(options.outPath, overwrite);
  await assertFfmpegCapabilities(options.signal);
  const startedAt = performance.now();

  return withSession(options, async (session) => {
    const { width, height, fps, durationInFrames } = session.metadata;
    if (width % 2 !== 0 || height % 2 !== 0) {
      throw new FrameyardError(
        "RENDER_FAILED",
        `H.264 output requires even dimensions; the composition is ${width}×${height}.`,
      );
    }

    const durationSeconds = durationInFrames / fps;
    const total = durationInFrames;
    const audio = await inspectTimelineAudio({
      projectRoot: options.project.root,
      clips: session.audioClips,
      fps,
      durationInFrames,
      signal: options.signal,
    });
    const transcripts = await inspectTranscriptClips({
      projectRoot: options.project.root,
      clips: session.transcriptClips,
      signal: options.signal,
    });

    const scratchDir = await mkdtemp(path.join(tmpdir(), "frameyard-render-"));
    const tempOut = path.join(
      path.dirname(options.outPath),
      `.${path.basename(options.outPath)}.frameyard-${process.pid}-${randomUUID()}.mp4`,
    );

    let encoder: Awaited<ReturnType<typeof startVideoEncoder>> | undefined;
    let completed = false;

    try {
      let audioPath: string | undefined;
      if (audio.assets.length > 0) {
        audioPath = path.join(scratchDir, "audio.wav");
        await mixAudioTimeline({
          clips: audio.assets.map((asset) => ({
            path: asset.path,
            startFrame: asset.clip.startFrame,
            trimStart: asset.clip.trimStart,
            ...(asset.clip.trimDuration !== undefined ? { trimDuration: asset.clip.trimDuration } : {}),
            volume: asset.clip.volume,
          })),
          fps,
          durationSeconds,
          outputPath: audioPath,
          signal: options.signal,
        });
      }

      encoder = await startVideoEncoder({
        outputPath: tempOut,
        fps,
        frames: total,
        durationSeconds,
        ...(audioPath !== undefined ? { audioPath } : {}),
        signal: options.signal,
      });

      for (let frame = 0; frame < total; frame += 1) {
        throwIfAborted(options.signal);
        await session.seek(frame);
        const png = await session.capture();
        await encoder.writeFrame(png);
        reportProgress(options, frame + 1, total, startedAt);
      }

      await encoder.finish();
      encoder = undefined;

      if (!overwrite && (await pathExists(options.outPath))) {
        throw new FrameyardError(
          "OUTPUT_EXISTS",
          `Output already exists: ${options.outPath}. Pass --overwrite to replace it.`,
        );
      }
      await publishFile(tempOut, options.outPath, overwrite);
      completed = true;

      return {
        composition: options.compositionId,
        path: options.outPath,
        width,
        height,
        fps,
        durationInFrames,
        durationSeconds,
        framesRendered: total,
        bytes: (await stat(options.outPath)).size,
        audio: { clips: audio.clips.length, warnings: audio.warnings },
        transcripts: {
          clips: transcripts.clips.length,
          warnings: transcripts.warnings,
        },
        elapsedMs: performance.now() - startedAt,
      };
    } catch (error) {
      await encoder?.abort();
      throw error;
    } finally {
      if (!completed) {
        await rm(tempOut, { force: true });
      }
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
}
