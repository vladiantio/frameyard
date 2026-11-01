import { link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CompositionDiagnostic,
  CompositionSourceInfo,
  ResolvedAudioClip,
  ResolvedTranscriptClip,
} from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { validateHtmlComposition, type StaticValidationResult } from "../html/validate.js";
import type { Project } from "../project.js";
import { startPreviewServer } from "../server/server.js";
import { inspectTimelineAudio, type AudioInspection, type InspectAudioClip } from "./audio.js";
import { openCompositionSession, type CompositionSession } from "./browser.js";
import {
  assertFfmpegCapabilities,
  compositeTimelineFrame,
  compositeTimelineSegment,
  concatTimelineSegments,
  encodePngSequenceToFfv1,
  mixAudioTimeline,
  muxVideoWithAudio,
  type TimelineCompositeLayer,
} from "./ffmpeg.js";
import { inspectTranscriptClips, type TranscriptInspection } from "./transcripts.js";
import { planTimelineRender, type TimelineRenderSegment } from "../timeline/plan.js";
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

export interface TimelineStillResult {
  timeline: string;
  entry: string;
  frame: number;
  path: string;
  width: number;
  height: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface TimelineCheckResult {
  timeline: string;
  entry: string;
  format: { width: number; height: number; fps: number };
  durationInFrames: number;
  framesChecked: number;
  tracks: number;
  clips: number;
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

function visualSourceSize(clip: ResolvedTimelineClip, timeline: ResolvedTimeline): { width: number; height: number } {
  const source = clip.source;
  if (source.kind === "composition") {
    return { width: source.metadata.width, height: source.metadata.height };
  }
  if (source.kind === "video" || source.kind === "image") {
    if (source.width === undefined || source.height === undefined) {
      throw new FrameyardError(
        "TIMELINE_MEDIA_INVALID",
        `Media ${source.src} is missing width/height metadata for clip "${clip.id}".`,
      );
    }
    return { width: source.width, height: source.height };
  }
  return { width: timeline.format.width, height: timeline.format.height };
}

interface AudioWindow {
  frameOffset: number;
  startFrame: number;
  endFrame: number;
  gain: number;
  muted: boolean;
}

function mapCompositionAudio(
  clip: ResolvedTimelineClip,
  audio: ResolvedAudioClip,
  fps: number,
  window: AudioWindow,
): ResolvedAudioClip | null {
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

    if (source.kind === "composition") {
      for (const transcript of source.transcriptClips) {
        transcripts.set(`${transcript.src}\u0000${transcript.words}`, transcript);
      }
      if (clipMuted) {
        continue;
      }
      for (const audio of source.audioClips) {
        const mapped = mapCompositionAudio(clip, audio, fps, { ...window, gain: clipGain });
        if (mapped) {
          clips.push(mapped);
        }
      }
      for (const audio of source.embeddedAudioClips) {
        const mapped = mapCompositionAudio(clip, audio, fps, { ...window, gain: clipGain });
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
    { frameOffset: 0, startFrame: 0, endFrame: timeline.durationInFrames, gain: 1, muted: false },
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
      const { allowSilent: _allowSilent, ...resolved } = clip;
      return resolved;
    }),
    transcripts,
  };
}

async function captureCompositionLayer(options: {
  project: Project;
  timeline: ResolvedTimeline;
  clip: ResolvedTimelineClip;
  source: ResolvedCompositionSource;
  segment: TimelineRenderSegment;
  layerIndex: number;
  serverUrl: string;
  segmentDir: string;
  infoCache: Map<string, StaticValidationResult>;
  signal?: AbortSignal;
}): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const { project, timeline, clip, source, segment, layerIndex, serverUrl, segmentDir, infoCache } = options;
  const propsKey = JSON.stringify(clip.props ?? null);
  const cacheKey = `${source.entry}\u0000${propsKey}`;
  let validation = infoCache.get(cacheKey);
  if (!validation) {
    validation = await validateHtmlComposition({
      projectRoot: project.root,
      entry: source.entry,
      ...(clip.props !== undefined ? { props: clip.props } : {}),
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

  const prefix = `comp-${layerIndex}`;
  const session = await openCompositionSession({
    serverUrl,
    entry: source.entry,
    props: clip.props,
    info: validation.info as CompositionSourceInfo,
    staticDiagnostics: validation.diagnostics,
    transparentBackground: true,
  });
  const diagnostics: CompositionDiagnostic[] = [];
  try {
    for (let offset = 0; offset < segment.frames; offset += 1) {
      throwIfAborted(options.signal);
      await session.seek(layer.sourceStart + offset);
      const png = await session.capture();
      await writeFile(path.join(segmentDir, `${prefix}-${String(offset).padStart(4, "0")}.png`), png);
    }
    for (const diagnostic of await session.readDiagnostics()) {
      diagnostics.push(compositionDiagnostic(diagnostic, timeline.id, clip, source.id));
    }
  } finally {
    await session.close();
  }

  const outputPath = path.join(segmentDir, `${prefix}.mkv`);
  await encodePngSequenceToFfv1({
    pattern: path.join(segmentDir, `${prefix}-%04d.png`),
    outputPath,
    fps: timeline.format.fps,
    signal: options.signal,
  });
  return { path: outputPath, diagnostics };
}

async function renderNestedTimelineRange(options: {
  project: Project;
  timeline: ResolvedTimeline;
  startFrame: number;
  frames: number;
  serverUrl: string;
  scratchRoot: string;
  infoCache: Map<string, StaticValidationResult>;
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
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { path: outputPath, diagnostics };
}

async function processTimelineSegment(options: {
  project: Project;
  timeline: ResolvedTimeline;
  segment: TimelineRenderSegment;
  serverUrl: string;
  scratchRoot: string;
  infoCache: Map<string, StaticValidationResult>;
  codec?: "h264" | "ffv1";
  background?: string;
  prefix?: string;
  depth?: number;
  signal?: AbortSignal;
}): Promise<{ path: string; diagnostics: CompositionDiagnostic[] }> {
  const { project, timeline, segment, serverUrl, scratchRoot, infoCache } = options;
  const codec = options.codec ?? "h264";
  const background = options.background ?? (codec === "ffv1" ? "transparent" : (timeline.background ?? "black"));
  const prefix = options.prefix ?? "timeline";
  const depth = options.depth ?? 0;
  const segmentDir = path.join(scratchRoot, `${prefix}-seg-${String(segment.index).padStart(4, "0")}`);
  await mkdir(segmentDir, { recursive: true });
  const diagnostics: CompositionDiagnostic[] = [];
  const layers: TimelineCompositeLayer[] = [];

  for (const [layerIndex, layer] of segment.layers.entries()) {
    throwIfAborted(options.signal);
    const clip = layer.clip;
    const source = clip.source;
    const transform = clip.transform ?? {
      fit: "contain" as const,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
    };
    const base = {
      fit: transform.fit,
      x: transform.x,
      y: transform.y,
      ...(transform.width !== undefined && transform.height !== undefined
        ? { width: transform.width, height: transform.height }
        : {}),
      scale: transform.scale,
      rotation: transform.rotation,
      opacity: transform.opacity,
    };

    if (source.kind === "composition") {
      const captured = await captureCompositionLayer({
        project,
        timeline,
        clip,
        source,
        segment,
        layerIndex,
        serverUrl,
        segmentDir,
        infoCache,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      diagnostics.push(...captured.diagnostics);
      layers.push({
        kind: "composition",
        path: captured.path,
        sourceWidth: source.metadata.width,
        sourceHeight: source.metadata.height,
        ...base,
      });
      continue;
    }

    if (source.kind === "video" || source.kind === "image") {
      const size = visualSourceSize(clip, timeline);
      layers.push({
        kind: source.kind,
        path: source.absolutePath,
        sourceWidth: size.width,
        sourceHeight: size.height,
        ...base,
        ...(source.kind === "video" ? { sourceStartFrame: layer.sourceStart } : {}),
      });
      continue;
    }

    if (source.kind === "timeline") {
      const nested = await renderNestedTimelineRange({
        project,
        timeline: source.timeline,
        startFrame: layer.sourceStart,
        frames: segment.frames,
        serverUrl,
        scratchRoot,
        infoCache,
        depth: depth + 1,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      diagnostics.push(...nested.diagnostics);
      layers.push({
        kind: "timeline",
        path: nested.path,
        sourceWidth: source.timeline.format.width,
        sourceHeight: source.timeline.format.height,
        ...base,
      });
      continue;
    }

    throw new FrameyardError("TIMELINE_INVALID", `Unsupported visual source for clip "${clip.id}".`);
  }

  const extension = codec === "ffv1" ? "mkv" : "mp4";
  const segmentPath = path.join(
    scratchRoot,
    `${prefix}-segment-${String(segment.index).padStart(4, "0")}.${extension}`,
  );
  await compositeTimelineSegment({
    outputPath: segmentPath,
    width: timeline.format.width,
    height: timeline.format.height,
    fps: timeline.format.fps,
    frames: segment.frames,
    background,
    layers,
    codec,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await rm(segmentDir, { recursive: true, force: true });
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
    }

    for (const segment of plan.segments) {
      for (let frame = segment.start; frame < segment.end; frame += 1) {
        throwIfAborted(context.signal);
        for (const layer of segment.layers) {
          if (layer.clip.source.kind !== "composition") {
            continue;
          }
          const source = layer.clip.source;
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
    throw new FrameyardError(
      "TIMELINE_NOT_FOUND",
      `Timeline "${options.timelineId}" is not listed in video.config.js.`,
    );
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
  const plan = planTimelineRender(timeline, { startFrame: frame, endFrame: frame + 1 });
  const segment = plan.segments[0];
  if (!segment) {
    throw new FrameyardError("FRAME_OUT_OF_RANGE", `Frame ${frame} does not belong to a timeline segment.`);
  }

  const diagnostics: CompositionDiagnostic[] = [];
  const layers: TimelineCompositeLayer[] = [];
  for (const [layerIndex, layer] of segment.layers.entries()) {
    const clip = layer.clip;
    const source = clip.source;
    const transform = clip.transform ?? {
      fit: "contain" as const,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
    };
    const base = {
      fit: transform.fit,
      x: transform.x,
      y: transform.y,
      ...(transform.width !== undefined && transform.height !== undefined
        ? { width: transform.width, height: transform.height }
        : {}),
      scale: transform.scale,
      rotation: transform.rotation,
      opacity: transform.opacity,
    };

    if (source.kind === "composition") {
      const validation = await validateHtmlComposition({
        projectRoot: context.project.root,
        entry: source.entry,
        ...(clip.props !== undefined ? { props: clip.props } : {}),
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
      layers.push({
        kind: "image",
        path: framePath,
        sourceWidth: source.metadata.width,
        sourceHeight: source.metadata.height,
        ...base,
      });
      continue;
    }

    if (source.kind === "video" || source.kind === "image") {
      const size = visualSourceSize(clip, timeline);
      layers.push({
        kind: source.kind,
        path: source.absolutePath,
        sourceWidth: size.width,
        sourceHeight: size.height,
        ...base,
        ...(source.kind === "video" ? { sourceStartFrame: layer.sourceStart } : {}),
      });
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
      layers.push({
        kind: "image",
        path: nestedPath,
        sourceWidth: source.timeline.format.width,
        sourceHeight: source.timeline.format.height,
        ...base,
      });
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
    ...(context.signal ? { signal: context.signal } : {}),
  });
  return diagnostics;
}

/** Captures one timeline frame as PNG through the clip capture and composite path. */
export async function captureTimelineStill(options: TimelineStillOptions): Promise<TimelineStillResult> {
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
  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError(
      "TIMELINE_NOT_FOUND",
      `Timeline "${options.timelineId}" is not listed in video.config.js.`,
    );
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
  if (options.frame >= timeline.durationInFrames) {
    throw new FrameyardError(
      "FRAME_OUT_OF_RANGE",
      `Frame ${options.frame} is outside the valid range 0..${timeline.durationInFrames - 1}.`,
    );
  }

  const scratchBase = options.scratchDir ?? tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const scratchRoot = await mkdtemp(path.join(scratchBase, "frameyard-timeline-still-"));
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  const tempPath = path.join(
    path.dirname(options.outPath),
    `.${path.basename(options.outPath)}.frameyard-${process.pid}-${randomUUID()}.png`,
  );

  try {
    const diagnostics = await renderResolvedTimelineFrame({
      timeline,
      frame: options.frame,
      outputPath: tempPath,
      background: timeline.background ?? "black",
      context: {
        project: options.project,
        serverUrl: server.url,
        scratchRoot,
        depth: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    });

    if (!overwrite && (await pathExists(options.outPath))) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Output already exists: ${options.outPath}. Pass --overwrite to replace it.`,
      );
    }
    await publishFile(tempPath, options.outPath, overwrite);

    return {
      timeline: options.timelineId,
      entry: timeline.entry,
      frame: options.frame,
      path: options.outPath,
      width: timeline.format.width,
      height: timeline.format.height,
      diagnostics: mergeDiagnostics(resolved.diagnostics, diagnostics),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    await rm(tempPath, { force: true });
    try {
      await server.close();
    } catch {
      // Preserve the still's original error.
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

/** Renders one timeline to MP4 through the segmented lossless clip pipeline. */
export async function renderTimeline(options: TimelineRenderOptions): Promise<TimelineRenderResult> {
  if (path.extname(options.outPath).toLowerCase() !== ".mp4") {
    throw new FrameyardError("USAGE", `Timeline output must use an .mp4 extension: ${options.outPath}`);
  }

  const workers = validateWorkers(options.workers);
  const overwrite = options.overwrite ?? false;
  await ensureOutputAvailable(options.outPath, overwrite);
  await assertFfmpegCapabilities(options.signal);
  const startedAt = performance.now();

  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError(
      "TIMELINE_NOT_FOUND",
      `Timeline "${options.timelineId}" is not listed in video.config.js.`,
    );
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
  const plan = planTimelineRender(timeline, { maxSegmentFrames: options.maxSegmentFrames });

  const scratchBase = options.scratchDir ?? tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const scratchRoot = await mkdtemp(path.join(scratchBase, "frameyard-timeline-"));
  const server = await startPreviewServer({ projectRoot: options.project.root, port: 0 });
  const infoCache = new Map<string, StaticValidationResult>();
  const diagnostics: CompositionDiagnostic[] = [...resolved.diagnostics];
  const total = timeline.durationInFrames;
  const segmentResults: Array<{ path: string; diagnostics: CompositionDiagnostic[] } | undefined> = Array.from({
    length: plan.segments.length,
  });
  let nextSegment = 0;

  const audio = buildAudioClips(timeline);
  const audioInspection = audio.clips.length
    ? await inspectTimelineAudio({
        projectRoot: options.project.root,
        clips: audio.clips,
        fps: timeline.format.fps,
        durationInFrames: total,
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
    await Promise.all(Array.from({ length: workers }, () => worker()));

    const segmentPaths = segmentResults.map((result) => {
      if (!result) {
        throw new FrameyardError("INTERNAL", "A timeline segment was not rendered.");
      }
      diagnostics.push(...result.diagnostics);
      return result.path;
    });

    await concatTimelineSegments({
      segmentPaths,
      listPath: path.join(scratchRoot, "segments.txt"),
      outputPath: tempVideo,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let finalPath = tempVideo;
    if (audioInspection.assets.length > 0) {
      const audioPath = path.join(scratchRoot, "audio.wav");
      await mixAudioTimeline({
        clips: audioInspection.assets.map((asset) => ({
          path: asset.path,
          startFrame: asset.clip.startFrame,
          trimStart: asset.clip.trimStart,
          ...(asset.clip.trimDuration !== undefined ? { trimDuration: asset.clip.trimDuration } : {}),
          volume: asset.clip.volume,
        })),
        fps: timeline.format.fps,
        durationSeconds: total / timeline.format.fps,
        outputPath: audioPath,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await muxVideoWithAudio({
        videoPath: tempVideo,
        audioPath,
        outputPath: tempFinal,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      finalPath = tempFinal;
    }

    if (!overwrite && (await pathExists(options.outPath))) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Output already exists: ${options.outPath}. Pass --overwrite to replace it.`,
      );
    }
    await publishFile(finalPath, options.outPath, overwrite);

    const uniqueDiagnostics = mergeDiagnostics(diagnostics);
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
      bytes: (await stat(options.outPath)).size,
      audio: { clips: audioInspection.clips.length },
      transcripts: { clips: transcripts.clips.length },
      diagnostics: uniqueDiagnostics,
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    await rm(tempVideo, { force: true });
    await rm(tempFinal, { force: true });
    try {
      await server.close();
    } catch {
      // Preserve the render's original error.
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}
