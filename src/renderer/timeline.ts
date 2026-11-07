import { link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isPlainObject,
  type AudioVolumeEnvelope,
  type CompositionDiagnostic,
  type CompositionSourceInfo,
  type ResolvedAudioClip,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { validateHtmlComposition, type StaticValidationResult } from "../html/validate.js";
import type { Project } from "../project.js";
import { startPreviewServer } from "../server/server.js";
import { inspectTimelineAudio, type AudioInspection, type InspectAudioClip } from "./audio.js";
import { openCompositionSession, type CompositionSession } from "./browser.js";
import {
  assertContainerCodec,
  assertFfmpegCapabilities,
  compositeTimelineFrame,
  compositeTimelineSegment,
  concatTimelineSegments,
  CONTAINER_EXTENSION,
  defaultCodecForContainer,
  encodeVideoSegmentDirect,
  ENCODER_SESSION_LIMIT,
  mixAudioTimeline,
  muxVideoWithAudio,
  resolveVideoEncoder,
  sceneLayerToCompositeLayer,
  startDirectSegmentEncoder,
  startDualPipeSegmentEncoder,
  startFfv1Encoder,
  type DualPipeEncoder,
  type TimelineCompositeLayer,
  type VideoCodec,
  type VideoContainer,
  type VideoEncoder,
  type VideoEncoderChoice,
  type VideoEncoderName,
} from "./ffmpeg.js";
import { createSemaphore, type Semaphore } from "./concurrency.js";
import { CompositionSessionPool, type SessionLease } from "./session-pool.js";
import { inspectTranscriptClips, type TranscriptInspection } from "./transcripts.js";
import { startTiming } from "./timings.js";
import { evaluatePresentation } from "../timeline/keyframes.js";
import { transitionProgress } from "../timeline/transitions.js";
import { KEYFRAME_CHANNELS } from "../timeline/schema.js";
import { planTimelineRender, type TimelineRenderSegment } from "../timeline/plan.js";
import { projectScene, transitionSpans } from "../timeline/scene.js";
import {
  resolveProjectTimeline,
  type ResolvedCompositionSource,
  type ResolvedTimeline,
  type ResolvedTimelineClip,
} from "../timeline/resolve.js";

export const MAX_TIMELINE_WORKERS = 16;

export interface TimelineProgressEvent {
  frame: number;
  total: number;
  elapsedMs: number;
  segment: number;
  segments: number;
}

export interface TimelineRenderOptions {
  project: Project;
  timelineId: string;
  outPath: string;
  overwrite?: boolean;
  workers?: number;
  maxSegmentFrames?: number;
  scratchDir?: string;
  signal?: AbortSignal;
  /** Render-time props overrides keyed by top-level composition clip ID. */
  propsOverrides?: Record<string, unknown>;
  /** Encoder choice for segments; defaults to the codec's software encoder. */
  encoder?: VideoEncoderChoice;
  /** Delivery codec; defaults to `h264`. */
  codec?: VideoCodec;
  /** Delivery container; defaults to `mp4`. */
  container?: VideoContainer;
  onProgress?: (event: TimelineProgressEvent) => void;
}

export interface TimelineStillOptions {
  project: Project;
  timelineId: string;
  frame: number;
  outPath: string;
  overwrite?: boolean;
  propsOverrides?: Record<string, unknown>;
  scratchDir?: string;
  signal?: AbortSignal;
}

export interface TimelineStillFrameResult {
  frame: number;
  path: string;
}

export interface TimelineStillResult {
  timeline: string;
  entry: string;
  /** Present only when exactly one frame was captured. */
  frame?: number;
  /** Present only when exactly one frame was captured. */
  path?: string;
  frames: TimelineStillFrameResult[];
  width: number;
  height: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface TimelineStillsOptions {
  project: Project;
  timelineId: string;
  frames: number[];
  outPaths: string[];
  overwrite?: boolean;
  propsOverrides?: Record<string, unknown>;
  scratchDir?: string;
  signal?: AbortSignal;
}

export interface TimelineCheckResult {
  timeline: string;
  entry: string;
  format: { width: number; height: number; fps: number };
  durationInFrames: number;
  framesChecked: number;
  tracks: number;
  clips: number;
  transitions: number;
  audio: { clips: number; details: AudioInspection["clips"] };
  transcripts: { clips: number; details: TranscriptInspection["clips"] };
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface TimelineRenderResult {
  timeline: string;
  entry: string;
  path: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
  framesRendered: number;
  segments: number;
  workers: number;
  transitions: number;
  /** Resolved delivery codec. */
  codec: VideoCodec;
  /** Resolved delivery container. */
  container: VideoContainer;
  /** Resolved encoder used for segment encoding. */
  encoder: VideoEncoderName;
  bytes: number;
  audio: { clips: number };
  transcripts: { clips: number };
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

function validateWorkers(value: number | undefined): number {
  const workers = value ?? 8;
  if (!Number.isInteger(workers) || workers < 1) {
    throw new FrameyardError("USAGE", `--workers must be a positive integer; received ${String(value)}.`);
  }
  if (workers > MAX_TIMELINE_WORKERS) {
    throw new FrameyardError("USAGE", `--workers must be at most ${MAX_TIMELINE_WORKERS}; received ${workers}.`);
  }
  return workers;
}

/**
 * Caps workers at the encoder's concurrent-session limit. Consumer NVIDIA
 * drivers allow eight NVENC sessions, and each worker opens one encoder.
 */
export function clampTimelineWorkers(workers: number, encoder: VideoEncoderName): number {
  return Math.min(workers, ENCODER_SESSION_LIMIT[encoder]);
}

const MAX_CAPTURE_CONCURRENCY = 12;

/**
 * Capture sessions are bounded independently from segment workers. A segment
 * with two or three layers can overlap its captures without letting an
 * eight-worker render open sixteen browsers.
 */
function captureConcurrency(workers: number): number {
  const raw = process.env.FRAMEYARD_CAPTURE_CONCURRENCY;
  if (raw !== undefined) {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) {
      return Math.min(value, 32);
    }
  }
  return Math.min(workers * 2, MAX_CAPTURE_CONCURRENCY);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FrameyardError("RENDER_FAILED", "Operation cancelled.");
  }
}

async function withCaptureSlot<T>(
  limiter: Semaphore | undefined,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!limiter) {
    throwIfAborted(signal);
    return task();
  }
  throwIfAborted(signal);
  const release = await limiter.acquire();
  try {
    throwIfAborted(signal);
    return await task();
  } finally {
    release();
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FrameyardError("OUTPUT_EXISTS", `Output already exists: ${outPath}. Pass --overwrite to replace it.`);
    }
    throw new FrameyardError("RENDER_FAILED", `Could not publish output ${outPath}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    await rm(tempPath, { force: true });
  }
}

function diagnosticKey(diagnostic: CompositionDiagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
}

function mergeDiagnostics(...groups: readonly CompositionDiagnostic[][]): CompositionDiagnostic[] {
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

function compositionDiagnostic(
  diagnostic: CompositionDiagnostic,
  timelineId: string,
  clip: ResolvedTimelineClip,
  compositionId: string,
): CompositionDiagnostic {
  return {
    ...diagnostic,
    details: {
      ...diagnostic.details,
      timeline: timelineId,
      clip: clip.id,
      track: clip.track,
      composition: compositionId,
    },
  };
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface AudioWindow {
  frameOffset: number;
  startFrame: number;
  endFrame: number;
  gain: number;
  muted: boolean;
  /** Gain ramps inherited from enclosing timeline clips, in absolute frames. */
  envelopes: AudioVolumeEnvelope[];
}

function mapCompositionAudio(
  clip: ResolvedTimelineClip,
  audio: ResolvedAudioClip,
  fps: number,
  window: AudioWindow,
): InspectAudioClip | null {
  if (window.muted) {
    return null;
  }

  const clipOuterStart = clip.start + window.frameOffset;
  const clipOuterEnd = clip.end + window.frameOffset;
  const windowStart = Math.max(window.startFrame, clipOuterStart);
  const windowEnd = Math.min(window.endFrame, clipOuterEnd);
  if (windowEnd <= windowStart) {
    return null;
  }

  const sourceAtWindowStart = clip.sourceIn + (windowStart - clipOuterStart);
  const sourceAtWindowEnd = clip.sourceIn + (windowEnd - clipOuterStart);
  const audioDurationFrames = audio.trimDuration !== undefined ? audio.trimDuration * fps : Number.POSITIVE_INFINITY;
  const effectiveStart = Math.max(audio.startFrame, sourceAtWindowStart, clip.sourceIn);
  const effectiveEnd = Math.min(
    sourceAtWindowEnd,
    clip.sourceIn + clip.duration,
    audio.startFrame + audioDurationFrames,
  );
  if (effectiveEnd <= effectiveStart) {
    return null;
  }

  const duration = (effectiveEnd - effectiveStart) / fps;
  if (duration <= 0) {
    return null;
  }

  return {
    src: audio.src,
    startFrame: clip.start + (effectiveStart - clip.sourceIn) + window.frameOffset,
    trimStart: audio.trimStart + (effectiveStart - audio.startFrame) / fps,
    trimDuration: duration,
    volume: clampVolume(audio.volume * window.gain),
    ...(window.envelopes.length > 0 ? { envelopes: window.envelopes } : {}),
    // Without an explicit duration the source ends naturally; any remaining
    // mapped window is silence, not an overrun.
    ...(audio.trimDuration === undefined ? { allowShortSource: true } : {}),
  };
}

function collectTimelineAudio(
  timeline: ResolvedTimeline,
  window: AudioWindow,
  clips: InspectAudioClip[],
  transcripts: Map<string, ResolvedTranscriptClip>,
): void {
  const fps = timeline.format.fps;
  const trackById = new Map(timeline.tracks.map((track) => [track.id, track]));
  const spansByClip = transitionSpans(timeline);

  for (const clip of timeline.clips) {
    const source = clip.source;
    const mappedStart = clip.start + window.frameOffset;
    const mappedEnd = clip.end + window.frameOffset;
    const startFrame = Math.max(mappedStart, window.startFrame);
    const endFrame = Math.min(mappedEnd, window.endFrame);
    if (endFrame <= startFrame) {
      continue;
    }

    const clipGain = window.gain * (clip.audio?.gain ?? 1);
    const clipMuted = window.muted || (clip.audio?.muted ?? false);
    const ownEnvelopes: AudioVolumeEnvelope[] = (spansByClip.get(clip.id) ?? []).map((span) => ({
      startFrame: span.start + window.frameOffset,
      endFrame: span.end + window.frameOffset,
      ...(span.easing !== undefined ? { easing: span.easing } : {}),
      role: span.role,
    }));
    const envelopes = ownEnvelopes.length > 0 ? [...window.envelopes, ...ownEnvelopes] : window.envelopes;

    if (source.kind === "composition") {
      for (const transcript of source.transcriptClips) {
        transcripts.set(`${transcript.src}\u0000${transcript.words}`, transcript);
      }
      if (clipMuted) {
        continue;
      }
      for (const audio of source.audioClips) {
        const mapped = mapCompositionAudio(clip, audio, fps, { ...window, gain: clipGain, envelopes });
        if (mapped) {
          clips.push(mapped);
        }
      }
      for (const audio of source.embeddedAudioClips) {
        const mapped = mapCompositionAudio(clip, audio, fps, { ...window, gain: clipGain, envelopes });
        if (mapped) {
          clips.push({ ...mapped, allowSilent: true });
        }
      }
      continue;
    }

    if (source.kind === "timeline") {
      collectTimelineAudio(
        source.timeline,
        {
          frameOffset: window.frameOffset + clip.start - clip.sourceIn,
          startFrame,
          endFrame,
          gain: clipGain,
          muted: clipMuted,
          envelopes,
        },
        clips,
        transcripts,
      );
      continue;
    }

    if (source.kind === "video") {
      if (source.hasAudio && !clipMuted) {
        clips.push({
          src: source.src,
          startFrame,
          trimStart: clip.sourceIn / fps + (startFrame - mappedStart) / fps,
          trimDuration: (endFrame - startFrame) / fps,
          volume: clampVolume(clipGain),
          ...(envelopes.length > 0 ? { envelopes } : {}),
        });
      }
      continue;
    }

    if (source.kind === "audio") {
      const track = trackById.get(clip.track);
      if (!track || track.kind !== "audio" || track.muted || clipMuted) {
        continue;
      }
      clips.push({
        src: source.src,
        startFrame,
        trimStart: clip.sourceIn / fps + (startFrame - mappedStart) / fps,
        trimDuration: (endFrame - startFrame) / fps,
        volume: clampVolume(clipGain * (track.gain ?? 1)),
        ...(envelopes.length > 0 ? { envelopes } : {}),
      });
    }
  }
}

function buildAudioClips(timeline: ResolvedTimeline): {
  clips: InspectAudioClip[];
  transcripts: ResolvedTranscriptClip[];
} {
  const clips: InspectAudioClip[] = [];
  const transcripts = new Map<string, ResolvedTranscriptClip>();
  collectTimelineAudio(
    timeline,
    { frameOffset: 0, startFrame: 0, endFrame: timeline.durationInFrames, gain: 1, muted: false, envelopes: [] },
    clips,
    transcripts,
  );
  return { clips, transcripts: [...transcripts.values()] };
}

/** Resolved timeline audio for preview surfaces. */
export function resolveTimelineAudio(timeline: ResolvedTimeline): {
  clips: ResolvedAudioClip[];
  transcripts: ResolvedTranscriptClip[];
} {
  const { clips, transcripts } = buildAudioClips(timeline);
  return {
    clips: clips.map((clip) => {
      const { allowSilent: _allowSilent, allowShortSource: _allowShortSource, ...resolved } = clip;
      return resolved;
    }),
    transcripts,
  };
}

interface StaticCapture {
  path: string;
  diagnostics: CompositionDiagnostic[];
}

async function captureStaticCompositionLayer(options: {
  project: Project;
  timeline: ResolvedTimeline;
  clip: ResolvedTimelineClip;
  source: ResolvedCompositionSource;
  serverUrl: string;
  scratchRoot: string;
  infoCache: Map<string, StaticValidationResult>;
  staticCache: Map<string, Promise<StaticCapture>>;
  signal?: AbortSignal;
}): Promise<StaticCapture> {
  const { project, timeline, clip, source, serverUrl, scratchRoot, infoCache, staticCache } = options;
  const propsKey = JSON.stringify(clip.props ?? null);
  const cacheKey = `${source.entry}\u0000${propsKey}`;
  const cached = staticCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<StaticCapture> => {
    let validation = infoCache.get(cacheKey);
    if (!validation) {
      validation = await validateHtmlComposition({
        projectRoot: project.root,
        entry: source.entry,
        ...(clip.props !== undefined ? { props: clip.props } : {}),
        ...(project.format ? { format: project.format } : {}),
      });
      infoCache.set(cacheKey, validation);
    }
    if (!validation.info) {
      throw new FrameyardError(
        "TIMELINE_CLIP_INVALID",
        `Composition "${source.id}" could not be loaded for clip "${clip.id}".`,
        { diagnostics: validation.diagnostics },
      );
    }

    const session = await openCompositionSession({
      serverUrl,
      entry: source.entry,
      props: clip.props,
      info: validation.info,
      staticDiagnostics: validation.diagnostics,
      transparentBackground: true,
    });
    try {
      throwIfAborted(options.signal);
      await session.seek(0);
      const png = await session.capture();
      const filePath = path.join(scratchRoot, `static-${randomUUID()}.png`);
      await writeFile(filePath, png);
      const diagnostics = (await session.readDiagnostics()).map((diagnostic) =>
        compositionDiagnostic(diagnostic, timeline.id, clip, source.id),
      );
      return { path: filePath, diagnostics };
    } finally {
      await session.close();
    }
  })();

  staticCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    staticCache.delete(cacheKey);
    throw error;
  }
}

interface CompositionFrameCaptureOptions {
  project: Project;
  timeline: ResolvedTimeline;
  clip: ResolvedTimelineClip;
  source: ResolvedCompositionSource;
  segment: TimelineRenderSegment;
  layerIndex: number;
  serverUrl: string;
  infoCache: Map<string, StaticValidationResult>;
  sessionPool?: CompositionSessionPool;
  signal?: AbortSignal;
}

/**
 * Opens a composition session, captures every frame of the segment, and hands
 * each PNG to `writeFrame`. The caller owns the encoder lifecycle so the same
 * loop can feed an FFV1 intermediate or a direct delivery segment.
 */
async function captureCompositionFrames(
  options: CompositionFrameCaptureOptions,
  writeFrame: (png: Buffer) => Promise<void>,
): Promise<CompositionDiagnostic[]> {
  const { project, timeline, clip, source, segment, layerIndex, serverUrl, infoCache } = options;
  const propsKey = JSON.stringify(clip.props ?? null);
  const cacheKey = `${source.entry}\u0000${propsKey}`;
  let validation = infoCache.get(cacheKey);
  if (!validation) {
    validation = await validateHtmlComposition({
      projectRoot: project.root,
      entry: source.entry,
      ...(clip.props !== undefined ? { props: clip.props } : {}),
      ...(project.format ? { format: project.format } : {}),
    });
    infoCache.set(cacheKey, validation);
  }
  if (!validation.info) {
    throw new FrameyardError(
      "TIMELINE_CLIP_INVALID",
      `Composition "${source.id}" could not be loaded for clip "${clip.id}".`,
      { diagnostics: validation.diagnostics },
    );
  }

  const layer = segment.layers[layerIndex];
  if (!layer) {
    throw new FrameyardError("INTERNAL", `Missing layer ${layerIndex} for segment ${segment.index}.`);
  }

  const sessionTiming = startTiming("timeline.layer.session", {
    entry: source.entry,
    layer: layerIndex,
    segment: segment.index,
  });
  const sessionKey = JSON.stringify([source.entry, clip.props ?? null, true]);
  const openOptions = {
    serverUrl,
    entry: source.entry,
    props: clip.props,
    info: validation.info as CompositionSourceInfo,
    staticDiagnostics: validation.diagnostics,
    transparentBackground: true,
  };
  const lease: SessionLease = options.sessionPool
    ? await options.sessionPool.acquire(sessionKey, () => openCompositionSession(openOptions))
    : await (async () => {
        const session = await openCompositionSession(openOptions);
        return {
          session,
          reused: false,
          release: () => session.close(),
          discard: () => session.close(),
        };
      })();
  sessionTiming.finish({ reused: lease.reused });
  const session = lease.session;
  let healthy = false;

  const diagnostics: CompositionDiagnostic[] = [];
  const captureTiming = startTiming("timeline.layer.capture_frames", {
    entry: source.entry,
    layer: layerIndex,
    segment: segment.index,
    frames: segment.frames,
  });
  let seekMs = 0;
  let captureMs = 0;
  let writeMs = 0;
  let pngBytes = 0;
  try {
    for (let offset = 0; offset < segment.frames; offset += 1) {
      throwIfAborted(options.signal);
      const seekStarted = performance.now();
      await session.seek(layer.sourceStart + offset);
      seekMs += performance.now() - seekStarted;
      const captureStarted = performance.now();
      const png = await session.capture();
      captureMs += performance.now() - captureStarted;
      pngBytes += png.length;
      const writeStarted = performance.now();
      await writeFrame(png);
      writeMs += performance.now() - writeStarted;
    }
    for (const diagnostic of await session.readDiagnostics()) {
      diagnostics.push(compositionDiagnostic(diagnostic, timeline.id, clip, source.id));
    }
    healthy = true;
  } finally {
    captureTiming.finish({
      seekMs: Number(seekMs.toFixed(1)),
      captureMs: Number(captureMs.toFixed(1)),
      writeMs: Number(writeMs.toFixed(1)),
      pngBytes,
    });
    if (healthy) {
      await lease.release();
    } else {
      await lease.discard();
    }
  }
  return diagnostics;
}

async function captureCompositionLayer(
  options: CompositionFrameCaptureOptions & { segmentDir: string },
): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const prefix = `comp-${options.layerIndex}`;
  const outputPath = path.join(options.segmentDir, `${prefix}.mkv`);
  const ffv1Timing = startTiming("timeline.layer.ffv1", {
    entry: options.source.entry,
    layer: options.layerIndex,
    segment: options.segment.index,
  });
  let encoder: VideoEncoder;
  try {
    encoder = await startFfv1Encoder({
      outputPath,
      frames: options.segment.frames,
      fps: options.timeline.format.fps,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    ffv1Timing.finish();
    throw error;
  }

  try {
    const diagnostics = await captureCompositionFrames(options, (png) => encoder.writeFrame(png));
    await encoder.finish();
    return { path: outputPath, diagnostics };
  } catch (error) {
    await encoder.abort();
    throw error;
  } finally {
    ffv1Timing.finish();
  }
}

/**
 * A single full-frame composition with no presentation work can go straight to
 * the delivery encoder. The FFV1 intermediate and the FFmpeg composite would
 * both be identity operations except for the background fill.
 */
type SceneLayer = TimelineRenderSegment["layers"][number];

function isFullFrameComposition(layer: SceneLayer, timeline: ResolvedTimeline): boolean {
  if (layer.clip.source.kind !== "composition" || layer.capture !== "frames") {
    return false;
  }
  if (layer.transform.width !== undefined || layer.transform.height !== undefined) {
    return false;
  }
  if (layer.sourceWidth !== timeline.format.width || layer.sourceHeight !== timeline.format.height) {
    return false;
  }
  const { x, y, scale, rotation, opacity } = layer.transform;
  if (x !== 0 || y !== 0 || scale !== 1 || rotation !== 0 || opacity !== 1) {
    return false;
  }
  return layer.blend === "normal" && layer.transition === undefined && layer.keyframes === undefined;
}

function canEncodeDirectly(options: {
  segment: TimelineRenderSegment;
  timeline: ResolvedTimeline;
  background: string;
}): boolean {
  if (options.background === "transparent" || options.segment.layers.length !== 1) {
    return false;
  }
  const layer = options.segment.layers[0];
  return layer !== undefined && isFullFrameComposition(layer, options.timeline);
}

function isStaticCompositionOverlay(layer: SceneLayer): boolean {
  if (layer.clip.source.kind !== "composition" || layer.capture !== "frames") {
    return false;
  }
  const { scale, rotation, opacity } = layer.transform;
  if (scale !== 1 || rotation !== 0 || opacity !== 1) {
    return false;
  }
  return layer.blend === "normal" && layer.transition === undefined && layer.keyframes === undefined;
}

function canEncodeVideoDirectly(options: {
  segment: TimelineRenderSegment;
  timeline: ResolvedTimeline;
  background: string;
}): boolean {
  if (process.env.FRAMEYARD_DISABLE_VIDEO_DIRECT === "1") {
    return false;
  }
  if (options.background === "transparent" || options.segment.layers.length !== 1) {
    return false;
  }
  const layer = options.segment.layers[0];
  if (!layer || layer.clip.source.kind !== "video" || layer.capture !== "video") {
    return false;
  }
  if (layer.sourceWidth !== options.timeline.format.width || layer.sourceHeight !== options.timeline.format.height) {
    return false;
  }
  const { x, y, scale, rotation, opacity, width, height } = layer.transform;
  if (
    width !== undefined ||
    height !== undefined ||
    x !== 0 ||
    y !== 0 ||
    scale !== 1 ||
    rotation !== 0 ||
    opacity !== 1
  ) {
    return false;
  }
  return layer.blend === "normal" && layer.transition === undefined && layer.keyframes === undefined;
}

function canEncodeDualPipe(options: {
  segment: TimelineRenderSegment;
  timeline: ResolvedTimeline;
  background: string;
}): boolean {
  // FFmpeg reads the second image pipe through fd 3; keep the conservative
  // fallback on hosts where extra stdio pipes are not portable.
  if (
    process.platform === "win32" ||
    process.env.FRAMEYARD_DISABLE_DUAL_PIPE === "1" ||
    options.background === "transparent" ||
    options.segment.layers.length !== 2
  ) {
    return false;
  }
  const base = options.segment.layers[0];
  const overlay = options.segment.layers[1];
  return (
    base !== undefined &&
    overlay !== undefined &&
    isFullFrameComposition(base, options.timeline) &&
    isStaticCompositionOverlay(overlay)
  );
}

async function captureDirectCompositionLayer(
  options: CompositionFrameCaptureOptions & {
    outputPath: string;
    background: string;
    codec: VideoCodec;
    container: VideoContainer;
    encoderName?: VideoEncoderName;
  },
): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const timing = startTiming("timeline.layer.composition", {
    entry: options.source.entry,
    layer: options.layerIndex,
    segment: options.segment.index,
  });
  let encoder: VideoEncoder;
  try {
    encoder = await startDirectSegmentEncoder({
      outputPath: options.outputPath,
      width: options.timeline.format.width,
      height: options.timeline.format.height,
      fps: options.timeline.format.fps,
      frames: options.segment.frames,
      background: options.background,
      codec: options.codec,
      container: options.container,
      ...(options.encoderName !== undefined ? { encoder: options.encoderName } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    timing.finish();
    throw error;
  }

  try {
    const diagnostics = await captureCompositionFrames(options, (png) => encoder.writeFrame(png));
    await encoder.finish();
    return { path: options.outputPath, diagnostics };
  } catch (error) {
    await encoder.abort();
    throw error;
  } finally {
    timing.finish();
  }
}

async function captureTwoLayerDirectComposition(
  options: Omit<CompositionFrameCaptureOptions, "clip" | "source" | "layerIndex"> & {
    outputPath: string;
    background: string;
    codec: VideoCodec;
    container: VideoContainer;
    encoderName?: VideoEncoderName;
    captureLimiter?: Semaphore;
  },
): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const overlayLayer = options.segment.layers[1];
  if (!overlayLayer) {
    throw new FrameyardError("INTERNAL", "Dual-pipe capture requires an overlay layer.");
  }
  const overlay = sceneLayerToCompositeLayer(overlayLayer, { path: "pipe:3", input: "sequence" });
  const encoder: DualPipeEncoder = await startDualPipeSegmentEncoder({
    outputPath: options.outputPath,
    width: options.timeline.format.width,
    height: options.timeline.format.height,
    fps: options.timeline.format.fps,
    frames: options.segment.frames,
    background: options.background,
    codec: options.codec,
    container: options.container,
    overlay,
    ...(options.encoderName !== undefined ? { encoder: options.encoderName } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const tasks = options.segment.layers.map(async (layer, layerIndex): Promise<CompositionDiagnostic[]> => {
    if (layer.clip.source.kind !== "composition") {
      throw new FrameyardError("INTERNAL", "Dual-pipe capture requires composition layers.");
    }
    const source = layer.clip.source;
    return withCaptureSlot(options.captureLimiter, options.signal, async () => {
      const timing = startTiming("timeline.layer.composition", {
        entry: source.entry,
        layer: layerIndex,
        segment: options.segment.index,
      });
      try {
        return await captureCompositionFrames(
          {
            project: options.project,
            timeline: options.timeline,
            clip: layer.clip,
            source,
            segment: options.segment,
            layerIndex,
            serverUrl: options.serverUrl,
            infoCache: options.infoCache,
            ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          },
          (png) => encoder.writeFrame(layerIndex as 0 | 1, png),
        );
      } finally {
        timing.finish();
      }
    });
  });

  const settled = await Promise.allSettled(tasks);
  const diagnostics: CompositionDiagnostic[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      await encoder.abort();
      throw result.reason;
    }
    diagnostics.push(...result.value);
  }

  try {
    await encoder.finish();
  } catch (error) {
    await encoder.abort();
    throw error;
  }
  return { path: options.outputPath, diagnostics };
}

async function renderNestedTimelineRange(options: {
  project: Project;
  timeline: ResolvedTimeline;
  startFrame: number;
  frames: number;
  serverUrl: string;
  scratchRoot: string;
  infoCache: Map<string, StaticValidationResult>;
  staticCache: Map<string, Promise<StaticCapture>>;
  captureLimiter?: Semaphore;
  sessionPool?: CompositionSessionPool;
  depth: number;
  signal?: AbortSignal;
}): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  if (options.depth > 32) {
    throw new FrameyardError("TIMELINE_INVALID", "Nested timeline depth exceeds 32.");
  }
  const plan = planTimelineRender(options.timeline, {
    startFrame: options.startFrame,
    endFrame: options.startFrame + options.frames,
  });
  const unique = randomUUID();
  const prefix = `nested-${options.depth}-${options.startFrame}-${unique}`;
  const results: Array<{ path: string; diagnostics: CompositionDiagnostic[] }> = [];
  for (const segment of plan.segments) {
    results.push(
      await processTimelineSegment({
        project: options.project,
        timeline: options.timeline,
        segment,
        serverUrl: options.serverUrl,
        scratchRoot: options.scratchRoot,
        infoCache: options.infoCache,
        staticCache: options.staticCache,
        ...(options.captureLimiter !== undefined ? { captureLimiter: options.captureLimiter } : {}),
        ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
        codec: "ffv1",
        background: options.timeline.background ?? "transparent",
        prefix,
        depth: options.depth,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
  }
  const diagnostics = results.flatMap((result) => result.diagnostics);
  if (results.length === 1) {
    return { path: (results[0] as { path: string }).path, diagnostics };
  }
  const outputPath = path.join(options.scratchRoot, `${prefix}.mkv`);
  await concatTimelineSegments({
    segmentPaths: results.map((result) => result.path),
    listPath: path.join(options.scratchRoot, `${prefix}-segments.txt`),
    outputPath,
    // Nested timeline segments are always lossless FFV1 in Matroska.
    container: "mkv",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { path: outputPath, diagnostics };
}

interface CapturedLayer {
  layerIndex: number;
  compositeLayer: TimelineCompositeLayer;
  diagnostics: CompositionDiagnostic[];
}

async function processTimelineSegment(options: {
  project: Project;
  timeline: ResolvedTimeline;
  segment: TimelineRenderSegment;
  serverUrl: string;
  scratchRoot: string;
  infoCache: Map<string, StaticValidationResult>;
  staticCache: Map<string, Promise<StaticCapture>>;
  captureLimiter?: Semaphore;
  sessionPool?: CompositionSessionPool;
  codec?: VideoCodec | "ffv1";
  container?: VideoContainer;
  background?: string;
  prefix?: string;
  depth?: number;
  encoder?: VideoEncoderName;
  signal?: AbortSignal;
}): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const { project, timeline, segment, serverUrl, scratchRoot, infoCache } = options;
  const codec = options.codec ?? "h264";
  const background = options.background ?? (codec === "ffv1" ? "transparent" : (timeline.background ?? "black"));
  const prefix = options.prefix ?? "timeline";
  const depth = options.depth ?? 0;
  const segmentDir = path.join(scratchRoot, `${prefix}-seg-${String(segment.index).padStart(4, "0")}`);
  const segmentTiming = startTiming("timeline.segment", {
    segment: segment.index,
    start: segment.start,
    frames: segment.frames,
    layers: segment.layers.length,
  });
  const extension = codec === "ffv1" ? "mkv" : CONTAINER_EXTENSION[options.container ?? "mp4"];
  const segmentPath = path.join(
    scratchRoot,
    `${prefix}-segment-${String(segment.index).padStart(4, "0")}.${extension}`,
  );

  if (codec !== "ffv1" && canEncodeDirectly({ segment, timeline, background })) {
    const layer = segment.layers[0];
    if (!layer) {
      throw new FrameyardError("INTERNAL", "Direct segment capture requires one composition layer.");
    }
    const clip = layer.clip;
    if (clip.source.kind !== "composition") {
      throw new FrameyardError("INTERNAL", "Direct segment capture requires one composition layer.");
    }
    const source = clip.source;
    const directTiming = startTiming("timeline.segment.direct", {
      segment: segment.index,
      frames: segment.frames,
      codec,
      container: options.container ?? "mp4",
    });
    const captured = await withCaptureSlot(options.captureLimiter, options.signal, () =>
      captureDirectCompositionLayer({
        project,
        timeline,
        clip,
        source,
        segment,
        layerIndex: 0,
        serverUrl,
        infoCache,
        outputPath: segmentPath,
        background,
        codec,
        container: options.container ?? "mp4",
        ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
        ...(options.encoder !== undefined ? { encoderName: options.encoder } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    directTiming.finish();
    segmentTiming.finish();
    return { path: segmentPath, diagnostics: captured.diagnostics };
  }

  if (codec !== "ffv1" && canEncodeDualPipe({ segment, timeline, background })) {
    const directTiming = startTiming("timeline.segment.direct", {
      segment: segment.index,
      frames: segment.frames,
      codec,
      container: options.container ?? "mp4",
      layers: 2,
    });
    const captured = await captureTwoLayerDirectComposition({
      project,
      timeline,
      segment,
      serverUrl,
      infoCache,
      outputPath: segmentPath,
      background,
      codec,
      container: options.container ?? "mp4",
      ...(options.captureLimiter !== undefined ? { captureLimiter: options.captureLimiter } : {}),
      ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
      ...(options.encoder !== undefined ? { encoderName: options.encoder } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    directTiming.finish();
    segmentTiming.finish();
    return { path: segmentPath, diagnostics: captured.diagnostics };
  }

  if (codec !== "ffv1" && canEncodeVideoDirectly({ segment, timeline, background })) {
    const layer = segment.layers[0];
    if (!layer || layer.clip.source.kind !== "video") {
      throw new FrameyardError("INTERNAL", "Direct video capture requires one video layer.");
    }
    const source = layer.clip.source;
    const directTiming = startTiming("timeline.segment.direct", {
      segment: segment.index,
      frames: segment.frames,
      codec,
      container: options.container ?? "mp4",
      layers: 1,
      kind: "video",
    });
    await encodeVideoSegmentDirect({
      inputPath: source.absolutePath,
      outputPath: segmentPath,
      sourceStartFrame: layer.sourceStart,
      frames: segment.frames,
      fps: timeline.format.fps,
      codec,
      container: options.container ?? "mp4",
      ...(options.encoder !== undefined ? { encoder: options.encoder } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    directTiming.finish();
    segmentTiming.finish();
    return { path: segmentPath, diagnostics: [] };
  }

  await mkdir(segmentDir, { recursive: true });
  const diagnostics: CompositionDiagnostic[] = [];
  const layers: TimelineCompositeLayer[] = [];
  const layerTasks = segment.layers.map(async (layer, layerIndex): Promise<CapturedLayer> => {
    throwIfAborted(options.signal);
    const clip = layer.clip;
    const source = clip.source;

    if (source.kind === "composition") {
      if (layer.capture === "still") {
        const timing = startTiming("timeline.layer.static", { layer: layerIndex, segment: segment.index });
        const captured = await withCaptureSlot(options.captureLimiter, options.signal, () =>
          captureStaticCompositionLayer({
            project,
            timeline,
            clip,
            source,
            serverUrl,
            scratchRoot,
            infoCache,
            staticCache: options.staticCache,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        );
        timing.finish();
        return {
          layerIndex,
          compositeLayer: sceneLayerToCompositeLayer(layer, { path: captured.path, input: "image" }),
          diagnostics: captured.diagnostics,
        };
      }

      const timing = startTiming("timeline.layer.composition", {
        entry: source.entry,
        layer: layerIndex,
        segment: segment.index,
      });
      const captured = await withCaptureSlot(options.captureLimiter, options.signal, () =>
        captureCompositionLayer({
          project,
          timeline,
          clip,
          source,
          segment,
          layerIndex,
          serverUrl,
          segmentDir,
          infoCache,
          ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      timing.finish();
      return {
        layerIndex,
        compositeLayer: sceneLayerToCompositeLayer(layer, { path: captured.path, input: "sequence" }),
        diagnostics: captured.diagnostics,
      };
    }

    if (source.kind === "video" || source.kind === "image") {
      return {
        layerIndex,
        compositeLayer: sceneLayerToCompositeLayer(layer, {
          path: source.absolutePath,
          input: source.kind,
          ...(source.kind === "video" ? { sourceStartFrame: layer.sourceStart } : {}),
        }),
        diagnostics: [],
      };
    }

    if (source.kind === "timeline") {
      const timing = startTiming("timeline.layer.nested", { layer: layerIndex, segment: segment.index });
      const nested = await renderNestedTimelineRange({
        project,
        timeline: source.timeline,
        startFrame: layer.sourceStart,
        frames: segment.frames,
        serverUrl,
        scratchRoot,
        infoCache,
        staticCache: options.staticCache,
        ...(options.captureLimiter !== undefined ? { captureLimiter: options.captureLimiter } : {}),
        ...(options.sessionPool !== undefined ? { sessionPool: options.sessionPool } : {}),
        depth: depth + 1,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      timing.finish();
      return {
        layerIndex,
        compositeLayer: sceneLayerToCompositeLayer(layer, { path: nested.path, input: "sequence" }),
        diagnostics: nested.diagnostics,
      };
    }

    throw new FrameyardError("TIMELINE_INVALID", `Unsupported visual source for clip "${clip.id}".`);
  });

  const settled = await Promise.allSettled(layerTasks);
  const capturedLayers: CapturedLayer[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    capturedLayers.push(result.value);
  }
  capturedLayers.sort((left, right) => left.layerIndex - right.layerIndex);
  for (const captured of capturedLayers) {
    diagnostics.push(...captured.diagnostics);
    layers.push(captured.compositeLayer);
  }

  const compositeTiming = startTiming("timeline.segment.composite", {
    segment: segment.index,
    frames: segment.frames,
    layers: layers.length,
    codec,
  });
  await compositeTimelineSegment({
    outputPath: segmentPath,
    width: timeline.format.width,
    height: timeline.format.height,
    fps: timeline.format.fps,
    frames: segment.frames,
    background,
    layers,
    codec,
    frameOffset: segment.start,
    ...(options.container !== undefined ? { container: options.container } : {}),
    ...(options.encoder !== undefined ? { encoder: options.encoder } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  compositeTiming.finish();
  const cleanupTiming = startTiming("timeline.segment.cleanup", { segment: segment.index });
  await rm(segmentDir, { recursive: true, force: true });
  cleanupTiming.finish();
  segmentTiming.finish();
  return { path: segmentPath, diagnostics };
}

interface TimelineCheckContext {
  project: Project;
  serverUrl: string;
  signal?: AbortSignal;
  onProgress?: (event: TimelineProgressEvent) => void;
  totalFrames: number;
  startedAt: number;
  depth: number;
}

function checkKeyframeEvaluation(timeline: ResolvedTimeline, segments: readonly TimelineRenderSegment[]): void {
  for (const segment of segments) {
    for (const layer of segment.layers) {
      const keyframes = layer.keyframes;
      if (!keyframes) {
        continue;
      }
      for (let frame = segment.start; frame < segment.end; frame += 1) {
        const values = evaluatePresentation(layer.transform, keyframes, frame - layer.clip.start);
        for (const channel of KEYFRAME_CHANNELS) {
          if (!Number.isFinite(values[channel])) {
            throw new FrameyardError(
              "TIMELINE_CLIP_INVALID",
              `Clip "${layer.clip.id}" keyframes.${channel} produced a non-finite value at timeline frame ${frame}.`,
              {
                details: {
                  timeline: timeline.id,
                  clip: layer.clip.id,
                  track: layer.clip.track,
                  channel,
                  frame: frame - layer.clip.start,
                  timelineFrame: frame,
                },
              },
            );
          }
        }
      }
    }
  }
}

function checkTransitionEvaluation(timeline: ResolvedTimeline): void {
  for (const transition of timeline.transitions) {
    for (let frame = transition.start; frame < transition.end; frame += 1) {
      const progress = transitionProgress(transition, frame);
      if (!Number.isFinite(progress)) {
        throw new FrameyardError(
          "TIMELINE_TRANSITION_INVALID",
          `Transition "${transition.from}" → "${transition.to}" produced a non-finite progress at timeline frame ${frame}.`,
          {
            details: {
              timeline: timeline.id,
              track: transition.track,
              from: transition.from,
              to: transition.to,
              timelineFrame: frame,
            },
          },
        );
      }
    }
  }
}

async function checkResolvedTimelineRange(options: {
  timeline: ResolvedTimeline;
  startFrame: number;
  endFrame: number;
  context: TimelineCheckContext;
}): Promise<CompositionDiagnostic[]> {
  if (options.context.depth > 32) {
    throw new FrameyardError("TIMELINE_INVALID", "Nested timeline depth exceeds 32.");
  }
  const { timeline, startFrame, endFrame, context } = options;
  const plan = planTimelineRender(timeline, { startFrame, endFrame });
  const diagnostics: CompositionDiagnostic[] = [];
  checkKeyframeEvaluation(timeline, plan.segments);
  checkTransitionEvaluation(timeline);
  const targets = new Map<
    string,
    { source: ResolvedCompositionSource; clip: ResolvedTimelineClip; validation: StaticValidationResult }
  >();

  for (const segment of plan.segments) {
    for (const layer of segment.layers) {
      const source = layer.clip.source;
      if (source.kind !== "composition") {
        continue;
      }
      const key = `${source.entry}\u0000${JSON.stringify(layer.clip.props ?? null)}`;
      if (!targets.has(key)) {
        const validation = await validateHtmlComposition({
          projectRoot: context.project.root,
          entry: source.entry,
          ...(layer.clip.props !== undefined ? { props: layer.clip.props } : {}),
          ...(context.project.format ? { format: context.project.format } : {}),
        });
        if (!validation.info) {
          throw new FrameyardError(
            "TIMELINE_CLIP_INVALID",
            `Composition "${source.id}" could not be loaded for clip "${layer.clip.id}".`,
            { diagnostics: validation.diagnostics },
          );
        }
        targets.set(key, { source, clip: layer.clip, validation });
      }
    }
  }

  const sessions = new Map<string, CompositionSession>();
  try {
    for (const [key, target] of targets) {
      const session = await openCompositionSession({
        serverUrl: context.serverUrl,
        entry: target.source.entry,
        props: target.clip.props,
        info: target.validation.info as CompositionSourceInfo,
        staticDiagnostics: target.validation.diagnostics,
      });
      sessions.set(key, session);
      if (target.source.metadata.static === true) {
        await session.seek(0);
      }
    }

    for (const segment of plan.segments) {
      for (let frame = segment.start; frame < segment.end; frame += 1) {
        throwIfAborted(context.signal);
        for (const layer of segment.layers) {
          if (layer.clip.source.kind !== "composition") {
            continue;
          }
          const source = layer.clip.source;
          if (source.metadata.static === true) {
            continue;
          }
          const key = `${source.entry}\u0000${JSON.stringify(layer.clip.props ?? null)}`;
          const session = sessions.get(key);
          if (!session) {
            throw new FrameyardError("INTERNAL", `Missing composition session for clip "${layer.clip.id}".`);
          }
          await session.seek(layer.sourceStart + (frame - segment.start));
        }
      }
      if (context.depth === 0) {
        context.onProgress?.({
          frame: segment.end,
          total: context.totalFrames,
          elapsedMs: performance.now() - context.startedAt,
          segment: segment.index + 1,
          segments: plan.segments.length,
        });
      }
    }

    for (const [key, target] of targets) {
      const session = sessions.get(key);
      if (!session) {
        continue;
      }
      for (const diagnostic of await session.readDiagnostics()) {
        diagnostics.push(compositionDiagnostic(diagnostic, timeline.id, target.clip, target.source.id));
      }
    }
  } finally {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        try {
          await session.close();
        } catch {
          // Preserve the check's original error.
        }
      }),
    );
  }

  for (const segment of plan.segments) {
    for (const layer of segment.layers) {
      if (layer.clip.source.kind !== "timeline") {
        continue;
      }
      diagnostics.push(
        ...(await checkResolvedTimelineRange({
          timeline: layer.clip.source.timeline,
          startFrame: layer.sourceStart,
          endFrame: layer.sourceStart + segment.frames,
          context: { ...context, depth: context.depth + 1 },
        })),
      );
    }
  }

  return diagnostics;
}

/** Validates a timeline and evaluates every timeline frame without capturing. */
export async function checkTimeline(options: {
  project: Project;
  timelineId: string;
  propsOverrides?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: TimelineProgressEvent) => void;
}): Promise<TimelineCheckResult> {
  const startedAt = performance.now();
  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${options.timelineId}" is not listed in fy.config.js.`);
  }

  const resolved = await resolveProjectTimeline({
    project: options.project,
    timeline: projectTimeline,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.propsOverrides ? { propsOverrides: options.propsOverrides } : {}),
  });
  if (!resolved.timeline) {
    const first = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new FrameyardError(first?.code ?? "TIMELINE_INVALID", first?.message ?? "Timeline resolution failed.", {
      diagnostics: resolved.diagnostics,
    });
  }
  const timeline = resolved.timeline;
  const diagnostics: CompositionDiagnostic[] = [...resolved.diagnostics];
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });

  try {
    diagnostics.push(
      ...(await checkResolvedTimelineRange({
        timeline,
        startFrame: 0,
        endFrame: timeline.durationInFrames,
        context: {
          project: options.project,
          serverUrl: server.url,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          totalFrames: timeline.durationInFrames,
          startedAt,
          depth: 0,
        },
      })),
    );
  } finally {
    try {
      await server.close();
    } catch {
      // Preserve the check's original error.
    }
  }

  const audio = buildAudioClips(timeline);
  const audioInspection = audio.clips.length
    ? await inspectTimelineAudio({
        projectRoot: options.project.root,
        clips: audio.clips,
        fps: timeline.format.fps,
        durationInFrames: timeline.durationInFrames,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : { clips: [], assets: [], warnings: [] };
  diagnostics.push(
    ...audioInspection.warnings.map((message) => ({
      severity: "warning" as const,
      code: "AUDIO_WARNING" as const,
      message,
    })),
  );

  const transcripts = audio.transcripts.length
    ? await inspectTranscriptClips({
        projectRoot: options.project.root,
        clips: audio.transcripts,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : { clips: [], assets: [], warnings: [] };
  diagnostics.push(
    ...transcripts.warnings.map((message) => ({
      severity: "warning" as const,
      code: "TRANSCRIPT_WARNING" as const,
      message,
    })),
  );

  return {
    timeline: options.timelineId,
    entry: timeline.entry,
    format: { ...timeline.format },
    durationInFrames: timeline.durationInFrames,
    framesChecked: timeline.durationInFrames,
    tracks: timeline.tracks.length,
    clips: timeline.clips.length,
    transitions: timeline.transitions.length,
    audio: { clips: audioInspection.clips.length, details: audioInspection.clips },
    transcripts: {
      clips: transcripts.clips.length,
      details: transcripts.clips,
    },
    diagnostics: mergeDiagnostics(diagnostics),
    elapsedMs: performance.now() - startedAt,
  };
}

interface FrameRenderContext {
  project: Project;
  serverUrl: string;
  scratchRoot: string;
  depth: number;
  signal?: AbortSignal;
}

async function renderResolvedTimelineFrame(options: {
  timeline: ResolvedTimeline;
  frame: number;
  outputPath: string;
  background: string;
  context: FrameRenderContext;
}): Promise<CompositionDiagnostic[]> {
  if (options.context.depth > 32) {
    throw new FrameyardError("TIMELINE_INVALID", "Nested timeline depth exceeds 32.");
  }
  const { timeline, frame, context } = options;
  const scene = projectScene(timeline, frame, frame + 1);

  const diagnostics: CompositionDiagnostic[] = [];
  const layers: TimelineCompositeLayer[] = [];
  for (const [layerIndex, layer] of scene.layers.entries()) {
    const clip = layer.clip;
    const source = clip.source;

    if (source.kind === "composition") {
      const validation = await validateHtmlComposition({
        projectRoot: context.project.root,
        entry: source.entry,
        ...(clip.props !== undefined ? { props: clip.props } : {}),
        ...(context.project.format ? { format: context.project.format } : {}),
      });
      if (!validation.info) {
        throw new FrameyardError(
          "TIMELINE_CLIP_INVALID",
          `Composition "${source.id}" could not be loaded for clip "${clip.id}".`,
          { diagnostics: validation.diagnostics },
        );
      }
      const session = await openCompositionSession({
        serverUrl: context.serverUrl,
        entry: source.entry,
        props: clip.props,
        info: validation.info,
        staticDiagnostics: validation.diagnostics,
        transparentBackground: true,
      });
      const framePath = path.join(context.scratchRoot, `frame-${context.depth}-${layerIndex}-${randomUUID()}.png`);
      try {
        await session.seek(layer.sourceStart);
        const png = await session.capture();
        await writeFile(framePath, png);
        for (const diagnostic of await session.readDiagnostics()) {
          diagnostics.push(compositionDiagnostic(diagnostic, timeline.id, clip, source.id));
        }
      } finally {
        await session.close();
      }
      layers.push(sceneLayerToCompositeLayer(layer, { path: framePath, input: "image" }));
      continue;
    }

    if (source.kind === "video" || source.kind === "image") {
      layers.push(
        sceneLayerToCompositeLayer(layer, {
          path: source.absolutePath,
          input: source.kind,
          ...(source.kind === "video" ? { sourceStartFrame: layer.sourceStart } : {}),
        }),
      );
      continue;
    }

    if (source.kind === "timeline") {
      const nestedPath = path.join(
        context.scratchRoot,
        `nested-frame-${context.depth}-${layerIndex}-${randomUUID()}.png`,
      );
      const nestedDiagnostics = await renderResolvedTimelineFrame({
        timeline: source.timeline,
        frame: layer.sourceStart,
        outputPath: nestedPath,
        background: source.timeline.background ?? "transparent",
        context: { ...context, depth: context.depth + 1 },
      });
      diagnostics.push(...nestedDiagnostics);
      layers.push(sceneLayerToCompositeLayer(layer, { path: nestedPath, input: "image" }));
      continue;
    }

    throw new FrameyardError("TIMELINE_INVALID", `Unsupported visual source for clip "${clip.id}".`);
  }

  await compositeTimelineFrame({
    outputPath: options.outputPath,
    width: timeline.format.width,
    height: timeline.format.height,
    fps: timeline.format.fps,
    background: options.background,
    layers,
    frameOffset: frame,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  return diagnostics;
}

/** Captures timeline frames as PNGs through the clip capture and composite path. */
export async function captureTimelineStills(options: TimelineStillsOptions): Promise<TimelineStillResult> {
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
  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${options.timelineId}" is not listed in fy.config.js.`);
  }

  const resolved = await resolveProjectTimeline({
    project: options.project,
    timeline: projectTimeline,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.propsOverrides ? { propsOverrides: options.propsOverrides } : {}),
  });
  if (!resolved.timeline) {
    const first = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new FrameyardError(first?.code ?? "TIMELINE_INVALID", first?.message ?? "Timeline resolution failed.", {
      diagnostics: resolved.diagnostics,
    });
  }
  const timeline = resolved.timeline;
  const invalidFrames = options.frames.filter((frame) => frame >= timeline.durationInFrames);
  if (invalidFrames.length > 0) {
    const first = invalidFrames[0] as number;
    throw new FrameyardError(
      "FRAME_OUT_OF_RANGE",
      `Frame ${first} is outside the valid range 0..${timeline.durationInFrames - 1}.`,
      { details: { invalidFrames, validRange: { min: 0, max: timeline.durationInFrames - 1 } } },
    );
  }
  await assertOutputsAvailable(options.outPaths, overwrite);
  for (const outPath of options.outPaths) {
    await mkdir(path.dirname(outPath), { recursive: true });
  }

  const scratchBase = options.scratchDir ?? tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const scratchRoot = await mkdtemp(path.join(scratchBase, "frameyard-timeline-still-"));
  const tempPaths = options.outPaths.map((outPath) =>
    path.join(path.dirname(outPath), `.${path.basename(outPath)}.frameyard-${process.pid}-${randomUUID()}.png`),
  );
  let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

  try {
    server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });

    const diagnostics: CompositionDiagnostic[] = [];
    for (const [index, frame] of options.frames.entries()) {
      throwIfAborted(options.signal);
      try {
        diagnostics.push(
          ...(await renderResolvedTimelineFrame({
            timeline,
            frame,
            outputPath: tempPaths[index] as string,
            background: timeline.background ?? "black",
            context: {
              project: options.project,
              serverUrl: server.url,
              scratchRoot,
              depth: 0,
              ...(options.signal ? { signal: options.signal } : {}),
            },
          })),
        );
      } catch (error) {
        throw withBatchContext(error, options.frames, frame);
      }
    }

    await assertOutputsAvailable(options.outPaths, overwrite);
    for (const [index, outPath] of options.outPaths.entries()) {
      await publishFile(tempPaths[index] as string, outPath, overwrite);
    }

    const frames = options.frames.map((frame, index) => ({
      frame,
      path: options.outPaths[index] as string,
    }));
    const first = frames[0];
    return {
      timeline: options.timelineId,
      entry: timeline.entry,
      ...(frames.length === 1 && first !== undefined ? { frame: first.frame, path: first.path } : {}),
      frames,
      width: timeline.format.width,
      height: timeline.format.height,
      diagnostics: mergeDiagnostics(resolved.diagnostics, diagnostics),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    await Promise.all(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
    try {
      await server?.close();
    } catch {
      // Preserve the still's original error.
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

/** Captures one timeline frame as a PNG through the clip capture and composite path. */
export async function captureTimelineStill(options: TimelineStillOptions): Promise<TimelineStillResult> {
  const { frame, outPath, ...rest } = options;
  return captureTimelineStills({
    ...rest,
    frames: [frame],
    outPaths: [outPath],
  });
}

/** Renders one timeline to MP4 through the segmented lossless clip pipeline. */
export async function renderTimeline(options: TimelineRenderOptions): Promise<TimelineRenderResult> {
  const container = options.container ?? "mp4";
  const codec = options.codec ?? defaultCodecForContainer(container);
  assertContainerCodec(container, codec);
  const extension = `.${CONTAINER_EXTENSION[container]}`;
  if (path.extname(options.outPath).toLowerCase() !== extension) {
    throw new FrameyardError(
      "USAGE",
      `Timeline output for --container ${container} must use a ${extension} extension: ${options.outPath}`,
    );
  }

  const requestedWorkers = validateWorkers(options.workers);
  const overwrite = options.overwrite ?? false;
  const startedAt = performance.now();
  const renderTiming = startTiming("timeline.render", { timeline: options.timelineId });
  await ensureOutputAvailable(options.outPath, overwrite);
  await assertFfmpegCapabilities(options.signal, codec);
  const encoder = await resolveVideoEncoder(codec, options.encoder, options.signal);
  const workers = clampTimelineWorkers(requestedWorkers, encoder);
  const captureLimiter = createSemaphore(captureConcurrency(workers));
  const sessionPool = new CompositionSessionPool({ maxIdle: Math.max(2, workers) });

  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${options.timelineId}" is not listed in fy.config.js.`);
  }

  const resolveTiming = startTiming("timeline.resolve", { timeline: options.timelineId });
  const resolved = await resolveProjectTimeline({
    project: options.project,
    timeline: projectTimeline,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.propsOverrides ? { propsOverrides: options.propsOverrides } : {}),
  });
  resolveTiming.finish({ clips: resolved.timeline?.clips.length ?? 0, diagnostics: resolved.diagnostics.length });
  if (!resolved.timeline) {
    const first = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new FrameyardError(first?.code ?? "TIMELINE_INVALID", first?.message ?? "Timeline resolution failed.", {
      diagnostics: resolved.diagnostics,
    });
  }
  const timeline = resolved.timeline;
  const plan = planTimelineRender(timeline, { maxSegmentFrames: options.maxSegmentFrames });

  const scratchBase = options.scratchDir ?? tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const scratchRoot = await mkdtemp(path.join(scratchBase, "frameyard-timeline-"));
  const serverTiming = startTiming("timeline.server", { project: options.project.root });
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  serverTiming.finish({ url: server.url });
  const infoCache = new Map<string, StaticValidationResult>();
  const staticCache = new Map<string, Promise<StaticCapture>>();
  const diagnostics: CompositionDiagnostic[] = [...resolved.diagnostics];
  if (workers < requestedWorkers) {
    diagnostics.push({
      severity: "warning",
      code: "ENCODER_WARNING",
      message: `Encoder ${encoder} allows ${workers} concurrent encode sessions; using ${workers} workers instead of ${requestedWorkers}.`,
    });
  }
  const total = timeline.durationInFrames;
  const segmentResults: Array<{ path: string; diagnostics: CompositionDiagnostic[] } | undefined> = Array.from({
    length: plan.segments.length,
  });
  let nextSegment = 0;

  const audio = buildAudioClips(timeline);
  const audioTiming = startTiming("timeline.audio_inspect", { clips: audio.clips.length });
  const audioInspection = audio.clips.length
    ? await inspectTimelineAudio({
        projectRoot: options.project.root,
        clips: audio.clips,
        fps: timeline.format.fps,
        durationInFrames: total,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : { clips: [], assets: [], warnings: [] };
  audioTiming.finish({ assets: audioInspection.assets.length });
  diagnostics.push(
    ...audioInspection.warnings.map((message) => ({
      severity: "warning" as const,
      code: "AUDIO_WARNING" as const,
      message,
    })),
  );

  const transcriptTiming = startTiming("timeline.transcript_inspect", { clips: audio.transcripts.length });
  const transcripts = audio.transcripts.length
    ? await inspectTranscriptClips({
        projectRoot: options.project.root,
        clips: audio.transcripts,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : { clips: [], assets: [], warnings: [] };
  transcriptTiming.finish({ assets: transcripts.assets.length });
  diagnostics.push(
    ...transcripts.warnings.map((message) => ({
      severity: "warning" as const,
      code: "TRANSCRIPT_WARNING" as const,
      message,
    })),
  );

  const tempVideo = path.join(
    path.dirname(options.outPath),
    `.${path.basename(options.outPath)}.frameyard-${process.pid}-${randomUUID()}.video.mp4`,
  );
  const tempFinal = path.join(
    path.dirname(options.outPath),
    `.${path.basename(options.outPath)}.frameyard-${process.pid}-${randomUUID()}.mp4`,
  );

  try {
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfAborted(options.signal);
        const index = nextSegment;
        nextSegment += 1;
        if (index >= plan.segments.length) {
          return;
        }
        const segment = plan.segments[index] as TimelineRenderSegment;
        const result = await processTimelineSegment({
          project: options.project,
          timeline,
          segment,
          serverUrl: server.url,
          scratchRoot,
          infoCache,
          staticCache,
          captureLimiter,
          sessionPool,
          codec,
          container,
          encoder,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        segmentResults[index] = result;
        options.onProgress?.({
          frame: segment.end,
          total,
          elapsedMs: performance.now() - startedAt,
          segment: index + 1,
          segments: plan.segments.length,
        });
      }
    };
    const segmentsTiming = startTiming("timeline.segments", {
      segments: plan.segments.length,
      workers,
      codec,
      encoder,
    });
    await Promise.all(Array.from({ length: workers }, () => worker()));
    segmentsTiming.finish();

    const segmentPaths = segmentResults.map((result) => {
      if (!result) {
        throw new FrameyardError("INTERNAL", "A timeline segment was not rendered.");
      }
      diagnostics.push(...result.diagnostics);
      return result.path;
    });

    const concatTiming = startTiming("timeline.concat", { segments: segmentPaths.length });
    await concatTimelineSegments({
      segmentPaths,
      listPath: path.join(scratchRoot, "segments.txt"),
      outputPath: tempVideo,
      codec,
      container,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    concatTiming.finish();

    let finalPath = tempVideo;
    if (audioInspection.assets.length > 0) {
      const audioPath = path.join(scratchRoot, "audio.wav");
      const mixTiming = startTiming("timeline.audio_mix", { assets: audioInspection.assets.length });
      await mixAudioTimeline({
        clips: audioInspection.assets.map((asset) => ({
          path: asset.path,
          startFrame: asset.clip.startFrame,
          trimStart: asset.clip.trimStart,
          ...(asset.clip.trimDuration !== undefined ? { trimDuration: asset.clip.trimDuration } : {}),
          volume: asset.clip.volume,
          ...(asset.clip.envelopes !== undefined ? { volumeEnvelopes: asset.clip.envelopes } : {}),
        })),
        fps: timeline.format.fps,
        durationSeconds: total / timeline.format.fps,
        outputPath: audioPath,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      mixTiming.finish();
      const muxTiming = startTiming("timeline.mux", { codec, container });
      await muxVideoWithAudio({
        videoPath: tempVideo,
        audioPath,
        outputPath: tempFinal,
        codec,
        container,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      muxTiming.finish();
      finalPath = tempFinal;
    }

    if (!overwrite && (await pathExists(options.outPath))) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Output already exists: ${options.outPath}. Pass --overwrite to replace it.`,
      );
    }
    const publishTiming = startTiming("timeline.publish", { out: options.outPath });
    await publishFile(finalPath, options.outPath, overwrite);
    publishTiming.finish();

    const uniqueDiagnostics = mergeDiagnostics(diagnostics);
    renderTiming.finish({
      segments: plan.segments.length,
      workers,
      codec,
      encoder,
      frames: total,
      outputBytes: (await stat(options.outPath)).size,
    });
    return {
      timeline: options.timelineId,
      entry: timeline.entry,
      path: options.outPath,
      width: timeline.format.width,
      height: timeline.format.height,
      fps: timeline.format.fps,
      durationInFrames: total,
      durationSeconds: total / timeline.format.fps,
      framesRendered: total,
      segments: plan.segments.length,
      workers,
      transitions: timeline.transitions.length,
      codec,
      container,
      encoder,
      bytes: (await stat(options.outPath)).size,
      audio: { clips: audioInspection.clips.length },
      transcripts: { clips: transcripts.clips.length },
      diagnostics: uniqueDiagnostics,
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    await rm(tempVideo, { force: true });
    await rm(tempFinal, { force: true });
    await sessionPool.close();
    try {
      await server.close();
    } catch {
      // Preserve the render's original error.
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}
