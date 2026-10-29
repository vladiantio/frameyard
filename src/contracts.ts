import { FrameyardError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Props = { [key: string]: JsonValue };

export interface CompositionMetadata {
  /** Output width in CSS pixels. */
  width: number;
  /** Output height in CSS pixels. */
  height: number;
  /** Frames per second. Frame time is always derived from frame / fps. */
  fps: number;
  /** Positive integer number of frames in the composition. */
  durationInFrames: number;
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

export interface ResolvedAudioClip {
  src: string;
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
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

export interface MountContext<P extends Props = Props> {
  container: HTMLElement;
  props: Readonly<P>;
}

export interface UpdateContext<P extends Props = Props> {
  frame: number;
  props: Readonly<P>;
}

export interface AudioContext<P extends Props = Props> {
  props: Readonly<P>;
}

export interface CompositionDefinition<P extends Props = Props> extends CompositionMetadata {
  /** Props merged over by a render's JSON props. */
  defaultProps?: P;
  /** Creates the composition's visual structure once. May complete asynchronous work. */
  mount(context: MountContext<P>): void | Promise<void>;
  /** Makes the mounted structure represent the requested frame. Must be synchronous and seek-safe. */
  update(context: UpdateContext<P>): void;
  /** Releases resources after the last frame. */
  dispose?(): void | Promise<void>;
  /** Optional domain validation. Return an array of human-readable errors. */
  validateProps?(props: Readonly<P>): void | string[];
  /** Declarative audio timeline, or a function deriving one from props. */
  audio?: AudioClip[] | ((context: AudioContext<P>) => AudioClip[]);
  /** Transcript assets required by the composition, or a function deriving them from props. */
  transcripts?: TranscriptClip[] | ((context: AudioContext<P>) => TranscriptClip[]);
}

export interface Composition<P extends Props = Props> extends CompositionMetadata {
  defaultProps?: Readonly<P>;
  mount(context: MountContext<P>): void | Promise<void>;
  update(context: UpdateContext<P>): void;
  dispose?(): void | Promise<void>;
  validateProps?(props: Readonly<P>): void | string[];
  audio?: AudioClip[] | ((context: AudioContext<P>) => AudioClip[]);
  transcripts?: TranscriptClip[] | ((context: AudioContext<P>) => TranscriptClip[]);
}

function invalid(message: string): never {
  throw new FrameyardError("COMPOSITION_INVALID", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAsyncFunction(value: unknown): boolean {
  return typeof value === "function" && Object.prototype.toString.call(value) === "[object AsyncFunction]";
}

/**
 * Validates and returns a composition definition. Composition modules can use
 * this helper for early feedback, but plain exported objects are normalized by
 * the runtime as well.
 */
export function defineComposition<P extends Props = Props>(definition: CompositionDefinition<P>): Composition<P> {
  return normalizeComposition(definition) as Composition<P>;
}

export function normalizeComposition(value: unknown): Composition {
  if (!isPlainObject(value)) {
    invalid("A composition must be a plain object.");
  }

  const width = value.width;
  const height = value.height;
  const fps = value.fps;
  const durationInFrames = value.durationInFrames;

  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    invalid("Composition width must be a positive integer.");
  }
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    invalid("Composition height must be a positive integer.");
  }
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    invalid("Composition fps must be a positive finite number.");
  }
  if (typeof durationInFrames !== "number" || !Number.isInteger(durationInFrames) || durationInFrames <= 0) {
    invalid("Composition durationInFrames must be a positive integer.");
  }

  if (typeof value.mount !== "function") {
    invalid("Composition mount must be a function.");
  }
  if (typeof value.update !== "function") {
    invalid("Composition update must be a function.");
  }
  if (isAsyncFunction(value.update)) {
    invalid("Composition update must be synchronous; finish asynchronous work in mount().");
  }
  if (value.dispose !== undefined && typeof value.dispose !== "function") {
    invalid("Composition dispose must be a function when provided.");
  }
  if (value.validateProps !== undefined && typeof value.validateProps !== "function") {
    invalid("Composition validateProps must be a function when provided.");
  }
  if (value.audio !== undefined && typeof value.audio !== "function" && !Array.isArray(value.audio)) {
    invalid("Composition audio must be an array or a function returning an array.");
  }
  if (value.transcripts !== undefined && typeof value.transcripts !== "function" && !Array.isArray(value.transcripts)) {
    invalid("Composition transcripts must be an array or a function returning an array.");
  }

  if (value.defaultProps !== undefined) {
    if (!isPlainObject(value.defaultProps)) {
      invalid("Composition defaultProps must be a plain object.");
    }
    try {
      assertJsonSerializable(value.defaultProps, "defaultProps");
    } catch (error) {
      invalid(
        `Composition defaultProps must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const composition: Composition = {
    width,
    height,
    fps,
    durationInFrames,
    mount: value.mount as Composition["mount"],
    update: value.update as Composition["update"],
  };

  if (value.defaultProps !== undefined) {
    composition.defaultProps = value.defaultProps as Props;
  }
  if (value.dispose !== undefined) {
    composition.dispose = value.dispose as NonNullable<Composition["dispose"]>;
  }
  if (value.validateProps !== undefined) {
    composition.validateProps = value.validateProps as NonNullable<Composition["validateProps"]>;
  }
  if (value.audio !== undefined) {
    composition.audio = value.audio as Composition["audio"];
  }
  if (value.transcripts !== undefined) {
    composition.transcripts = value.transcripts as Composition["transcripts"];
  }

  return Object.freeze(composition);
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

/**
 * Merges a render's prop overrides over composition defaults, validates the
 * result as JSON, runs the composition's optional validator, and deep-freezes it.
 */
export function resolveProps<P extends Props>(composition: Composition<P>, overrides?: unknown): Readonly<P> {
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new FrameyardError("PROPS_INVALID", "Props must be a plain JSON object.");
  }

  const merged = {
    ...composition.defaultProps,
    ...(overrides as Record<string, JsonValue> | undefined),
  };

  assertJsonSerializable(merged, "props");

  if (composition.validateProps) {
    let errors: void | string[];
    try {
      errors = composition.validateProps(merged as P);
    } catch (error) {
      throw new FrameyardError(
        "PROPS_INVALID",
        `Props validation failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
    if (errors !== undefined) {
      if (!Array.isArray(errors) || errors.some((item) => typeof item !== "string")) {
        throw new FrameyardError("PROPS_INVALID", "validateProps() must return void or an array of strings.");
      }
      if (errors.length > 0) {
        throw new FrameyardError("PROPS_INVALID", `Invalid props: ${errors.join("; ")}`);
      }
    }
  }

  return deepFreeze(merged) as Readonly<P>;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function normalizeAudioClip(value: unknown, index: number): ResolvedAudioClip {
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

/** Resolves and validates a composition's declarative audio timeline. */
export function resolveAudioClips<P extends Props>(
  composition: Composition<P>,
  props: Readonly<P>,
): readonly ResolvedAudioClip[] {
  let clips: unknown = composition.audio;

  if (typeof composition.audio === "function") {
    try {
      clips = composition.audio({ props });
    } catch (error) {
      throw new FrameyardError(
        "AUDIO_INVALID",
        `Could not resolve the audio timeline: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  if (clips === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(clips)) {
    throw new FrameyardError("AUDIO_INVALID", "Composition audio must resolve to an array of clips.");
  }

  return Object.freeze(clips.map((clip, index) => normalizeAudioClip(clip, index)));
}

function normalizeTranscriptClip(value: unknown, index: number): ResolvedTranscriptClip {
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

/** Resolves and validates a composition's declarative transcript requirements. */
export function resolveTranscriptClips<P extends Props>(
  composition: Composition<P>,
  props: Readonly<P>,
): readonly ResolvedTranscriptClip[] {
  let clips: unknown = composition.transcripts;

  if (typeof composition.transcripts === "function") {
    try {
      clips = composition.transcripts({ props });
    } catch (error) {
      throw new FrameyardError(
        "TRANSCRIPT_INVALID",
        `Could not resolve transcript requirements: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  if (clips === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(clips)) {
    throw new FrameyardError("TRANSCRIPT_INVALID", "Composition transcripts must resolve to an array of assets.");
  }

  return Object.freeze(clips.map((clip, index) => normalizeTranscriptClip(clip, index)));
}

export { isPlainObject };
