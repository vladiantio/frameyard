import {
  assertJsonSerializable,
  isPlainObject,
  type CompositionDiagnostic,
  type CompositionDiagnosticDetails,
  type Props,
} from "../contracts.js";
import type { FrameyardErrorCode } from "../errors.js";

export type TimelineTrackKind = "video" | "audio";
export type TimelineSourceKind = "composition" | "timeline" | "video" | "image" | "audio";
export type FitPolicy = "contain" | "cover" | "stretch";

export interface TimelineSourceComposition {
  kind: "composition";
  id: string;
}

export interface TimelineSourceTimeline {
  kind: "timeline";
  id: string;
}

export interface TimelineSourceMedia {
  kind: "video" | "image" | "audio";
  src: string;
}

export type TimelineSource = TimelineSourceComposition | TimelineSourceTimeline | TimelineSourceMedia;

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  name?: string;
  gain?: number;
  muted?: boolean;
}

export interface TimelineTransform {
  fit: FitPolicy;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface TimelineClipAudio {
  muted: boolean;
  gain: number;
}

export interface TimelineClip {
  id: string;
  track: string;
  source: TimelineSource;
  start: number;
  /** Omitted durations resolve from the source; images always declare one. */
  duration?: number;
  sourceIn: number;
  props?: Props;
  transform?: TimelineTransform;
  audio?: TimelineClipAudio;
}

export interface TimelineDocument {
  version: 1;
  name?: string;
  durationInFrames?: number;
  background?: string;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

export interface ParseTimelineResult {
  timeline: TimelineDocument | null;
  diagnostics: CompositionDiagnostic[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLocalPath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !SCHEME.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.split(/[\\/]/).includes("..")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function jsonPath(base: string, key: string | number): string {
  return typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;
}

interface DiagnosticContext {
  path?: string;
  timeline?: string;
}

function makeDiagnostic(
  context: DiagnosticContext,
  severity: CompositionDiagnostic["severity"],
  code: FrameyardErrorCode,
  message: string,
  path: string,
  details: Omit<CompositionDiagnosticDetails, "path" | "jsonPath" | "timeline"> = {},
): CompositionDiagnostic {
  const merged: CompositionDiagnosticDetails = {
    ...(context.path !== undefined ? { path: context.path } : {}),
    ...(context.timeline !== undefined ? { timeline: context.timeline } : {}),
    jsonPath: path,
    ...details,
  };
  return { severity, code, message, details: merged };
}

function parseTransform(
  value: unknown,
  path: string,
  add: (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details?: Partial<CompositionDiagnosticDetails>,
  ) => void,
): TimelineTransform {
  const defaults: TimelineTransform = { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  if (!isPlainObject(value)) {
    add("TIMELINE_CLIP_INVALID", "Clip transform must be an object.", path);
    return defaults;
  }

  for (const key of unknownKeys(value, ["fit", "x", "y", "scale", "rotation", "opacity"])) {
    add("TIMELINE_CLIP_INVALID", `Unknown clip transform field "${key}".`, jsonPath(path, key));
  }

  const transform = { ...defaults };
  if (value.fit !== undefined) {
    if (value.fit !== "contain" && value.fit !== "cover" && value.fit !== "stretch") {
      add(
        "TIMELINE_CLIP_INVALID",
        'Clip transform.fit must be "contain", "cover", or "stretch".',
        jsonPath(path, "fit"),
      );
    } else {
      transform.fit = value.fit;
    }
  }
  for (const key of ["x", "y", "scale", "rotation", "opacity"] as const) {
    const field = value[key];
    if (field === undefined) {
      continue;
    }
    if (!isFiniteNumber(field)) {
      add("TIMELINE_CLIP_INVALID", `Clip transform.${key} must be a finite number.`, jsonPath(path, key));
      continue;
    }
    if (key === "scale" && field < 0) {
      add("TIMELINE_CLIP_INVALID", "Clip transform.scale must be zero or greater.", jsonPath(path, key));
      continue;
    }
    if (key === "opacity" && (field < 0 || field > 1)) {
      add("TIMELINE_CLIP_INVALID", "Clip transform.opacity must be between 0 and 1.", jsonPath(path, key));
      continue;
    }
    transform[key] = field;
  }
  return transform;
}

function parseAudio(
  value: unknown,
  path: string,
  add: (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details?: Partial<CompositionDiagnosticDetails>,
  ) => void,
): TimelineClipAudio {
  const defaults: TimelineClipAudio = { muted: false, gain: 1 };
  if (!isPlainObject(value)) {
    add("TIMELINE_CLIP_INVALID", "Clip audio must be an object.", path);
    return defaults;
  }
  for (const key of unknownKeys(value, ["muted", "gain"])) {
    add("TIMELINE_CLIP_INVALID", `Unknown clip audio field "${key}".`, jsonPath(path, key));
  }
  if (value.muted !== undefined) {
    if (typeof value.muted !== "boolean") {
      add("TIMELINE_CLIP_INVALID", "Clip audio.muted must be a boolean.", jsonPath(path, "muted"));
    } else {
      defaults.muted = value.muted;
    }
  }
  if (value.gain !== undefined) {
    if (!isFiniteNumber(value.gain) || value.gain < 0 || value.gain > 1) {
      add("TIMELINE_CLIP_INVALID", "Clip audio.gain must be between 0 and 1.", jsonPath(path, "gain"));
    } else {
      defaults.gain = value.gain;
    }
  }
  return defaults;
}

function parseSource(
  value: unknown,
  path: string,
  add: (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details?: Partial<CompositionDiagnosticDetails>,
  ) => void,
): TimelineSource | null {
  if (!isPlainObject(value)) {
    add("TIMELINE_CLIP_INVALID", "Clip source must be an object.", path);
    return null;
  }

  const kind = value.kind;
  if (kind === "composition" || kind === "timeline") {
    for (const key of unknownKeys(value, ["kind", "id"])) {
      add("TIMELINE_CLIP_INVALID", `Unknown ${kind} source field "${key}".`, jsonPath(path, key));
    }
    if (!isNonEmptyString(value.id) || !ID_PATTERN.test(value.id)) {
      add("TIMELINE_CLIP_INVALID", `Clip ${kind} source.id must be a valid project id.`, jsonPath(path, "id"));
      return null;
    }
    return kind === "composition" ? { kind, id: value.id } : { kind, id: value.id };
  }

  if (kind === "video" || kind === "image" || kind === "audio") {
    for (const key of unknownKeys(value, ["kind", "src"])) {
      add("TIMELINE_CLIP_INVALID", `Unknown ${kind} source field "${key}".`, jsonPath(path, key));
    }
    if (!isLocalPath(value.src)) {
      add(
        "TIMELINE_CLIP_INVALID",
        `Clip ${kind} source.src must be a local project-relative path.`,
        jsonPath(path, "src"),
      );
      return null;
    }
    return { kind, src: value.src };
  }

  add(
    "TIMELINE_CLIP_INVALID",
    'Clip source.kind must be "composition", "timeline", "video", "image", or "audio".',
    jsonPath(path, "kind"),
  );
  return null;
}

function isVisualSource(source: TimelineSource): boolean {
  return (
    source.kind === "composition" || source.kind === "timeline" || source.kind === "video" || source.kind === "image"
  );
}

function isAudioBearingSource(source: TimelineSource): boolean {
  return source.kind !== "image";
}

/** Parses and normalizes a timeline JSON document without touching the filesystem. */
export function parseTimelineDocument(value: unknown, context: DiagnosticContext = {}): ParseTimelineResult {
  const diagnostics: CompositionDiagnostic[] = [];
  const add = (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details: Partial<CompositionDiagnosticDetails> = {},
  ): void => {
    diagnostics.push(makeDiagnostic(context, "error", code, message, path, details));
  };

  if (!isPlainObject(value)) {
    add("TIMELINE_INVALID", "Timeline document must be a JSON object.", "$");
    return { timeline: null, diagnostics };
  }

  for (const key of unknownKeys(value, ["version", "name", "durationInFrames", "background", "tracks", "clips"])) {
    add("TIMELINE_INVALID", `Unknown timeline field "${key}".`, jsonPath("$", key));
  }

  if (value.version !== 1) {
    add("TIMELINE_INVALID", "Timeline version must be 1.", "$.version");
  }

  if (value.name !== undefined && !isNonEmptyString(value.name)) {
    add("TIMELINE_INVALID", "Timeline name must be a non-empty string.", "$.name");
  }
  if (value.background !== undefined && !isNonEmptyString(value.background)) {
    add("TIMELINE_INVALID", "Timeline background must be a non-empty string.", "$.background");
  }
  if (value.durationInFrames !== undefined) {
    if (!isInteger(value.durationInFrames) || value.durationInFrames <= 0) {
      add("TIMELINE_DURATION_INVALID", "Timeline durationInFrames must be a positive integer.", "$.durationInFrames");
    }
  }

  if (!Array.isArray(value.tracks) || value.tracks.length === 0) {
    add("TIMELINE_INVALID", "Timeline tracks must be a non-empty array.", "$.tracks");
    return { timeline: null, diagnostics };
  }
  if (!Array.isArray(value.clips) || value.clips.length === 0) {
    add("TIMELINE_INVALID", "Timeline clips must be a non-empty array.", "$.clips");
    return { timeline: null, diagnostics };
  }

  const tracks: TimelineTrack[] = [];
  const trackById = new Map<string, TimelineTrack>();
  for (const [index, rawTrack] of value.tracks.entries()) {
    const path = `$.tracks[${index}]`;
    if (!isPlainObject(rawTrack)) {
      add("TIMELINE_TRACK_INVALID", "Track must be an object.", path);
      continue;
    }
    for (const key of unknownKeys(rawTrack, ["id", "kind", "name", "gain", "muted"])) {
      add("TIMELINE_TRACK_INVALID", `Unknown track field "${key}".`, jsonPath(path, key));
    }
    if (!isNonEmptyString(rawTrack.id) || !ID_PATTERN.test(rawTrack.id)) {
      add("TIMELINE_TRACK_INVALID", "Track id must be a valid project id.", jsonPath(path, "id"));
      continue;
    }
    if (trackById.has(rawTrack.id)) {
      add("TIMELINE_TRACK_INVALID", `Duplicate track id "${rawTrack.id}".`, jsonPath(path, "id"), {
        track: rawTrack.id,
      });
      continue;
    }
    if (rawTrack.kind !== "video" && rawTrack.kind !== "audio") {
      add("TIMELINE_TRACK_INVALID", 'Track kind must be "video" or "audio".', jsonPath(path, "kind"), {
        track: rawTrack.id,
      });
      continue;
    }
    if (rawTrack.name !== undefined && !isNonEmptyString(rawTrack.name)) {
      add("TIMELINE_TRACK_INVALID", "Track name must be a non-empty string.", jsonPath(path, "name"), {
        track: rawTrack.id,
      });
    }
    if (rawTrack.kind === "video" && (rawTrack.gain !== undefined || rawTrack.muted !== undefined)) {
      add("TIMELINE_TRACK_INVALID", "Video tracks do not support gain or muted.", path, { track: rawTrack.id });
    }
    if (rawTrack.gain !== undefined && (!isFiniteNumber(rawTrack.gain) || rawTrack.gain < 0 || rawTrack.gain > 1)) {
      add("TIMELINE_TRACK_INVALID", "Audio track gain must be between 0 and 1.", jsonPath(path, "gain"), {
        track: rawTrack.id,
      });
    }
    if (rawTrack.muted !== undefined && typeof rawTrack.muted !== "boolean") {
      add("TIMELINE_TRACK_INVALID", "Audio track muted must be a boolean.", jsonPath(path, "muted"), {
        track: rawTrack.id,
      });
    }

    const trackId = rawTrack.id;
    const trackKind = rawTrack.kind;
    const trackName = isNonEmptyString(rawTrack.name) ? rawTrack.name : undefined;
    const trackGain = trackKind === "audio" && isFiniteNumber(rawTrack.gain) ? rawTrack.gain : undefined;
    const trackMuted = trackKind === "audio" && typeof rawTrack.muted === "boolean" ? rawTrack.muted : undefined;
    const track: TimelineTrack = {
      id: trackId,
      kind: trackKind,
      ...(trackName !== undefined ? { name: trackName } : {}),
      ...(trackKind === "audio" ? { gain: trackGain ?? 1 } : {}),
      ...(trackKind === "audio" ? { muted: trackMuted ?? false } : {}),
    };
    tracks.push(track);
    trackById.set(track.id, track);
  }

  const clips: TimelineClip[] = [];
  const clipIds = new Set<string>();
  for (const [index, rawClip] of value.clips.entries()) {
    const path = `$.clips[${index}]`;
    if (!isPlainObject(rawClip)) {
      add("TIMELINE_CLIP_INVALID", "Clip must be an object.", path);
      continue;
    }

    const clipId = isNonEmptyString(rawClip.id) ? rawClip.id : null;
    const details: Partial<CompositionDiagnosticDetails> = clipId ? { clip: clipId } : {};
    for (const key of unknownKeys(rawClip, [
      "id",
      "track",
      "source",
      "start",
      "duration",
      "sourceIn",
      "props",
      "transform",
      "audio",
    ])) {
      add("TIMELINE_CLIP_INVALID", `Unknown clip field "${key}".`, jsonPath(path, key), details);
    }
    if (!clipId || !ID_PATTERN.test(clipId)) {
      add("TIMELINE_CLIP_INVALID", "Clip id must be a valid project id.", jsonPath(path, "id"), details);
      continue;
    }
    if (clipIds.has(clipId)) {
      add("TIMELINE_CLIP_INVALID", `Duplicate clip id "${clipId}".`, jsonPath(path, "id"), details);
      continue;
    }
    clipIds.add(clipId);

    const trackId = isNonEmptyString(rawClip.track) ? rawClip.track : null;
    if (!trackId || !trackById.has(trackId)) {
      add("TIMELINE_CLIP_INVALID", `Clip track must reference a declared track.`, jsonPath(path, "track"), details);
      continue;
    }
    const track = trackById.get(trackId) as TimelineTrack;
    const clipDetails = { ...details, track: trackId };

    const source = parseSource(rawClip.source, jsonPath(path, "source"), (code, message, errorPath, errorDetails) => {
      add(code, message, errorPath, { ...clipDetails, ...errorDetails });
    });
    if (!source) {
      continue;
    }

    if (!isInteger(rawClip.start) || rawClip.start < 0) {
      add("TIMELINE_CLIP_INVALID", "Clip start must be a non-negative integer.", jsonPath(path, "start"), clipDetails);
    }
    const start = isInteger(rawClip.start) && rawClip.start >= 0 ? rawClip.start : 0;

    if (rawClip.duration !== undefined && (!isInteger(rawClip.duration) || rawClip.duration <= 0)) {
      add(
        "TIMELINE_CLIP_INVALID",
        "Clip duration must be a positive integer.",
        jsonPath(path, "duration"),
        clipDetails,
      );
    }
    if (source.kind === "image" && rawClip.duration === undefined) {
      add("TIMELINE_CLIP_INVALID", "Image clips must declare a duration.", jsonPath(path, "duration"), clipDetails);
    }
    const duration =
      rawClip.duration === undefined
        ? undefined
        : isInteger(rawClip.duration) && rawClip.duration > 0
          ? rawClip.duration
          : undefined;

    if (rawClip.sourceIn !== undefined && (!isInteger(rawClip.sourceIn) || rawClip.sourceIn < 0)) {
      add(
        "TIMELINE_CLIP_INVALID",
        "Clip sourceIn must be a non-negative integer.",
        jsonPath(path, "sourceIn"),
        clipDetails,
      );
    }
    const sourceIn = isInteger(rawClip.sourceIn) && rawClip.sourceIn >= 0 ? rawClip.sourceIn : 0;
    if (source.kind === "image" && sourceIn !== 0) {
      add("TIMELINE_CLIP_INVALID", "Image clips must use sourceIn 0.", jsonPath(path, "sourceIn"), clipDetails);
    }

    let props: Props | undefined;
    if (rawClip.props !== undefined) {
      if (source.kind !== "composition") {
        add("TIMELINE_CLIP_INVALID", "props is only valid on composition clips.", jsonPath(path, "props"), clipDetails);
      } else if (!isPlainObject(rawClip.props)) {
        add("TIMELINE_CLIP_INVALID", "Clip props must be a plain JSON object.", jsonPath(path, "props"), clipDetails);
      } else {
        try {
          assertJsonSerializable(rawClip.props, "props");
          props = rawClip.props as Props;
        } catch (error) {
          add(
            "TIMELINE_CLIP_INVALID",
            `Clip props are not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
            jsonPath(path, "props"),
            clipDetails,
          );
        }
      }
    }

    const visual = isVisualSource(source);
    const audioBearing = isAudioBearingSource(source);
    let transform: TimelineTransform | undefined;
    if (rawClip.transform !== undefined) {
      if (!visual) {
        add(
          "TIMELINE_CLIP_INVALID",
          "transform is only valid on visual clips.",
          jsonPath(path, "transform"),
          clipDetails,
        );
      } else {
        transform = parseTransform(
          rawClip.transform,
          jsonPath(path, "transform"),
          (code, message, errorPath, errorDetails) => {
            add(code, message, errorPath, { ...clipDetails, ...errorDetails });
          },
        );
      }
    } else if (visual) {
      transform = { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    }

    let audio: TimelineClipAudio | undefined;
    if (rawClip.audio !== undefined) {
      if (!audioBearing) {
        add("TIMELINE_CLIP_INVALID", "audio is only valid on clips with audio.", jsonPath(path, "audio"), clipDetails);
      } else {
        audio = parseAudio(rawClip.audio, jsonPath(path, "audio"), (code, message, errorPath, errorDetails) => {
          add(code, message, errorPath, { ...clipDetails, ...errorDetails });
        });
      }
    } else if (audioBearing) {
      audio = { muted: false, gain: 1 };
    }

    const expectedKind = source.kind === "audio" ? "audio" : "video";
    if (track.kind !== expectedKind) {
      add(
        "TIMELINE_CLIP_INVALID",
        `Clip source ${source.kind} requires a ${expectedKind} track; "${trackId}" is ${track.kind}.`,
        jsonPath(path, "track"),
        clipDetails,
      );
    }

    clips.push({
      id: clipId,
      track: trackId,
      source,
      start,
      ...(duration !== undefined ? { duration } : {}),
      sourceIn,
      ...(props !== undefined ? { props } : {}),
      ...(transform !== undefined ? { transform } : {}),
      ...(audio !== undefined ? { audio } : {}),
    });
  }

  for (const track of tracks) {
    const trackClips = clips
      .filter((clip) => clip.track === track.id && clip.duration !== undefined)
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < trackClips.length; index += 1) {
      const previous = trackClips[index - 1] as TimelineClip;
      const current = trackClips[index] as TimelineClip;
      if (current.start < previous.start + (previous.duration as number)) {
        add(
          "TIMELINE_CLIP_OVERLAP",
          `Clip "${current.id}" overlaps "${previous.id}" on track "${track.id}".`,
          `$.clips[${clips.indexOf(current)}]`,
          { track: track.id, clip: current.id, suggestion: "No two clips on one track may overlap in 0.6." },
        );
      }
    }
  }

  const explicitEnd = clips.reduce((end, clip) => {
    if (clip.duration === undefined) {
      return end;
    }
    return Math.max(end, clip.start + clip.duration);
  }, 0);
  if (
    typeof value.durationInFrames === "number" &&
    Number.isInteger(value.durationInFrames) &&
    value.durationInFrames > 0
  ) {
    if (value.durationInFrames < explicitEnd) {
      add(
        "TIMELINE_DURATION_INVALID",
        `Timeline durationInFrames ${value.durationInFrames} is shorter than the explicit clip end ${explicitEnd}.`,
        "$.durationInFrames",
      );
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { timeline: null, diagnostics };
  }

  return {
    timeline: {
      version: 1,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.durationInFrames === "number" ? { durationInFrames: value.durationInFrames } : {}),
      ...(typeof value.background === "string" ? { background: value.background } : {}),
      tracks,
      clips,
    },
    diagnostics,
  };
}
