import {
  assertJsonSerializable,
  isPlainObject,
  type CompositionDiagnostic,
  type CompositionDiagnosticDetails,
  type Props,
} from "../contracts.js";
import { diagnosticFix } from "../diagnostic-fixes.js";
import type { FrameyardErrorCode } from "../errors.js";
import { EASING_GRAMMAR, parseEasing } from "./easing.js";

export type TimelineTrackKind = "video" | "audio";
export type TimelineSourceKind = "composition" | "timeline" | "video" | "image" | "audio";
export type FitPolicy = "contain" | "cover" | "stretch";

/** CSS blend modes that FFmpeg can reproduce with matching semantics. */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** CSS blend modes that require cross-channel math and are not supported yet. */
export const UNSUPPORTED_BLEND_MODES = ["hue", "saturation", "color", "luminosity"] as const;

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
  /** Optional explicit clip box in output pixels. Requires height and excludes scale. */
  width?: number;
  height?: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** The presentation defaults applied when a visual clip omits a transform. */
export const DEFAULT_TIMELINE_TRANSFORM: Readonly<TimelineTransform> = Object.freeze({
  fit: "contain",
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
});

export interface TimelineClipAudio {
  muted: boolean;
  gain: number;
}

export interface TimelineKeyframe {
  /** Clip-local integer frame. `0` is the clip start; `duration` is the end boundary. */
  frame: number;
  value: number;
  /** CSS timing function for the interval after this key. Defaults to `linear`. */
  easing?: string;
}

export type TimelineKeyframeTrack = TimelineKeyframe[];

export const KEYFRAME_CHANNELS = ["x", "y", "scale", "rotation", "opacity"] as const;

export type TimelineKeyframeChannel = (typeof KEYFRAME_CHANNELS)[number];

export type TimelineKeyframes = Partial<Record<TimelineKeyframeChannel, TimelineKeyframeTrack>>;

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
  /** Per-channel presentation animation, evaluated in clip-local frames. */
  keyframes?: TimelineKeyframes;
  /** CSS blend mode against the accumulated backdrop. Defaults to `normal`. */
  blend?: BlendMode;
  audio?: TimelineClipAudio;
}

/** Transition kinds that both preview and production can reproduce exactly. */
export const TRANSITION_KINDS = ["dissolve", "crossfade"] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * A transition across the overlap of two clips on one track. `dissolve` is a
 * visual fade on a video track and also crossfades contributed audio;
 * `crossfade` is an audio gain ramp between two audio-track clips.
 */
export interface TimelineTransition {
  from: string;
  to: string;
  kind: TransitionKind;
  /** CSS timing function for the progress. Defaults to `linear`. */
  easing?: string;
}

export interface TimelineDocument {
  version: 1;
  name?: string;
  durationInFrames?: number;
  background?: string;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions?: TimelineTransition[];
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
  const fix = diagnosticFix(code, merged, message);
  return { severity, code, message, details: merged, ...(fix !== undefined ? { fix } : {}) };
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
  const defaults: TimelineTransform = { ...DEFAULT_TIMELINE_TRANSFORM };
  if (!isPlainObject(value)) {
    add("TIMELINE_CLIP_INVALID", "Clip transform must be an object.", path);
    return defaults;
  }

  for (const key of unknownKeys(value, ["fit", "x", "y", "width", "height", "scale", "rotation", "opacity"])) {
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

  const width = value.width;
  const height = value.height;
  if ((width === undefined) !== (height === undefined)) {
    add(
      "TIMELINE_CLIP_INVALID",
      "Clip transform.width and transform.height must be provided together.",
      jsonPath(path, width === undefined ? "width" : "height"),
    );
  }
  for (const [key, field] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (field === undefined) {
      continue;
    }
    if (!isInteger(field) || field <= 0) {
      add("TIMELINE_CLIP_INVALID", `Clip transform.${key} must be a positive integer.`, jsonPath(path, key));
    }
  }
  if (width !== undefined && height !== undefined && value.scale !== undefined) {
    add(
      "TIMELINE_CLIP_INVALID",
      "Clip transform.scale cannot be combined with transform.width and transform.height.",
      jsonPath(path, "scale"),
    );
  }
  if (isInteger(width) && width > 0 && isInteger(height) && height > 0) {
    transform.width = width;
    transform.height = height;
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

function parseKeyframes(
  value: unknown,
  path: string,
  add: (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details?: Partial<CompositionDiagnosticDetails>,
  ) => void,
  transform: unknown,
): TimelineKeyframes {
  if (!isPlainObject(value)) {
    add("TIMELINE_CLIP_INVALID", "Clip keyframes must be an object.", path);
    return {};
  }

  for (const key of unknownKeys(value, KEYFRAME_CHANNELS)) {
    add("TIMELINE_CLIP_INVALID", `Unknown clip keyframes channel "${key}".`, jsonPath(path, key));
  }
  if (Object.keys(value).length === 0) {
    add("TIMELINE_CLIP_INVALID", "Clip keyframes must declare at least one channel.", path);
    return {};
  }

  const transformObject = isPlainObject(transform) ? transform : undefined;
  const explicitTransformKeys = new Set(transformObject ? Object.keys(transformObject) : []);
  const hasTransformBox = transformObject?.width !== undefined && transformObject?.height !== undefined;
  const keyframes: TimelineKeyframes = {};

  for (const channel of KEYFRAME_CHANNELS) {
    const rawTrack = value[channel];
    if (rawTrack === undefined) {
      continue;
    }
    const channelPath = jsonPath(path, channel);
    if (explicitTransformKeys.has(channel)) {
      add(
        "TIMELINE_CLIP_INVALID",
        `Clip keyframes.${channel} cannot be combined with transform.${channel}.`,
        channelPath,
      );
    }
    if (channel === "scale" && hasTransformBox) {
      add(
        "TIMELINE_CLIP_INVALID",
        "Clip keyframes.scale cannot be combined with transform.width and transform.height.",
        channelPath,
      );
    }
    if (!Array.isArray(rawTrack)) {
      add("TIMELINE_CLIP_INVALID", `Clip keyframes.${channel} must be an array.`, channelPath);
      continue;
    }
    if (rawTrack.length < 2) {
      add("TIMELINE_CLIP_INVALID", `Clip keyframes.${channel} must declare at least two keyframes.`, channelPath);
    }

    const track: TimelineKeyframe[] = [];
    let previousFrame = -1;
    for (const [index, rawKey] of rawTrack.entries()) {
      const keyPath = jsonPath(channelPath, index);
      if (!isPlainObject(rawKey)) {
        add("TIMELINE_CLIP_INVALID", "Keyframe must be an object.", keyPath);
        continue;
      }
      for (const key of unknownKeys(rawKey, ["frame", "value", "easing"])) {
        add("TIMELINE_CLIP_INVALID", `Unknown keyframe field "${key}".`, jsonPath(keyPath, key));
      }

      const frame = rawKey.frame;
      const frameValid = isInteger(frame) && frame >= 0;
      if (!frameValid) {
        add("TIMELINE_CLIP_INVALID", "Keyframe frame must be a non-negative integer.", jsonPath(keyPath, "frame"));
      } else if (frame <= previousFrame) {
        add(
          "TIMELINE_CLIP_INVALID",
          `Keyframe frames in keyframes.${channel} must be strictly increasing.`,
          jsonPath(keyPath, "frame"),
        );
      } else {
        previousFrame = frame;
      }

      const keyValue = rawKey.value;
      let numericValue: number | undefined;
      if (!isFiniteNumber(keyValue)) {
        add("TIMELINE_CLIP_INVALID", "Keyframe value must be a finite number.", jsonPath(keyPath, "value"));
      } else if (channel === "scale" && keyValue < 0) {
        add("TIMELINE_CLIP_INVALID", "Keyframe scale must be zero or greater.", jsonPath(keyPath, "value"));
      } else if (channel === "opacity" && (keyValue < 0 || keyValue > 1)) {
        add("TIMELINE_CLIP_INVALID", "Keyframe opacity must be between 0 and 1.", jsonPath(keyPath, "value"));
      } else {
        numericValue = keyValue;
      }

      let easing: string | undefined;
      if (rawKey.easing !== undefined) {
        if (typeof rawKey.easing !== "string" || rawKey.easing.trim().length === 0) {
          add("TIMELINE_CLIP_INVALID", "Keyframe easing must be a non-empty string.", jsonPath(keyPath, "easing"));
        } else if (parseEasing(rawKey.easing) === null) {
          add(
            "TIMELINE_CLIP_INVALID",
            `Keyframe easing "${rawKey.easing}" is not supported. Use ${EASING_GRAMMAR}.`,
            jsonPath(keyPath, "easing"),
            { value: rawKey.easing, suggestion: `Use ${EASING_GRAMMAR}.` },
          );
        } else {
          easing = rawKey.easing.trim();
        }
      }

      if (frameValid && numericValue !== undefined) {
        track.push({
          frame,
          value: numericValue,
          ...(easing !== undefined ? { easing } : {}),
        });
      }
    }

    if (track.length > 0) {
      keyframes[channel] = track;
    }
  }

  return keyframes;
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

function parseTransitions(
  value: unknown,
  path: string,
  add: (
    code: FrameyardErrorCode,
    message: string,
    path: string,
    details?: Partial<CompositionDiagnosticDetails>,
  ) => void,
): TimelineTransition[] {
  if (!Array.isArray(value)) {
    add("TIMELINE_TRANSITION_INVALID", "Timeline transitions must be an array.", path);
    return [];
  }

  const transitions: TimelineTransition[] = [];
  const fromIds = new Set<string>();
  const toIds = new Set<string>();
  const pairs = new Set<string>();

  for (const [index, raw] of value.entries()) {
    const entryPath = jsonPath(path, index);
    if (!isPlainObject(raw)) {
      add("TIMELINE_TRANSITION_INVALID", "Transition must be an object.", entryPath);
      continue;
    }
    for (const key of unknownKeys(raw, ["from", "to", "kind", "easing"])) {
      add("TIMELINE_TRANSITION_INVALID", `Unknown transition field "${key}".`, jsonPath(entryPath, key));
    }

    const fromValid = isNonEmptyString(raw.from) && ID_PATTERN.test(raw.from);
    const toValid = isNonEmptyString(raw.to) && ID_PATTERN.test(raw.to);
    const details: Partial<CompositionDiagnosticDetails> = {
      ...(isNonEmptyString(raw.from) ? { from: raw.from } : {}),
      ...(isNonEmptyString(raw.to) ? { to: raw.to } : {}),
    };
    if (!fromValid) {
      add(
        "TIMELINE_TRANSITION_INVALID",
        "Transition from must be a valid clip id.",
        jsonPath(entryPath, "from"),
        details,
      );
    }
    if (!toValid) {
      add("TIMELINE_TRANSITION_INVALID", "Transition to must be a valid clip id.", jsonPath(entryPath, "to"), details);
    }

    let kind: TransitionKind | undefined;
    if (raw.kind !== undefined) {
      if (typeof raw.kind !== "string" || !(TRANSITION_KINDS as readonly string[]).includes(raw.kind)) {
        add(
          "TIMELINE_TRANSITION_KIND",
          `Transition kind must be one of: ${TRANSITION_KINDS.join(", ")}.`,
          jsonPath(entryPath, "kind"),
          { ...details, ...(typeof raw.kind === "string" ? { value: raw.kind } : {}) },
        );
      } else {
        kind = raw.kind as TransitionKind;
      }
    } else {
      add("TIMELINE_TRANSITION_KIND", "Transition kind is required.", jsonPath(entryPath, "kind"), details);
    }

    let easing: string | undefined;
    if (raw.easing !== undefined) {
      if (typeof raw.easing !== "string" || raw.easing.trim().length === 0) {
        add(
          "TIMELINE_TRANSITION_INVALID",
          "Transition easing must be a non-empty string.",
          jsonPath(entryPath, "easing"),
          details,
        );
      } else if (parseEasing(raw.easing) === null) {
        add(
          "TIMELINE_TRANSITION_INVALID",
          `Transition easing "${raw.easing}" is not supported. Use ${EASING_GRAMMAR}.`,
          jsonPath(entryPath, "easing"),
          { ...details, value: raw.easing, suggestion: `Use ${EASING_GRAMMAR}.` },
        );
      } else {
        easing = raw.easing.trim();
      }
    }

    if (!fromValid || !toValid) {
      continue;
    }
    const from = raw.from as string;
    const to = raw.to as string;
    if (pairs.has(`${from}\u0000${to}`)) {
      add(
        "TIMELINE_TRANSITION_DUPLICATE",
        `Transition from "${from}" to "${to}" is declared more than once.`,
        entryPath,
        { ...details, suggestion: "Declare each clip pair once." },
      );
      continue;
    }
    if (fromIds.has(from)) {
      add(
        "TIMELINE_TRANSITION_DUPLICATE",
        `Clip "${from}" is already the source of another transition.`,
        jsonPath(entryPath, "from"),
        { ...details, suggestion: "A clip can transition into at most one other clip." },
      );
      continue;
    }
    if (toIds.has(to)) {
      add(
        "TIMELINE_TRANSITION_DUPLICATE",
        `Clip "${to}" is already the target of another transition.`,
        jsonPath(entryPath, "to"),
        { ...details, suggestion: "A clip can be transitioned into at most once." },
      );
      continue;
    }
    fromIds.add(from);
    toIds.add(to);
    pairs.add(`${from}\u0000${to}`);
    if (kind === undefined) {
      continue;
    }
    transitions.push({ from, to, kind, ...(easing !== undefined ? { easing } : {}) });
  }

  return transitions;
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

  for (const key of unknownKeys(value, [
    "version",
    "name",
    "durationInFrames",
    "background",
    "tracks",
    "clips",
    "transitions",
  ])) {
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
      "keyframes",
      "blend",
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
      transform = { ...DEFAULT_TIMELINE_TRANSFORM };
    }

    let keyframes: TimelineKeyframes | undefined;
    if (rawClip.keyframes !== undefined) {
      if (!visual) {
        add(
          "TIMELINE_CLIP_INVALID",
          "keyframes is only valid on visual clips.",
          jsonPath(path, "keyframes"),
          clipDetails,
        );
      } else {
        keyframes = parseKeyframes(
          rawClip.keyframes,
          jsonPath(path, "keyframes"),
          (code, message, errorPath, errorDetails) => {
            add(code, message, errorPath, { ...clipDetails, ...errorDetails });
          },
          rawClip.transform,
        );
      }
    }

    let blend: BlendMode | undefined;
    if (rawClip.blend !== undefined) {
      if (!visual) {
        add("TIMELINE_CLIP_INVALID", "blend is only valid on visual clips.", jsonPath(path, "blend"), clipDetails);
      } else if (typeof rawClip.blend !== "string") {
        add("TIMELINE_CLIP_INVALID", "Clip blend must be a string.", jsonPath(path, "blend"), clipDetails);
      } else if ((BLEND_MODES as readonly string[]).includes(rawClip.blend)) {
        blend = rawClip.blend as BlendMode;
      } else if ((UNSUPPORTED_BLEND_MODES as readonly string[]).includes(rawClip.blend)) {
        add(
          "TIMELINE_CLIP_INVALID",
          `Clip blend "${rawClip.blend}" is not supported. Supported modes: ${BLEND_MODES.join(", ")}.`,
          jsonPath(path, "blend"),
          {
            ...clipDetails,
            value: rawClip.blend,
            suggestion: "Use a separable CSS blend mode such as multiply, screen, or soft-light.",
          },
        );
      } else {
        add("TIMELINE_CLIP_INVALID", `Clip blend must be one of: ${BLEND_MODES.join(", ")}.`, jsonPath(path, "blend"), {
          ...clipDetails,
          value: rawClip.blend,
          ...(rawClip.blend.toLowerCase() !== rawClip.blend
            ? { suggestion: "Blend mode names are lowercase CSS values." }
            : {}),
        });
      }
    } else if (visual) {
      blend = "normal";
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
      ...(keyframes !== undefined ? { keyframes } : {}),
      ...(blend !== undefined ? { blend } : {}),
      ...(audio !== undefined ? { audio } : {}),
    });
  }

  const transitions = value.transitions === undefined ? [] : parseTransitions(value.transitions, "$.transitions", add);

  const declaredPairs = new Set<string>();
  for (const transition of transitions) {
    declaredPairs.add(`${transition.from}\u0000${transition.to}`);
    declaredPairs.add(`${transition.to}\u0000${transition.from}`);
  }
  for (const track of tracks) {
    const trackClips = clips
      .filter((clip) => clip.track === track.id && clip.duration !== undefined)
      .sort(
        (left, right) =>
          left.start - right.start ||
          left.start + (left.duration as number) - (right.start + (right.duration as number)),
      );
    for (let index = 0; index < trackClips.length; index += 1) {
      const previous = trackClips[index] as TimelineClip;
      const previousEnd = previous.start + (previous.duration as number);
      for (let next = index + 1; next < trackClips.length; next += 1) {
        const current = trackClips[next] as TimelineClip;
        if (current.start >= previousEnd) {
          break;
        }
        if (declaredPairs.has(`${previous.id}\u0000${current.id}`)) {
          continue;
        }
        add(
          "TIMELINE_CLIP_OVERLAP",
          `Clip "${current.id}" overlaps "${previous.id}" on track "${track.id}".`,
          `$.clips[${clips.indexOf(current)}]`,
          {
            track: track.id,
            clip: current.id,
            suggestion: "No two clips on one track may overlap without a declared transition.",
          },
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
      transitions,
    },
    diagnostics,
  };
}
