export { VERSION, VERSION as version } from "./version.js";
export {
  assertJsonSerializable,
  isPlainObject,
  isStaticCompositionMetadata,
  mergeProps,
  normalizeAudioClip,
  normalizeTranscriptClip,
} from "./contracts.js";
export type {
  AudioClip,
  CompositionDiagnostic,
  CompositionDiagnosticDetails,
  CompositionDimensions,
  CompositionFormat,
  CompositionMetadata,
  CompositionSourceInfo,
  ControllerDeclaration,
  DeclaredCompositionMetadata,
  DeclaredFormat,
  DiagnosticSeverity,
  FrameyardHost,
  JsonPrimitive,
  JsonValue,
  Props,
  ResolvedAudioClip,
  ResolvedCompositionMetadata,
  ResolvedTranscriptClip,
  StaticCompositionMetadata,
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
export { BLEND_MODES, parseTimelineDocument, UNSUPPORTED_BLEND_MODES } from "./timeline/schema.js";
export type {
  BlendMode,
  FitPolicy,
  ParseTimelineResult,
  TimelineClip,
  TimelineClipAudio,
  TimelineDocument,
  TimelineKeyframe,
  TimelineKeyframeChannel,
  TimelineKeyframeTrack,
  TimelineKeyframes,
  TimelineSource,
  TimelineSourceComposition,
  TimelineSourceMedia,
  TimelineSourceTimeline,
  TimelineSourceKind,
  TimelineTrack,
  TimelineTrackKind,
  TimelineTransform,
} from "./timeline/schema.js";
