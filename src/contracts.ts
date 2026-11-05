import { FrameyardError, type FrameyardErrorCode } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Props = { [key: string]: JsonValue };

/** Output width, height, and frame rate fixed for a project. */
export interface CompositionFormat {
  /** Output width in CSS pixels. */
  width: number;
  /** Output height in CSS pixels. */
  height: number;
  /** Frames per second. Frame time is always derived from frame / fps. */
  fps: number;
}

/**
 * Format values a composition declares on its root. A null value is inherited
 * from the project format; declarations always win over inheritance.
 */
export interface DeclaredFormat {
  width: number | null;
  height: number | null;
  fps: number | null;
}

/** The fixed facts a composition fragment declares before format resolution. */
export interface DeclaredCompositionMetadata {
  format: DeclaredFormat;
  /**
   * Positive integer number of frames in the composition. Null when the
   * fragment declares neither `duration-in-frames` nor `fps`, making it a
   * static (timeless) composition.
   */
  durationInFrames: number | null;
}

/** Output dimensions shared by animated and static compositions. */
export interface CompositionDimensions {
  /** Output width in CSS pixels. */
  width: number;
  /** Output height in CSS pixels. */
  height: number;
}

/**
 * A static composition has no time base. It is captured once in its initial
 * state and cannot be seeked or encoded as video.
 */
export interface StaticCompositionMetadata extends CompositionDimensions {
  readonly static: true;
}

/** A composition with a frame clock. Frame time is always frame / fps. */
export interface CompositionMetadata extends CompositionDimensions {
  readonly static?: false;
  /** Frames per second. Frame time is always derived from frame / fps. */
  fps: number;
  /** Positive integer number of frames in the composition. */
  durationInFrames: number;
}

/** Metadata resolved against the project format. */
export type ResolvedCompositionMetadata = CompositionMetadata | StaticCompositionMetadata;

export function isStaticCompositionMetadata(
  metadata: ResolvedCompositionMetadata | null | undefined,
): metadata is StaticCompositionMetadata {
  return metadata?.static === true;
}

export interface AudioClip {
  /** Project-relative path to a local audio file. */
  src: string;
  /** Composition frame at which the clip starts. */
  startFrame: number;
  /** Seconds trimmed from the start of the source. Defaults to 0. */
  trimStart?: number;
  /** Seconds of the source to use. Defaults to the rest of the source. */
  trimDuration?: number;
  /** Linear volume from 0 to 1. Defaults to 1. */
  volume?: number;
}

/** One multiplicative gain ramp applied over an absolute timeline frame window. */
export interface AudioVolumeEnvelope {
  /** Inclusive first timeline frame. */
  startFrame: number;
  /** Exclusive last timeline frame. */
  endFrame: number;
  /** CSS timing function applied before the equal-power mapping. Defaults to `linear`. */
  easing?: string;
  /** `in` ramps 0→1 and `out` ramps 1→0. */
  role: "in" | "out";
}

export interface ResolvedAudioClip {
  src: string;
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
  /** Gain ramps multiplied into `volume`, evaluated at absolute timeline frames. */
  envelopes?: AudioVolumeEnvelope[];
}

export interface TranscriptClip {
  /** Project-relative path to a canonical Frameyard transcript JSON document. */
  src: string;
  /** Require measured word timings for karaoke-style presentation. Defaults to false. */
  words?: boolean;
}

export interface ResolvedTranscriptClip {
  src: string;
  words: boolean;
}

export type DiagnosticSeverity = "error" | "warning";

export interface CompositionDiagnosticDetails {
  /** Project-relative source path. */
  path?: string;
  /** One-based source line. */
  line?: number;
  /** One-based source column. */
  column?: number;
  endLine?: number;
  endColumn?: number;
  element?: string;
  attribute?: string;
  value?: string;
  suggestion?: string;
  frame?: number;
  timeline?: string;
  track?: string;
  clip?: string;
  /** Timeline keyframe channel when the diagnostic targets one. */
  channel?: string;
  /** Zero-based keyframe index when the diagnostic targets one. */
  keyframe?: number;
  /** JSON Pointer-like path such as `$.clips[2].duration`. */
  jsonPath?: string;
  composition?: string;
  nestedTimeline?: string;
  media?: string;
  /** Remote asset URL for diagnostics such as FONT_REMOTE. */
  url?: string;
  /** Font family or manifest id for font diagnostics. */
  font?: string;
  timelineFrame?: number;
  sourceFrame?: number;
  /** Transition source clip ID when the diagnostic targets a transition. */
  from?: string;
  /** Transition target clip ID when the diagnostic targets a transition. */
  to?: string;
  /** Clip IDs from outermost to innermost for diagnostics inside nested timelines. */
  nesting?: string[];
  controller?: {
    kind: "inline" | "external";
    line?: number;
    column?: number;
  };
}

export interface CompositionDiagnostic {
  severity: DiagnosticSeverity;
  code: FrameyardErrorCode;
  message: string;
  details?: CompositionDiagnosticDetails;
}

export interface ControllerDeclaration {
  kind: "inline" | "external";
  /** Project-relative path for external controllers. */
  src?: string;
  /** Authoring value for external controllers, relative to the composition URL. */
  rawSrc?: string;
  /** Inline source for inline controllers. */
  source?: string;
  /** One-based line of the controller block in the composition fragment. */
  line?: number;
  /** One-based column of the controller block in the composition fragment. */
  column?: number;
}

export interface CompositionSourceInfo {
  /** Metadata resolved against the project format. */
  metadata: ResolvedCompositionMetadata;
  /**
   * The format values the fragment declares. Missing values were inherited
   * from the project format to produce `metadata`.
   */
  declaredFormat: DeclaredFormat;
  defaultProps: Readonly<Props>;
  controller: ControllerDeclaration | null;
  audioClips: readonly ResolvedAudioClip[];
  embeddedAudioClips: readonly ResolvedAudioClip[];
  transcriptClips: readonly ResolvedTranscriptClip[];
}

/** The browser host API exposed as window.__fy. */
export interface FrameyardHost {
  readonly ready: Promise<void>;
  readonly metadata: ResolvedCompositionMetadata;
  readonly defaultProps: Readonly<Props>;
  readonly props: Readonly<Props>;
  readonly controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  readonly audioClips: readonly ResolvedAudioClip[];
  readonly embeddedAudioClips: readonly ResolvedAudioClip[];
  readonly transcriptClips: readonly ResolvedTranscriptClip[];
  readonly diagnostics: readonly CompositionDiagnostic[];
  readonly frame: number;
  load(options?: { props?: unknown }): Promise<void>;
  seek(frame: number): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Checks that a value survives a JSON round trip without losing information.
 * Returns the same value for convenient inline use.
 */
export function assertJsonSerializable<T>(value: T, label = "value"): T {
  const ancestors = new WeakSet<object>();

  function visit(current: unknown, path: string): void {
    if (current === null) {
      return;
    }

    switch (typeof current) {
      case "boolean":
      case "string":
        return;
      case "number":
        if (!Number.isFinite(current)) {
          throw new FrameyardError("PROPS_INVALID", `${path} is not JSON-serializable: numbers must be finite.`);
        }
        return;
      case "undefined":
        throw new FrameyardError("PROPS_INVALID", `${path} is not JSON-serializable: undefined is not a JSON value.`);
      case "bigint":
      case "function":
      case "symbol":
        throw new FrameyardError(
          "PROPS_INVALID",
          `${path} is not JSON-serializable: ${typeof current} is not a JSON value.`,
        );
      case "object":
        break;
    }

    const asObject = current as object;
    if (ancestors.has(asObject)) {
      throw new FrameyardError("PROPS_INVALID", `${path} is not JSON-serializable: circular reference.`);
    }
    ancestors.add(asObject);

    try {
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          if (!(index in current)) {
            throw new FrameyardError(
              "PROPS_INVALID",
              `${path}[${index}] is not JSON-serializable: sparse arrays are not supported.`,
            );
          }
          visit(current[index], `${path}[${index}]`);
        }
        return;
      }

      if (!isPlainObject(current)) {
        throw new FrameyardError(
          "PROPS_INVALID",
          `${path} is not JSON-serializable: only plain objects and arrays are supported.`,
        );
      }

      for (const [key, child] of Object.entries(current)) {
        visit(child, `${path}.${key}`);
      }
    } finally {
      ancestors.delete(asObject);
    }
  }

  visit(value, label);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) {
      deepFreeze(child);
    }
    return Object.freeze(value) as T;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

function mergePropsUnfrozen<P extends Props>(defaults: P | undefined, overrides?: unknown): P {
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new FrameyardError("PROPS_INVALID", "Props must be a plain JSON object.");
  }

  const merged = {
    ...defaults,
    ...(overrides as Record<string, JsonValue> | undefined),
  };

  assertJsonSerializable(merged, "props");
  return merged as P;
}

/**
 * Merges a render's prop overrides over defaults, validates the result as JSON,
 * and deep-freezes it. The HTML static validator and host use this before a
 * controller's validateProps hook runs.
 */
export function mergeProps<P extends Props>(defaults: P | undefined, overrides?: unknown): Readonly<P> {
  return deepFreeze(mergePropsUnfrozen(defaults, overrides)) as Readonly<P>;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function normalizeAudioClip(value: unknown, index: number): ResolvedAudioClip {
  if (!isPlainObject(value)) {
    throw new FrameyardError("AUDIO_INVALID", `Audio clip ${index} must be a plain object.`);
  }

  const { src, startFrame, trimStart, trimDuration, volume } = value;

  if (typeof src !== "string" || src.length === 0) {
    throw new FrameyardError("AUDIO_INVALID", `Audio clip ${index} src must be a non-empty string.`);
  }
  if (SCHEME.test(src) || src.startsWith("/") || src.startsWith("\\") || src.split(/[\\/]/).includes("..")) {
    throw new FrameyardError(
      "AUDIO_INVALID",
      `Audio clip ${index} src must be a local project-relative path, not "${src}".`,
    );
  }
  if (typeof startFrame !== "number" || !Number.isInteger(startFrame) || startFrame < 0) {
    throw new FrameyardError("AUDIO_INVALID", `Audio clip ${index} startFrame must be a non-negative integer.`);
  }
  if (trimStart !== undefined && (typeof trimStart !== "number" || !Number.isFinite(trimStart) || trimStart < 0)) {
    throw new FrameyardError(
      "AUDIO_INVALID",
      `Audio clip ${index} trimStart must be a non-negative number of seconds.`,
    );
  }
  if (
    trimDuration !== undefined &&
    (typeof trimDuration !== "number" || !Number.isFinite(trimDuration) || trimDuration <= 0)
  ) {
    throw new FrameyardError("AUDIO_INVALID", `Audio clip ${index} trimDuration must be a positive number of seconds.`);
  }
  if (volume !== undefined && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1)) {
    throw new FrameyardError("AUDIO_INVALID", `Audio clip ${index} volume must be between 0 and 1.`);
  }

  const clip: ResolvedAudioClip = {
    src,
    startFrame,
    trimStart: (trimStart as number | undefined) ?? 0,
    volume: (volume as number | undefined) ?? 1,
  };
  if (trimDuration !== undefined) {
    clip.trimDuration = trimDuration;
  }
  return Object.freeze(clip);
}

export function normalizeTranscriptClip(value: unknown, index: number): ResolvedTranscriptClip {
  if (!isPlainObject(value)) {
    throw new FrameyardError("TRANSCRIPT_INVALID", `Transcript ${index} must be a plain object.`);
  }

  const { src, words } = value;
  if (typeof src !== "string" || src.length === 0) {
    throw new FrameyardError("TRANSCRIPT_INVALID", `Transcript ${index} src must be a non-empty string.`);
  }
  if (SCHEME.test(src) || src.startsWith("/") || src.startsWith("\\") || src.split(/[\\/]/).includes("..")) {
    throw new FrameyardError(
      "TRANSCRIPT_INVALID",
      `Transcript ${index} src must be a local project-relative path, not "${src}".`,
    );
  }
  if (words !== undefined && typeof words !== "boolean") {
    throw new FrameyardError("TRANSCRIPT_INVALID", `Transcript ${index} words must be a boolean.`);
  }

  return Object.freeze({ src, words: words === true });
}
