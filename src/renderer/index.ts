import { link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPOSITION_FORMAT_UNRESOLVED_MESSAGE } from "../composition/index.js";
import {
  isPlainObject,
  type CompositionDiagnostic,
  type CompositionMetadata,
  type CompositionSourceInfo,
  type StaticCompositionMetadata,
} from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { validateHtmlComposition } from "../html/validate.js";
import type { Project, ProjectComposition } from "../project.js";
import { startPreviewServer } from "../server/server.js";
import { audioClipsForFrameRange, inspectTimelineAudio, type AudioInspection, type InspectAudioClip } from "./audio.js";
import { openCompositionSession, type CompositionSession } from "./browser.js";
import {
  assertContainerCodec,
  assertFfmpegCapabilities,
  CONTAINER_EXTENSION,
  defaultCodecForContainer,
  mixAudioTimeline,
  resolveVideoEncoder,
  startVideoEncoder,
  type VideoCodec,
  type VideoContainer,
  type VideoEncoderChoice,
  type VideoEncoderName,
} from "./ffmpeg.js";
import { scaledVideoDimensions, validateRenderScale } from "./scale.js";
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

export interface AnimatedCheckResult {
  kind: "animated";
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

export interface StaticCheckResult {
  kind: "static";
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  metadata: StaticCompositionMetadata;
  framesChecked: 1;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export type CheckResult = AnimatedCheckResult | StaticCheckResult;

export interface StillFrameResult {
  frame: number;
  path: string;
}

export interface StillResult {
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  /** Present only when exactly one frame was captured. */
  frame?: number;
  /** Present only when exactly one frame was captured. */
  path?: string;
  frames: StillFrameResult[];
  width: number;
  height: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface VideoRenderResult {
  kind: "video";
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  path: string;
  width: number;
  height: number;
  /** Inclusive rendered frame range. */
  frameRange: { start: number; end: number };
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
  framesRendered: number;
  concurrency: number;
  scale: number;
  /** Resolved delivery codec. */
  codec: VideoCodec;
  /** Resolved delivery container. */
  container: VideoContainer;
  /** Resolved encoder used for the output. */
  encoder: VideoEncoderName;
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

export interface ImageRenderResult {
  kind: "image";
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  path: string;
  width: number;
  height: number;
  bytes: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export type RenderResult = VideoRenderResult | ImageRenderResult;

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
      `Composition "${id}" is not listed in fy.config.js. Available: ${available}.`,
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

function withBatchContext(error: unknown, frames: readonly number[], failedFrame: number): unknown {
  if (!isFrameyardError(error)) {
    return error;
  }
  const details =
    error.details === undefined
      ? {}
      : isPlainObject(error.details)
        ? { ...error.details }
        : { originalDetails: error.details };
  return new FrameyardError(error.code, error.message, {
    cause: error,
    details: { ...details, frames: [...frames], failedFrame },
    diagnostics: error.diagnostics,
  });
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

async function assertOutputsAvailable(outPaths: readonly string[], overwrite: boolean): Promise<void> {
  if (overwrite) {
    return;
  }

  const conflicts: string[] = [];
  for (const outPath of outPaths) {
    if (await pathExists(outPath)) {
      conflicts.push(outPath);
    }
  }
  if (conflicts.length === 0) {
    return;
  }

  const first = conflicts[0] as string;
  const message =
    conflicts.length === 1
      ? `Output already exists: ${first}. Pass --overwrite to replace it.`
      : `Output already exists: ${first} (and ${conflicts.length - 1} more). Pass --overwrite to replace them.`;
  throw new FrameyardError("OUTPUT_EXISTS", message, { details: { conflicts } });
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

interface PreparedComposition {
  composition: ProjectComposition;
  staticInfo: CompositionSourceInfo;
  staticDiagnostics: CompositionDiagnostic[];
}

async function prepareComposition(options: SessionOptions): Promise<PreparedComposition> {
  throwIfAborted(options.signal);
  const composition = compositionFor(options.project, options.compositionId);
  const validation = await validateHtmlComposition({
    projectRoot: options.project.root,
    entry: composition.entry,
    props: options.props,
    ...(options.project.format ? { format: options.project.format } : {}),
  });
  const staticDiagnostics = validation.diagnostics;
  const staticErrors = staticDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!validation.info || staticErrors.length > 0) {
    const first = staticErrors[0];
    if (!first && validation.formatUnresolved) {
      throw new FrameyardError(
        "COMPOSITION_FORMAT_UNRESOLVED",
        `Composition "${options.compositionId}": ${COMPOSITION_FORMAT_UNRESOLVED_MESSAGE}`,
        { diagnostics: validation.diagnostics },
      );
    }
    throw new FrameyardError(
      first?.code ?? "COMPOSITION_INVALID",
      `Composition "${options.compositionId}": ${first?.message ?? "static validation failed."}`,
      {
        ...(first?.details !== undefined ? { details: first.details } : {}),
        ...(first?.fix !== undefined ? { fix: first.fix } : {}),
        diagnostics: validation.diagnostics,
      },
    );
  }
  return { composition, staticInfo: validation.info, staticDiagnostics };
}

async function withPreparedSessions<T>(
  options: SessionOptions,
  prepared: PreparedComposition,
  resolveSessionCount: (first: CompositionSession) => number,
  callback: (sessions: CompositionSession[]) => Promise<T>,
): Promise<T> {
  const { composition, staticInfo, staticDiagnostics } = prepared;
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  const sessions: CompositionSession[] = [];

  try {
    try {
      const open = async (): Promise<CompositionSession> => {
        throwIfAborted(options.signal);
        return openCompositionSession({
          serverUrl: server.url,
          entry: composition.entry,
          props: options.props,
          info: staticInfo,
          staticDiagnostics,
        });
      };

      sessions.push(await open());
      const sessionCount = Math.max(1, resolveSessionCount(sessions[0] as CompositionSession));
      if (sessionCount > 1) {
        // Browser startup dominates short parallel renders, so open the
        // remaining sessions together instead of paying for each in sequence.
        const additional = await Promise.allSettled(Array.from({ length: sessionCount - 1 }, () => open()));
        for (const result of additional) {
          if (result.status === "fulfilled") {
            sessions.push(result.value);
          }
        }
        const failed = additional.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) {
          throw failed.reason;
        }
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
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.close();
        } catch {
          // Preserve the command's original error.
        }
      }),
    );
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

async function captureFramesInOrder(options: {
  sessions: CompositionSession[];
  /** Absolute first composition frame; output frame zero maps to this frame. */
  startFrame?: number;
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
      await session.seek((options.startFrame ?? 0) + frame);
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
  const prepared = await prepareComposition(options);
  return withPreparedSessions(
    options,
    prepared,
    () => 1,
    async (sessions) => {
      const session = sessions[0] as CompositionSession;
      const metadata = session.metadata;

      if (metadata.static === true) {
        throwIfAborted(options.signal);
        await session.seek(0);
        reportProgress(options, 1, 1, startedAt);
        const diagnostics = mergeDiagnostics(prepared.staticDiagnostics, await session.readDiagnostics());
        return {
          kind: "static",
          composition: options.compositionId,
          entry: session.entry,
          controller: session.controller,
          metadata,
          framesChecked: 1,
          diagnostics,
          elapsedMs: performance.now() - startedAt,
        };
      }

      const total = metadata.durationInFrames;
      const audio = await inspectTimelineAudio({
        projectRoot: options.project.root,
        clips: timelineAudioClips(session),
        fps: metadata.fps,
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
        kind: "animated",
        composition: options.compositionId,
        entry: session.entry,
        controller: session.controller,
        metadata,
        framesChecked: total,
        audio: { clips: audio.clips.length, details: audio.clips },
        transcripts: {
          clips: transcripts.clips.length,
          details: transcripts.clips,
        },
        diagnostics,
        elapsedMs: performance.now() - startedAt,
      };
    },
  );
}

export async function captureStills(
  options: SessionOptions & {
    frames: number[];
    outPaths: string[];
    overwrite?: boolean;
  },
): Promise<StillResult> {
  if (options.frames.length === 0) {
    throw new FrameyardError("USAGE", "Still capture requires at least one frame.");
  }
  if (options.frames.length !== options.outPaths.length) {
    throw new FrameyardError("USAGE", "Still frames and output paths must have the same length.");
  }
  for (const frame of options.frames) {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new FrameyardError("FRAME_OUT_OF_RANGE", `--frame must be a non-negative integer; received ${frame}.`);
    }
  }
  if (new Set(options.frames).size !== options.frames.length) {
    throw new FrameyardError("USAGE", "Still frames must be unique.");
  }
  if (new Set(options.outPaths).size !== options.outPaths.length) {
    throw new FrameyardError("USAGE", "Still output paths must be unique.");
  }
  for (const outPath of options.outPaths) {
    if (path.extname(outPath).toLowerCase() !== ".png") {
      throw new FrameyardError("USAGE", `Still output must use a .png extension: ${outPath}`);
    }
  }

  const overwrite = options.overwrite ?? false;
  const startedAt = performance.now();
  const prepared = await prepareComposition(options);
  const metadata = prepared.staticInfo.metadata;
  const total = metadata.static === true ? 1 : metadata.durationInFrames;
  const invalidFrames = options.frames.filter((frame) => frame >= total);
  if (invalidFrames.length > 0) {
    const first = invalidFrames[0] as number;
    throw new FrameyardError("FRAME_OUT_OF_RANGE", `Frame ${first} is outside the valid range 0..${total - 1}.`, {
      details: { invalidFrames, validRange: { min: 0, max: total - 1 } },
    });
  }
  await assertOutputsAvailable(options.outPaths, overwrite);
  for (const outPath of options.outPaths) {
    await mkdir(path.dirname(outPath), { recursive: true });
  }

  return withPreparedSessions(
    options,
    prepared,
    () => 1,
    async (sessions) => {
      const session = sessions[0] as CompositionSession;
      const transcripts = await inspectTranscriptClips({
        projectRoot: options.project.root,
        clips: session.transcriptClips,
        signal: options.signal,
      });

      const tempPaths = options.outPaths.map((outPath) =>
        path.join(path.dirname(outPath), `.${path.basename(outPath)}.frameyard-${process.pid}-${randomUUID()}.tmp`),
      );

      try {
        for (const [index, frame] of options.frames.entries()) {
          throwIfAborted(options.signal);
          try {
            await session.seek(frame);
            const png = await session.capture();
            await writeFile(tempPaths[index] as string, png);
          } catch (error) {
            throw withBatchContext(error, options.frames, frame);
          }
        }

        await assertOutputsAvailable(options.outPaths, overwrite);
        const diagnostics = mergeDiagnostics(
          metadata.static === true ? prepared.staticDiagnostics : [],
          await session.readDiagnostics(),
          transcriptDiagnostics(transcripts.warnings),
        );

        for (const [index, outPath] of options.outPaths.entries()) {
          await publishFile(tempPaths[index] as string, outPath, overwrite);
        }

        const frames = options.frames.map((frame, index) => ({
          frame,
          path: options.outPaths[index] as string,
        }));
        const first = frames[0];
        return {
          composition: options.compositionId,
          entry: session.entry,
          controller: session.controller,
          ...(frames.length === 1 && first !== undefined ? { frame: first.frame, path: first.path } : {}),
          frames,
          width: session.metadata.width,
          height: session.metadata.height,
          diagnostics,
          elapsedMs: performance.now() - startedAt,
        };
      } finally {
        await Promise.all(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
      }
    },
  );
}

export async function captureStill(
  options: SessionOptions & {
    frame: number;
    outPath: string;
    overwrite?: boolean;
  },
): Promise<StillResult> {
  const { frame, outPath, ...rest } = options;
  return captureStills({
    ...rest,
    frames: [frame],
    outPaths: [outPath],
  });
}

async function renderStaticComposition(
  options: SessionOptions & {
    outPath?: string;
    overwrite?: boolean;
    concurrency?: number;
    encoder?: VideoEncoderChoice;
    codec?: VideoCodec;
    container?: VideoContainer;
  },
  prepared: PreparedComposition,
  startedAt: number,
): Promise<ImageRenderResult> {
  if (
    options.container !== undefined ||
    options.codec !== undefined ||
    options.encoder !== undefined ||
    options.concurrency !== undefined
  ) {
    throw new FrameyardError(
      "USAGE",
      "Static compositions render to PNG; --container, --codec, --encoder, and --concurrency are not valid.",
    );
  }

  const metadata = prepared.staticInfo.metadata;
  if (metadata.static !== true) {
    throw new FrameyardError("INTERNAL", "renderStaticComposition received an animated composition.");
  }

  const outPath = options.outPath ?? path.join(options.project.root, "out", `${options.compositionId}.png`);
  if (path.extname(outPath).toLowerCase() !== ".png") {
    throw new FrameyardError("USAGE", `Static compositions render to a .png file: ${outPath}`);
  }

  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(outPath, overwrite);

  return withPreparedSessions(
    options,
    prepared,
    () => 1,
    async (sessions) => {
      const session = sessions[0] as CompositionSession;
      const tempPath = path.join(
        path.dirname(outPath),
        `.${path.basename(outPath)}.frameyard-${process.pid}-${randomUUID()}.tmp`,
      );

      try {
        throwIfAborted(options.signal);
        await session.seek(0);
        const png = await session.capture();
        await writeFile(tempPath, png);
        await assertOutputsAvailable([outPath], overwrite);
        await publishFile(tempPath, outPath, overwrite);
        reportProgress(options, 1, 1, startedAt);

        const diagnostics = mergeDiagnostics(prepared.staticDiagnostics, await session.readDiagnostics());
        return {
          kind: "image",
          composition: options.compositionId,
          entry: session.entry,
          controller: session.controller,
          path: outPath,
          width: metadata.width,
          height: metadata.height,
          bytes: (await stat(outPath)).size,
          diagnostics,
          elapsedMs: performance.now() - startedAt,
        };
      } finally {
        await rm(tempPath, { force: true });
      }
    },
  );
}

export async function renderComposition(
  options: SessionOptions & {
    outPath?: string;
    overwrite?: boolean;
    concurrency?: number;
    /** Encoder choice; defaults to the codec's software encoder. */
    encoder?: VideoEncoderChoice;
    /** Delivery codec; defaults to `h264`. */
    codec?: VideoCodec;
    /** Delivery container; defaults to `mp4`. */
    container?: VideoContainer;
    /** Inclusive first composition frame; defaults to 0. */
    startFrame?: number;
    /** Exclusive last composition frame; defaults to durationInFrames. */
    endFrame?: number;
    /** Encode-time scale factor; defaults to 1. */
    scale?: number;
  },
): Promise<RenderResult> {
  const startedAt = performance.now();
  const prepared = await prepareComposition(options);
  const scale = validateRenderScale(options.scale);
  if (prepared.staticInfo.metadata.static === true) {
    if (options.startFrame !== undefined || options.endFrame !== undefined) {
      throw new FrameyardError("USAGE", "--frames is only supported for animated video renders.");
    }
    if (scale !== 1) {
      throw new FrameyardError("USAGE", "--scale is only supported for animated video renders.");
    }
    return renderStaticComposition(options, prepared, startedAt);
  }

  const metadata = prepared.staticInfo.metadata;
  const startFrame = options.startFrame ?? 0;
  const endFrame = options.endFrame ?? metadata.durationInFrames;
  if (
    !Number.isInteger(startFrame) ||
    !Number.isInteger(endFrame) ||
    startFrame < 0 ||
    endFrame > metadata.durationInFrames ||
    endFrame <= startFrame
  ) {
    throw new FrameyardError(
      "FRAME_OUT_OF_RANGE",
      `Frame range ${startFrame}..${endFrame - 1} is outside 0..${metadata.durationInFrames - 1}.`,
      {
        details: { validRange: { min: 0, max: metadata.durationInFrames - 1 }, startFrame, endFrame },
      },
    );
  }
  const totalFrames = endFrame - startFrame;

  const container = options.container ?? "mp4";
  const codec = options.codec ?? defaultCodecForContainer(container);
  assertContainerCodec(container, codec);
  const extension = `.${CONTAINER_EXTENSION[container]}`;
  const outPath = options.outPath ?? path.join(options.project.root, "out", `${options.compositionId}${extension}`);
  if (path.extname(outPath).toLowerCase() !== extension) {
    throw new FrameyardError(
      "USAGE",
      `Render output for --container ${container} must use a ${extension} extension: ${outPath}`,
    );
  }

  const requestedConcurrency = validateRenderConcurrency(options.concurrency);
  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(outPath, overwrite);
  await assertFfmpegCapabilities(options.signal, codec);
  const encoderName = await resolveVideoEncoder(codec, options.encoder, options.signal);

  return withPreparedSessions(
    options,
    prepared,
    (first) => (first.metadata.static === true ? 1 : Math.min(requestedConcurrency, totalFrames)),
    async (sessions) => {
      const session = sessions[0] as CompositionSession;
      if (session.metadata.static === true) {
        throw new FrameyardError("INTERNAL", "An animated render opened a static composition session.");
      }
      const { width, height, fps } = session.metadata;
      const concurrency = sessions.length;
      const output = scaledVideoDimensions(width, height, scale);
      if (output.width % 2 !== 0 || output.height % 2 !== 0) {
        throw new FrameyardError(
          "RENDER_FAILED",
          `Video output requires even dimensions; the composition is ${output.width}×${output.height}.`,
        );
      }

      const durationSeconds = totalFrames / fps;
      const total = totalFrames;
      const audio = await inspectTimelineAudio({
        projectRoot: options.project.root,
        clips: timelineAudioClips(session),
        fps,
        durationInFrames: session.metadata.durationInFrames,
        signal: options.signal,
      });
      const audioClips = audioClipsForFrameRange(audio.assets, startFrame, endFrame, fps);
      const transcripts = await inspectTranscriptClips({
        projectRoot: options.project.root,
        clips: session.transcriptClips,
        signal: options.signal,
      });

      const scratchDir = await mkdtemp(path.join(tmpdir(), "frameyard-render-"));
      const tempOut = path.join(
        path.dirname(outPath),
        `.${path.basename(outPath)}.frameyard-${process.pid}-${randomUUID()}.mp4`,
      );

      let encoder: Awaited<ReturnType<typeof startVideoEncoder>> | undefined;
      let completed = false;

      try {
        let audioPath: string | undefined;
        if (audioClips.length > 0) {
          audioPath = path.join(scratchDir, "audio.wav");
          await mixAudioTimeline({
            clips: audioClips.map((clip) => ({
              path: path.resolve(options.project.root, clip.src),
              startFrame: clip.startFrame,
              trimStart: clip.trimStart,
              ...(clip.trimDuration !== undefined ? { trimDuration: clip.trimDuration } : {}),
              volume: clip.volume,
              ...(clip.envelopes !== undefined ? { volumeEnvelopes: clip.envelopes } : {}),
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
          encoder: encoderName,
          codec,
          container,
          scale,
          ...(audioPath !== undefined ? { audioPath } : {}),
          signal: options.signal,
        });
        const activeEncoder = encoder;

        if (concurrency === 1) {
          for (let frame = 0; frame < total; frame += 1) {
            throwIfAborted(options.signal);
            await session.seek(startFrame + frame);
            const png = await session.capture();
            await activeEncoder.writeFrame(png);
            reportProgress(options, frame + 1, total, startedAt);
          }
        } else {
          await captureFramesInOrder({
            sessions,
            startFrame,
            total,
            signal: options.signal,
            startedAt,
            writeFrame: (png) => activeEncoder.writeFrame(png),
            ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
          });
        }

        await encoder.finish();
        encoder = undefined;

        if (!overwrite && (await pathExists(outPath))) {
          throw new FrameyardError(
            "OUTPUT_EXISTS",
            `Output already exists: ${outPath}. Pass --overwrite to replace it.`,
          );
        }
        await publishFile(tempOut, outPath, overwrite);
        completed = true;

        const diagnostics = mergeDiagnostics(
          await readSessionDiagnostics(sessions),
          audioDiagnostics(audio.warnings),
          transcriptDiagnostics(transcripts.warnings),
        );

        return {
          kind: "video",
          composition: options.compositionId,
          entry: session.entry,
          controller: session.controller,
          path: outPath,
          width: output.width,
          height: output.height,
          frameRange: { start: startFrame, end: endFrame - 1 },
          fps,
          durationInFrames: total,
          durationSeconds,
          framesRendered: total,
          concurrency,
          scale,
          codec,
          container,
          encoder: encoderName,
          bytes: (await stat(outPath)).size,
          audio: { clips: audioClips.length },
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
