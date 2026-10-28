export { VERSION, VERSION as version } from "./version.js";
export {
  assertJsonSerializable,
  defineComposition,
  normalizeComposition,
  resolveAudioClips,
  resolveProps,
} from "./contracts.js";
export type {
  AudioClip,
  AudioContext,
  Composition,
  CompositionDefinition,
  CompositionMetadata,
  JsonPrimitive,
  JsonValue,
  MountContext,
  Props,
  ResolvedAudioClip,
  UpdateContext,
} from "./contracts.js";
export { FrameyardError, errorMessage, isFrameyardError } from "./errors.js";
export type { FrameyardErrorCode } from "./errors.js";
