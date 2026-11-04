import type { AudioVolumeEnvelope, CompositionDiagnostic } from "../contracts.js";
import type {
  TimelineSceneClip,
  TimelineSceneCompositionSource,
  TimelineSceneInput,
  TimelineSceneMediaSource,
  TimelineSceneNestedSource,
  TimelineSceneTransition,
} from "../timeline/scene.js";

export interface TimelinePreviewCompositionSource extends TimelineSceneCompositionSource {
  url: string;
}

export interface TimelinePreviewNestedSource extends TimelineSceneNestedSource {
  url: string;
}

export interface TimelinePreviewMediaSource extends TimelineSceneMediaSource {
  url: string;
}

export type TimelinePreviewSource =
  | TimelinePreviewCompositionSource
  | TimelinePreviewNestedSource
  | TimelinePreviewMediaSource;

/** A resolved timeline clip with a browser-fetchable URL on its source. */
export type TimelinePreviewClip = TimelineSceneClip<TimelinePreviewSource>;

export type TimelinePreviewTransition = TimelineSceneTransition;

export interface TimelinePreviewAudioClip {
  src: string;
  url: string;
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
  envelopes?: AudioVolumeEnvelope[];
}

/**
 * The serialized resolved timeline the preview host projects on every seek.
 * Absolute paths are replaced by URLs; everything else keeps the resolved
 * shape so the scene module can run in the browser unchanged.
 */
export interface TimelinePreviewData extends TimelineSceneInput<TimelinePreviewSource> {
  timeline: string;
  entry: string;
  background?: string;
  audioClips: TimelinePreviewAudioClip[];
  diagnostics: CompositionDiagnostic[];
}
