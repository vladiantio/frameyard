export { readCompositionDescriptor } from "./descriptor.js";
export type {
  CompositionDescriptor,
  CompositionDescriptorResult,
  ReadCompositionDescriptorOptions,
} from "./descriptor.js";
export { readAnimationDeclarations } from "./animation.js";
export type { AnimationDeclaration, AnimationDeclarations, ReadAnimationDeclarationsOptions } from "./animation.js";
export { readMediaDeclarations, readMediaSpec } from "./media.js";
export type { MediaDeclaration, MediaDeclarations, MediaSpec, ReadMediaDeclarationsOptions } from "./media.js";
export { readTranscriptDeclarations } from "./transcripts.js";
export type {
  ReadTranscriptDeclarationsOptions,
  TranscriptDeclaration,
  TranscriptDeclarations,
} from "./transcripts.js";
export { KNOWN_DATA_FY_ATTRIBUTES, isAnimationAttribute, isMediaAttribute } from "./attributes.js";
export type { DocumentAdapter, DocumentAttribute, SourceLocation } from "./adapter.js";
export { isLocalRelative, isRemote } from "./paths.js";
