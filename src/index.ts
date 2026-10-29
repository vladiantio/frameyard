export { VERSION, VERSION as version } from "./version.js";
export {
  assertJsonSerializable,
  defineComposition,
  normalizeComposition,
  resolveAudioClips,
  resolveProps,
  resolveTranscriptClips,
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
  ResolvedTranscriptClip,
  TranscriptClip,
  UpdateContext,
} from "./contracts.js";
export { FrameyardError, errorMessage, isFrameyardError } from "./errors.js";
export type { FrameyardErrorCode } from "./errors.js";
export { TRANSCRIPT_SCHEMA_VERSION, parseTranscript, transcriptToSrt, transcriptToVtt } from "./transcript.js";
export type {
  ParseTranscriptOptions,
  Transcript,
  TranscriptSegment,
  TranscriptSource,
  WordTiming,
} from "./transcript.js";
