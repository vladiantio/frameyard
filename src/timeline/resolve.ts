import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CompositionDiagnostic,
  CompositionDiagnosticDetails,
  CompositionMetadata,
  ControllerDeclaration,
  ResolvedAudioClip,
  ResolvedTranscriptClip,
} from "../contracts.js";
import { mergeProps, type Props } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { validateHtmlComposition, type StaticValidationResult } from "../html/validate.js";
import type { Project, ProjectFormat, ProjectTimeline } from "../project.js";
import { probeMedia, type ProbeResult } from "../renderer/ffmpeg.js";
import { parseTimelineDocument, type TimelineClip, type TimelineDocument, type TimelineTrack } from "./schema.js";

export interface ResolvedCompositionSource {
  kind: "composition";
  id: string;
  entry: string;
  metadata: CompositionMetadata;
  controller: ControllerDeclaration | null;
  durationInFrames: number;
  audioClips: readonly ResolvedAudioClip[];
  embeddedAudioClips: readonly ResolvedAudioClip[];
  transcriptClips: readonly ResolvedTranscriptClip[];
}

export interface ResolvedNestedTimelineSource {
  kind: "timeline";
  id: string;
  entry: string;
  durationInFrames: number;
  timeline: ResolvedTimeline;
}

export interface ResolvedMediaSource {
  kind: "video" | "image" | "audio";
  src: string;
  absolutePath: string;
  durationInFrames?: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export type ResolvedTimelineSource = ResolvedCompositionSource | ResolvedNestedTimelineSource | ResolvedMediaSource;

export interface ResolvedTimelineClip extends Omit<TimelineClip, "source" | "duration"> {
  source: ResolvedTimelineSource;
  duration: number;
  end: number;
}

export interface ResolvedTimeline {
  id: string;
  entry: string;
  name?: string;
  background?: string;
  format: ProjectFormat;
  durationInFrames: number;
  tracks: TimelineTrack[];
  clips: ResolvedTimelineClip[];
}

export interface ResolveTimelineResult {
  timeline: ResolvedTimeline | null;
  diagnostics: CompositionDiagnostic[];
}

interface ResolveContext {
  /** Timeline currently being resolved. */
  timelineId: string;
  /** Timeline IDs currently being resolved, including the current timeline. */
  stack: string[];
  /** Clip IDs from outermost to current timeline. */
  nesting: string[];
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, "video" | "image" | "audio"> = {
  ".mp4": "video",
  ".webm": "video",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".wav": "audio",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aac": "audio",
};

function diagnosticKey(diagnostic: CompositionDiagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
}

function dedupeDiagnostics(diagnostics: readonly CompositionDiagnostic[]): CompositionDiagnostic[] {
  const seen = new Set<string>();
  const result: CompositionDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

function withContext(
  diagnostic: CompositionDiagnostic,
  context: {
    timeline?: string;
    clip?: string;
    track?: string;
    composition?: string;
    nestedTimeline?: string;
    media?: string;
    nesting?: string[];
  },
): CompositionDiagnostic {
  const details: CompositionDiagnosticDetails = { ...diagnostic.details };
  if (context.timeline !== undefined && details.timeline === undefined) {
    details.timeline = context.timeline;
  }
  if (context.clip !== undefined && details.clip === undefined) {
    details.clip = context.clip;
  }
  if (context.track !== undefined && details.track === undefined) {
    details.track = context.track;
  }
  if (context.composition !== undefined && details.composition === undefined) {
    details.composition = context.composition;
  }
  if (context.nestedTimeline !== undefined && details.nestedTimeline === undefined) {
    details.nestedTimeline = context.nestedTimeline;
  }
  if (context.media !== undefined && details.media === undefined) {
    details.media = context.media;
  }
  if (context.nesting !== undefined && details.nesting === undefined) {
    details.nesting = context.nesting;
  }
  return { ...diagnostic, details };
}

function addError(
  diagnostics: CompositionDiagnostic[],
  code: CompositionDiagnostic["code"],
  message: string,
  details: CompositionDiagnosticDetails,
): void {
  diagnostics.push({ severity: "error", code, message, details });
}

function addWarning(
  diagnostics: CompositionDiagnostic[],
  message: string,
  details: CompositionDiagnosticDetails,
): void {
  diagnostics.push({ severity: "warning", code: "TIMELINE_WARNING", message, details });
}

function jsonErrorLocation(source: string, error: unknown): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const explicit = /line (\d+) column (\d+)/i.exec(message);
  if (explicit) {
    return { line: Number(explicit[1]), column: Number(explicit[2]) };
  }
  const position = /position (\d+)/i.exec(message);
  if (!position) {
    return undefined;
  }
  const offset = Number(position[1]);
  const before = source.slice(0, offset);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function mediaKindFromExtension(src: string): "video" | "image" | "audio" | undefined {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(src).toLowerCase()];
}

function numberFrom(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

interface MediaProbeEntry {
  probe?: ProbeResult;
  error?: string;
}

async function probeMediaCached(
  absolutePath: string,
  cache: Map<string, MediaProbeEntry>,
  signal?: AbortSignal,
): Promise<MediaProbeEntry> {
  const cached = cache.get(absolutePath);
  if (cached) {
    return cached;
  }
  try {
    const probe = await probeMedia(absolutePath, { signal });
    const entry = { probe };
    cache.set(absolutePath, entry);
    return entry;
  } catch (error) {
    const entry = {
      error: error instanceof FrameyardError ? error.message : error instanceof Error ? error.message : String(error),
    };
    cache.set(absolutePath, entry);
    return entry;
  }
}

async function resolveMediaSource(options: {
  project: Project;
  timelineId: string;
  clip: TimelineClip;
  diagnostics: CompositionDiagnostic[];
  probeCache: Map<string, MediaProbeEntry>;
  signal?: AbortSignal;
}): Promise<ResolvedMediaSource | null> {
  const { project, timelineId, clip, diagnostics, probeCache } = options;
  const source = clip.source;
  if (source.kind !== "video" && source.kind !== "image" && source.kind !== "audio") {
    return null;
  }

  const details: CompositionDiagnosticDetails = {
    timeline: timelineId,
    clip: clip.id,
    track: clip.track,
    media: source.src,
  };
  if (sourceInDetails(clip)) {
    details.sourceFrame = clip.sourceIn;
  }

  const absolutePath = path.resolve(project.root, source.src);
  if (!contains(project.root, absolutePath)) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Media path escapes the project root: ${source.src}`, details);
    return null;
  }

  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Media file does not exist: ${source.src}`, details);
    return null;
  }
  if (!fileStat.isFile()) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Media path is not a file: ${source.src}`, details);
    return null;
  }

  const extensionKind = mediaKindFromExtension(source.src);
  if (
    extensionKind &&
    ((source.kind === "audio" && extensionKind === "image") ||
      (source.kind !== "audio" && extensionKind !== source.kind))
  ) {
    addError(
      diagnostics,
      "TIMELINE_MEDIA_INVALID",
      `Clip source kind "${source.kind}" does not match the media extension for ${source.src}.`,
      details,
    );
    return null;
  }

  const probed = await probeMediaCached(absolutePath, probeCache, options.signal);
  if (!probed.probe) {
    addError(
      diagnostics,
      "TIMELINE_MEDIA_INVALID",
      `Could not inspect media ${source.src}: ${probed.error ?? "unknown error"}`,
      details,
    );
    return null;
  }

  const streams = probed.probe.streams;
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const hasVideo = Boolean(videoStream);
  const hasAudio = Boolean(audioStream);
  const width = videoStream?.width;
  const height = videoStream?.height;

  if (source.kind === "video" && !hasVideo) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Video source has no video stream: ${source.src}`, details);
    return null;
  }
  if (source.kind === "image" && !hasVideo) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Image source has no image stream: ${source.src}`, details);
    return null;
  }
  if (source.kind === "audio" && !hasAudio) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Audio source has no audio stream: ${source.src}`, details);
    return null;
  }
  if (source.kind === "video" && !hasAudio) {
    addWarning(diagnostics, `Video ${source.src} has no audio stream; its audio was not mixed.`, details);
  }

  if (source.kind === "image") {
    return {
      kind: "image",
      src: source.src,
      absolutePath,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      hasVideo,
      hasAudio,
    };
  }

  const durationSeconds =
    numberFrom(probed.probe.format?.duration) ??
    Math.max(
      0,
      ...streams
        .filter((stream) => stream.codec_type === (source.kind === "audio" ? "audio" : "video"))
        .map((stream) => numberFrom(stream.duration) ?? 0),
    );
  if (!durationSeconds || durationSeconds <= 0) {
    addError(diagnostics, "TIMELINE_MEDIA_INVALID", `Media duration could not be determined: ${source.src}`, details);
    return null;
  }

  const durationInFrames = Math.max(1, Math.floor(durationSeconds * project.format!.fps + 1e-6));
  return {
    kind: source.kind,
    src: source.src,
    absolutePath,
    durationInFrames,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    hasVideo,
    hasAudio,
  };
}

function sourceInDetails(clip: TimelineClip): boolean {
  return clip.sourceIn > 0;
}

async function resolveCompositionSource(options: {
  project: Project;
  timelineId: string;
  clip: TimelineClip;
  sourceId: string;
  diagnostics: CompositionDiagnostic[];
  cache: Map<string, StaticValidationResult>;
  nesting: string[];
}): Promise<ResolvedCompositionSource | null> {
  const { project, timelineId, clip, sourceId, diagnostics, cache, nesting } = options;
  const composition = project.compositions.get(sourceId);
  const details: CompositionDiagnosticDetails = {
    timeline: timelineId,
    clip: clip.id,
    track: clip.track,
    composition: sourceId,
    nesting,
  };

  if (!composition) {
    addError(
      diagnostics,
      "TIMELINE_REFERENCE_NOT_FOUND",
      `Composition "${sourceId}" is not listed in video.config.js.`,
      details,
    );
    return null;
  }

  const propsKey = JSON.stringify(clip.props ?? null);
  const cacheKey = `${composition.entry}\u0000${propsKey}`;
  let validation = cache.get(cacheKey);
  if (!validation) {
    validation = await validateHtmlComposition({
      projectRoot: project.root,
      entry: composition.entry,
      ...(clip.props !== undefined ? { props: clip.props } : {}),
    });
    cache.set(cacheKey, validation);
  }

  for (const diagnostic of validation.diagnostics) {
    diagnostics.push(
      withContext(diagnostic, {
        timeline: timelineId,
        clip: clip.id,
        track: clip.track,
        composition: sourceId,
        nesting,
      }),
    );
  }

  if (!validation.info) {
    addError(
      diagnostics,
      "TIMELINE_CLIP_INVALID",
      `Composition "${sourceId}" could not be loaded for clip "${clip.id}".`,
      details,
    );
    return null;
  }

  if (validation.info.metadata.fps !== project.format?.fps) {
    addError(
      diagnostics,
      "TIMELINE_FPS_MISMATCH",
      `Composition "${sourceId}" runs at ${validation.info.metadata.fps} fps, but the project format is ${project.format?.fps} fps.`,
      details,
    );
  }

  return {
    kind: "composition",
    id: sourceId,
    entry: composition.entry,
    metadata: validation.info.metadata,
    controller: validation.info.controller,
    durationInFrames: validation.info.metadata.durationInFrames,
    audioClips: validation.info.audioClips,
    embeddedAudioClips: validation.info.embeddedAudioClips,
    transcriptClips: validation.info.transcriptClips,
  };
}

async function resolveTimelineSource(options: {
  project: Project;
  clip: TimelineClip;
  sourceId: string;
  diagnostics: CompositionDiagnostic[];
  context: ResolveContext;
  signal?: AbortSignal;
  probeCache: Map<string, MediaProbeEntry>;
  compositionCache: Map<string, StaticValidationResult>;
}): Promise<ResolvedNestedTimelineSource | null> {
  const { project, clip, sourceId, diagnostics, context, signal, probeCache, compositionCache } = options;
  const nested = project.timelines.get(sourceId);
  const details: CompositionDiagnosticDetails = {
    timeline: context.timelineId,
    clip: clip.id,
    track: clip.track,
    nestedTimeline: sourceId,
    nesting: context.nesting,
  };

  if (!nested) {
    addError(
      diagnostics,
      "TIMELINE_REFERENCE_NOT_FOUND",
      `Timeline "${sourceId}" is not listed in video.config.js.`,
      details,
    );
    return null;
  }
  if (context.stack.includes(sourceId)) {
    addError(
      diagnostics,
      "TIMELINE_CYCLE",
      `Timeline cycle detected: ${[...context.stack, sourceId].join(" → ")}.`,
      details,
    );
    return null;
  }

  const nestedResult = await resolveTimelineInternal({
    project,
    timeline: nested,
    context: {
      timelineId: sourceId,
      stack: [...context.stack, sourceId],
      nesting: [...context.nesting, clip.id],
    },
    ...(signal ? { signal } : {}),
    probeCache,
    compositionCache,
  });
  for (const diagnostic of nestedResult.diagnostics) {
    diagnostics.push(diagnostic);
  }
  if (!nestedResult.timeline) {
    addError(
      diagnostics,
      "TIMELINE_CLIP_INVALID",
      `Nested timeline "${sourceId}" could not be resolved for clip "${clip.id}".`,
      details,
    );
    return null;
  }

  return {
    kind: "timeline",
    id: sourceId,
    entry: nested.entry,
    durationInFrames: nestedResult.timeline.durationInFrames,
    timeline: nestedResult.timeline,
  };
}

async function resolveClipSource(options: {
  project: Project;
  clip: TimelineClip;
  diagnostics: CompositionDiagnostic[];
  context: ResolveContext;
  signal?: AbortSignal;
  probeCache: Map<string, MediaProbeEntry>;
  compositionCache: Map<string, StaticValidationResult>;
}): Promise<ResolvedTimelineSource | null> {
  const { project, clip, diagnostics, context, signal, probeCache, compositionCache } = options;
  const source = clip.source;

  if (source.kind === "composition") {
    return resolveCompositionSource({
      project,
      timelineId: context.timelineId,
      clip,
      sourceId: source.id,
      diagnostics,
      cache: compositionCache,
      nesting: context.nesting,
    });
  }
  if (source.kind === "timeline") {
    return resolveTimelineSource({
      project,
      clip,
      sourceId: source.id,
      diagnostics,
      context,
      ...(signal ? { signal } : {}),
      probeCache,
      compositionCache,
    });
  }
  return resolveMediaSource({
    project,
    timelineId: context.timelineId,
    clip,
    diagnostics,
    probeCache,
    ...(signal ? { signal } : {}),
  });
}

async function readTimelineDocument(
  timeline: ProjectTimeline,
  diagnostics: CompositionDiagnostic[],
  context: ResolveContext,
): Promise<TimelineDocument | null> {
  let source: string;
  try {
    source = await readFile(timeline.absoluteEntry, "utf8");
  } catch {
    addError(diagnostics, "TIMELINE_NOT_FOUND", `Timeline document does not exist: ${timeline.entry}`, {
      path: timeline.entry,
      timeline: timeline.id,
      nesting: context.nesting,
    });
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const location = jsonErrorLocation(source, error);
    addError(
      diagnostics,
      "TIMELINE_INVALID",
      `Could not parse timeline JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        path: timeline.entry,
        timeline: timeline.id,
        nesting: context.nesting,
        ...(location ? { line: location.line, column: location.column } : {}),
      },
    );
    return null;
  }

  const parsed = parseTimelineDocument(value, { path: timeline.entry, timeline: timeline.id });
  for (const diagnostic of parsed.diagnostics) {
    diagnostics.push(withContext(diagnostic, { nesting: context.nesting }));
  }
  return parsed.timeline;
}

function resolveClipDuration(
  clip: TimelineClip,
  source: ResolvedTimelineSource,
  diagnostics: CompositionDiagnostic[],
  timelineId: string,
  nesting: string[],
): number | null {
  const details: CompositionDiagnosticDetails = {
    timeline: timelineId,
    clip: clip.id,
    track: clip.track,
    nesting,
    jsonPath: "$.clips",
  };
  const sourceDuration = source.kind === "image" ? undefined : source.durationInFrames;

  if (clip.duration === undefined) {
    if (sourceDuration === undefined) {
      addError(
        diagnostics,
        "TIMELINE_CLIP_OUT_OF_RANGE",
        `Clip "${clip.id}" needs an explicit duration because its source has no duration.`,
        details,
      );
      return null;
    }
    const remaining = sourceDuration - clip.sourceIn;
    if (remaining <= 0) {
      addError(
        diagnostics,
        "TIMELINE_CLIP_OUT_OF_RANGE",
        `Clip "${clip.id}" starts at source frame ${clip.sourceIn}, beyond the source duration ${sourceDuration}.`,
        details,
      );
      return null;
    }
    return remaining;
  }

  if (sourceDuration !== undefined && clip.sourceIn + clip.duration > sourceDuration) {
    addError(
      diagnostics,
      "TIMELINE_CLIP_OUT_OF_RANGE",
      `Clip "${clip.id}" uses source frames ${clip.sourceIn}..${clip.sourceIn + clip.duration}, beyond the source duration ${sourceDuration}.`,
      details,
    );
    return null;
  }
  return clip.duration;
}

async function resolveTimelineInternal(options: {
  project: Project;
  timeline: ProjectTimeline;
  context: ResolveContext;
  signal?: AbortSignal;
  probeCache: Map<string, MediaProbeEntry>;
  compositionCache: Map<string, StaticValidationResult>;
  propsOverrides?: Record<string, unknown>;
}): Promise<ResolveTimelineResult> {
  const { project, timeline, context, signal, probeCache, compositionCache, propsOverrides } = options;
  const diagnostics: CompositionDiagnostic[] = [];
  const document = await readTimelineDocument(timeline, diagnostics, context);
  if (!document) {
    return { timeline: null, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  if (!project.format) {
    addError(diagnostics, "TIMELINE_INVALID", "A project format is required to resolve timelines.", {
      path: timeline.entry,
      timeline: timeline.id,
      nesting: context.nesting,
    });
    return { timeline: null, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const clips: ResolvedTimelineClip[] = [];
  const usedOverrides = new Set<string>();
  for (const rawClip of document.clips) {
    let clip = rawClip;
    if (propsOverrides && rawClip.source.kind === "composition" && propsOverrides[rawClip.id] !== undefined) {
      try {
        const merged = mergeProps(rawClip.props, propsOverrides[rawClip.id]) as Props;
        clip = { ...rawClip, props: merged };
        usedOverrides.add(rawClip.id);
      } catch (error) {
        addError(
          diagnostics,
          "PROPS_INVALID",
          `Props override for clip "${rawClip.id}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
          { timeline: timeline.id, clip: rawClip.id, track: rawClip.track, nesting: context.nesting },
        );
        continue;
      }
    }
    const clipDiagnostics: CompositionDiagnostic[] = [];
    const source = await resolveClipSource({
      project,
      clip,
      diagnostics: clipDiagnostics,
      context,
      ...(signal ? { signal } : {}),
      probeCache,
      compositionCache,
    });
    diagnostics.push(...clipDiagnostics);
    if (!source) {
      continue;
    }

    const duration = resolveClipDuration(clip, source, diagnostics, context.timelineId, context.nesting);
    if (duration === null) {
      continue;
    }

    clips.push({
      ...clip,
      source,
      duration,
      end: clip.start + duration,
    });
  }

  if (propsOverrides) {
    for (const key of Object.keys(propsOverrides)) {
      if (!usedOverrides.has(key)) {
        addError(
          diagnostics,
          "PROPS_INVALID",
          `Props override targets "${key}", which is not a composition clip in this timeline.`,
          { timeline: timeline.id, clip: key, nesting: context.nesting },
        );
      }
    }
  }

  const maxEnd = clips.reduce((end, clip) => Math.max(end, clip.end), 0);
  const durationInFrames = document.durationInFrames ?? maxEnd;
  if (document.durationInFrames !== undefined && document.durationInFrames < maxEnd) {
    addError(
      diagnostics,
      "TIMELINE_DURATION_INVALID",
      `Timeline durationInFrames ${document.durationInFrames} is shorter than the resolved clip end ${maxEnd}.`,
      { timeline: timeline.id, nesting: context.nesting, jsonPath: "$.durationInFrames" },
    );
  }

  for (const track of document.tracks) {
    const trackClips = clips.filter((clip) => clip.track === track.id).sort((left, right) => left.start - right.start);
    for (let index = 1; index < trackClips.length; index += 1) {
      const previous = trackClips[index - 1] as ResolvedTimelineClip;
      const current = trackClips[index] as ResolvedTimelineClip;
      if (current.start < previous.end) {
        addError(
          diagnostics,
          "TIMELINE_CLIP_OVERLAP",
          `Clip "${current.id}" overlaps "${previous.id}" on track "${track.id}".`,
          {
            timeline: timeline.id,
            track: track.id,
            clip: current.id,
            nesting: context.nesting,
            suggestion: "No two clips on one track may overlap in 0.6.",
          },
        );
      }
    }
  }

  if (clips.length === 0) {
    addError(diagnostics, "TIMELINE_INVALID", "Timeline has no resolvable clips.", {
      path: timeline.entry,
      timeline: timeline.id,
      nesting: context.nesting,
    });
  }

  const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
  if (uniqueDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { timeline: null, diagnostics: uniqueDiagnostics };
  }

  return {
    timeline: {
      id: timeline.id,
      entry: timeline.entry,
      ...(document.name !== undefined ? { name: document.name } : {}),
      ...(document.background !== undefined ? { background: document.background } : {}),
      format: project.format,
      durationInFrames,
      tracks: document.tracks,
      clips,
    },
    diagnostics: uniqueDiagnostics,
  };
}

/** Resolves a project timeline, its references, media, and nested timelines. */
export async function resolveProjectTimeline(options: {
  project: Project;
  timeline: ProjectTimeline;
  signal?: AbortSignal;
  /** Render-time props overrides keyed by top-level composition clip ID. */
  propsOverrides?: Record<string, unknown>;
}): Promise<ResolveTimelineResult> {
  return resolveTimelineInternal({
    project: options.project,
    timeline: options.timeline,
    context: { timelineId: options.timeline.id, stack: [options.timeline.id], nesting: [] },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.propsOverrides ? { propsOverrides: options.propsOverrides } : {}),
    probeCache: new Map(),
    compositionCache: new Map(),
  });
}
