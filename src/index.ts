export { VERSION, VERSION as version } from "./version.js";
export {
  assertJsonSerializable,
  isPlainObject,
  mergeProps,
  normalizeAudioClip,
  normalizeTranscriptClip,
} from "./contracts.js";
export type {
  AudioClip,
  CompositionDiagnostic,
  CompositionDiagnosticDetails,
  CompositionMetadata,
  CompositionSourceInfo,
  ControllerDeclaration,
  DiagnosticSeverity,
  FrameyardHost,
  JsonPrimitive,
  JsonValue,
  Props,
  ResolvedAudioClip,
  ResolvedTranscriptClip,
  TranscriptClip,
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
export { parseTimelineDocument } from "./timeline/schema.js";
export type {
  FitPolicy,
  ParseTimelineResult,
  TimelineClip,
  TimelineClipAudio,
  TimelineDocument,
  TimelineSource,
  TimelineSourceComposition,
  TimelineSourceMedia,
  TimelineSourceTimeline,
  TimelineSourceKind,
  TimelineTrack,
  TimelineTrackKind,
  TimelineTransform,
} from "./timeline/schema.js";
