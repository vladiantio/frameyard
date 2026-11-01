import type { CompositionDiagnostic, Props } from "../contracts.js";

export type TimelinePreviewFit = "contain" | "cover" | "stretch";

export interface TimelinePreviewTransform {
  fit: TimelinePreviewFit;
  x: number;
  y: number;
  width?: number;
  height?: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface TimelinePreviewClipAudio {
  muted: boolean;
  gain: number;
}

export interface TimelinePreviewCompositionSource {
  kind: "composition";
  id: string;
  url: string;
  width: number;
  height: number;
  durationInFrames: number;
}

export interface TimelinePreviewNestedTimelineSource {
  kind: "timeline";
  id: string;
  url: string;
  width: number;
  height: number;
  durationInFrames: number;
}

export interface TimelinePreviewMediaSource {
  kind: "video" | "image" | "audio";
  src: string;
  url: string;
  width?: number;
  height?: number;
  durationInFrames?: number;
  hasAudio?: boolean;
}

export type TimelinePreviewSource =
  | TimelinePreviewCompositionSource
  | TimelinePreviewNestedTimelineSource
  | TimelinePreviewMediaSource;

export interface TimelinePreviewClip {
  id: string;
  track: string;
  source: TimelinePreviewSource;
  start: number;
  duration: number;
  end: number;
  sourceIn: number;
  props?: Props;
  transform: TimelinePreviewTransform;
  audio: TimelinePreviewClipAudio;
}

export interface TimelinePreviewTrack {
  id: string;
  kind: "video" | "audio";
  name?: string;
  gain?: number;
  muted?: boolean;
}

export interface TimelinePreviewAudioClip {
  src: string;
  url: string;
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
}

export interface TimelinePreviewData {
  timeline: string;
  entry: string;
  format: { width: number; height: number; fps: number };
  durationInFrames: number;
  background?: string;
  tracks: TimelinePreviewTrack[];
  clips: TimelinePreviewClip[];
  audioClips: TimelinePreviewAudioClip[];
  diagnostics: CompositionDiagnostic[];
}
