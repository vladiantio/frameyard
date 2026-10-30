import { link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompositionDiagnostic, CompositionMetadata, CompositionSourceInfo } from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { validateHtmlComposition } from "../html/validate.js";
import type { Project, ProjectComposition } from "../project.js";
import { startPreviewServer } from "../server/server.js";
import { inspectTimelineAudio, type AudioInspection, type InspectAudioClip } from "./audio.js";
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
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  metadata: CompositionMetadata;
  framesChecked: number;
  audio: {
    clips: number;
    details: AudioInspection["clips"];
  };
  transcripts: {
    clips: number;
    details: TranscriptInspection["clips"];
  };
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface StillResult {
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  frame: number;
  path: string;
  width: number;
  height: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface RenderResult {
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  path: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
  framesRendered: number;
  concurrency: number;
  bytes: number;
  audio: {
    clips: number;
  };
  transcripts: {
    clips: number;
  };
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export const MAX_RENDER_CONCURRENCY = 16;

/** Validates the render concurrency flag and returns its normalized value. */
export function validateRenderConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new FrameyardError("USAGE", `--concurrency must be a positive integer; received ${String(value)}.`);
  }
  if (concurrency > MAX_RENDER_CONCURRENCY) {
    throw new FrameyardError(
      "USAGE",
      `--concurrency must be at most ${MAX_RENDER_CONCURRENCY}; received ${concurrency}.`,
    );
  }
  return concurrency;
}

function compositionFor(project: Project, id: string): ProjectComposition {
  const composition = project.compositions.get(id);
  if (!composition) {
    const available = [...project.compositions.keys()].join(", ") || "(none)";
    throw new FrameyardError(
      "COMPOSITION_NOT_FOUND",
      `Composition "${id}" is not listed in video.config.js. Available: ${available}.`,
    );
  }
  return composition;
}

function timelineAudioClips(session: CompositionSession): InspectAudioClip[] {
  return [...session.audioClips, ...session.embeddedAudioClips.map((clip) => ({ ...clip, allowSilent: true }))];
}

function audioDiagnostics(warnings: readonly string[]): CompositionDiagnostic[] {
  return warnings.map((message) => ({ severity: "warning", code: "AUDIO_WARNING", message }));
}

function transcriptDiagnostics(warnings: readonly string[]): CompositionDiagnostic[] {
  return warnings.map((message) => ({ severity: "warning", code: "TRANSCRIPT_WARNING", message }));
}

function diagnosticKey(diagnostic: CompositionDiagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
}

function mergeDiagnostics(...groups: CompositionDiagnostic[][]): CompositionDiagnostic[] {
  const seen = new Set<string>();
  const result: CompositionDiagnostic[] = [];
  for (const group of groups) {
    for (const diagnostic of group) {
      const key = diagnosticKey(diagnostic);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(diagnostic);
      }
    }
  }
  return result;
}

async function readSessionDiagnostics(sessions: readonly CompositionSession[]): Promise<CompositionDiagnostic[]> {
  const groups = await Promise.all(sessions.map((session) => session.readDiagnostics()));
  return mergeDiagnostics(...groups);
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
    throw new FrameyardError("OUTPUT_EXISTS", `Output already exists: ${outPath}. Pass --overwrite to replace it.`);
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
      throw new FrameyardError("OUTPUT_EXISTS", `Output already exists: ${outPath}. Pass --overwrite to replace it.`);
    }
    throw new FrameyardError("RENDER_FAILED", `Could not publish output ${outPath}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function withSessions<T>(
  options: SessionOptions,
  resolveSessionCount: (first: CompositionSession) => number,
  callback: (sessions: CompositionSession[]) => Promise<T>,
): Promise<T> {
  throwIfAborted(options.signal);
  const composition = compositionFor(options.project, options.compositionId);
  const validation = await validateHtmlComposition({
    projectRoot: options.project.root,
    entry: composition.entry,
    props: options.props,
  });
  const staticDiagnostics = validation.diagnostics;
  const staticErrors = staticDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!validation.info || staticErrors.length > 0) {
    const first = staticErrors[0];
    throw new FrameyardError(
      first?.code ?? "COMPOSITION_INVALID",
      `Composition "${options.compositionId}": ${first?.message ?? "static validation failed."}`,
      { diagnostics: validation.diagnostics },
    );
  }
  const staticInfo: CompositionSourceInfo = validation.info;

  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  const sessions: CompositionSession[] = [];

  try {
    try {
      const open = async (): Promise<void> => {
        throwIfAborted(options.signal);
        sessions.push(
          await openCompositionSession({
            serverUrl: server.url,
            entry: composition.entry,
            props: options.props,
            info: staticInfo,
            staticDiagnostics,
          }),
        );
      };

      await open();
      const sessionCount = Math.max(1, resolveSessionCount(sessions[0] as CompositionSession));
      for (let index = sessions.length; index < sessionCount; index += 1) {
        await open();
      }

      return await callback(sessions);
    } catch (error) {
      if (isFrameyardError(error)) {
        const runtimeDiagnostics = sessions.length > 0 ? await readSessionDiagnostics(sessions).catch(() => []) : [];
        throw new FrameyardError(error.code, `Composition "${options.compositionId}": ${error.message}`, {
          cause: error,
          details: error.details,
          diagnostics: error.diagnostics ?? (runtimeDiagnostics.length > 0 ? runtimeDiagnostics : undefined),
        });
      }
      throw error;
    }
  } finally {
    for (const session of sessions) {
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

async function withSession<T>(
  options: SessionOptions,
  callback: (session: CompositionSession) => Promise<T>,
): Promise<T> {
  return withSessions(
    options,
    () => 1,
    async (sessions) => callback(sessions[0] as CompositionSession),
  );
}

function reportProgress(options: SessionOptions, frame: number, total: number, startedAt: number): void {
  options.onProgress?.({ frame, total, elapsedMs: performance.now() - startedAt });
}

async function captureFramesInOrder(options: {
  sessions: CompositionSession[];
  total: number;
  signal?: AbortSignal;
  startedAt: number;
  writeFrame: (png: Buffer) => Promise<void>;
  onProgress?: (event: ProgressEvent) => void;
}): Promise<void> {
  const buffered = new Map<number, Buffer>();
  const waiters: Array<() => void> = [];
  const windowSize = Math.max(options.sessions.length * 2, 2);
  let nextFrame = 0;
  let nextWrite = 0;
  let failure: { error: unknown } | undefined;

  const notify = (): void => {
    for (const wake of waiters.splice(0)) {
      wake();
    }
  };

  const fail = (error: unknown): void => {
    failure ??= { error };
    notify();
  };

  const onAbort = (): void => fail(new FrameyardError("RENDER_FAILED", "Operation cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const waitForChange = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));

  const take = async (frame: number): Promise<Buffer> => {
    while (!buffered.has(frame)) {
      if (failure) {
        throw failure.error;
      }
      await waitForChange();
    }
    const png = buffered.get(frame) as Buffer;
    buffered.delete(frame);
    return png;
  };

  const captureWorker = async (session: CompositionSession): Promise<void> => {
    while (!failure) {
      throwIfAborted(options.signal);
      const frame = nextFrame;
      if (frame >= options.total) {
        return;
      }
      if (frame >= nextWrite + windowSize) {
        await waitForChange();
        continue;
      }

      nextFrame = frame + 1;
      await session.seek(frame);
      const png = await session.capture();
      buffered.set(frame, png);
      notify();
    }
  };

  const writeFrames = async (): Promise<void> => {
    for (let frame = 0; frame < options.total; frame += 1) {
      throwIfAborted(options.signal);
      const png = await take(frame);
      await options.writeFrame(png);
      nextWrite = frame + 1;
      options.onProgress?.({
        frame: nextWrite,
        total: options.total,
        elapsedMs: performance.now() - options.startedAt,
      });
      notify();
    }
  };

  const guard = async (task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      fail(error);
    }
  };

  try {
    await Promise.all([guard(writeFrames), ...options.sessions.map((session) => guard(() => captureWorker(session)))]);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (failure && (nextWrite < options.total || !options.signal?.aborted)) {
    throw failure.error;
  }
}

export async function checkComposition(options: SessionOptions): Promise<CheckResult> {
  const startedAt = performance.now();
  return withSession(options, async (session) => {
    const total = session.metadata.durationInFrames;
    const audio = await inspectTimelineAudio({
      projectRoot: options.project.root,
      clips: timelineAudioClips(session),
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

    const diagnostics = mergeDiagnostics(
      await session.readDiagnostics(),
      audioDiagnostics(audio.warnings),
      transcriptDiagnostics(transcripts.warnings),
    );

    return {
      composition: options.compositionId,
      entry: session.entry,
      controller: session.controller,
      metadata: session.metadata,
      framesChecked: total,
      audio: { clips: audio.clips.length, details: audio.clips },
      transcripts: {
        clips: transcripts.clips.length,
        details: transcripts.clips,
      },
      diagnostics,
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
    throw new FrameyardError(
      "FRAME_OUT_OF_RANGE",
      `--frame must be a non-negative integer; received ${options.frame}.`,
    );
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

    const transcripts = await inspectTranscriptClips({
      projectRoot: options.project.root,
      clips: session.transcriptClips,
      signal: options.signal,
    });

    throwIfAborted(options.signal);
    await session.seek(options.frame);
    const png = await session.capture();
    const diagnostics = mergeDiagnostics(await session.readDiagnostics(), transcriptDiagnostics(transcripts.warnings));

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
      entry: session.entry,
      controller: session.controller,
      frame: options.frame,
      path: options.outPath,
      width: session.metadata.width,
      height: session.metadata.height,
      diagnostics,
      elapsedMs: performance.now() - startedAt,
    };
  });
}

export async function renderComposition(
  options: SessionOptions & {
    outPath: string;
    overwrite?: boolean;
    concurrency?: number;
  },
): Promise<RenderResult> {
  if (path.extname(options.outPath).toLowerCase() !== ".mp4") {
    throw new FrameyardError("USAGE", `Render output must use an .mp4 extension: ${options.outPath}`);
  }

  const requestedConcurrency = validateRenderConcurrency(options.concurrency);
  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(options.outPath, overwrite);
  await assertFfmpegCapabilities(options.signal);
  const startedAt = performance.now();

  return withSessions(
    options,
    (first) => Math.min(requestedConcurrency, first.metadata.durationInFrames),
    async (sessions) => {
      const session = sessions[0] as CompositionSession;
      const { width, height, fps, durationInFrames } = session.metadata;
      const concurrency = sessions.length;
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
        clips: timelineAudioClips(session),
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
        const activeEncoder = encoder;

        if (concurrency === 1) {
          for (let frame = 0; frame < total; frame += 1) {
            throwIfAborted(options.signal);
            await session.seek(frame);
            const png = await session.capture();
            await activeEncoder.writeFrame(png);
            reportProgress(options, frame + 1, total, startedAt);
          }
        } else {
          await captureFramesInOrder({
            sessions,
            total,
            signal: options.signal,
            startedAt,
            writeFrame: (png) => activeEncoder.writeFrame(png),
            ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
          });
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

        const diagnostics = mergeDiagnostics(
          await readSessionDiagnostics(sessions),
          audioDiagnostics(audio.warnings),
          transcriptDiagnostics(transcripts.warnings),
        );

        return {
          composition: options.compositionId,
          entry: session.entry,
          controller: session.controller,
          path: options.outPath,
          width,
          height,
          fps,
          durationInFrames,
          durationSeconds,
          framesRendered: total,
          concurrency,
          bytes: (await stat(options.outPath)).size,
          audio: { clips: audio.clips.length },
          transcripts: {
            clips: transcripts.clips.length,
          },
          diagnostics,
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
    },
  );
}
