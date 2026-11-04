import type { Props } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import {
  DEFAULT_TIMELINE_TRANSFORM,
  type BlendMode,
  type TimelineClipAudio,
  type TimelineKeyframes,
  type TimelineTrack,
  type TimelineTransform,
  type TransitionKind,
} from "./schema.js";
import type { TransitionRole, TransitionWindow } from "./transitions.js";

/** The fixed dimensions and frame rate a timeline scene is projected against. */
export interface TimelineSceneFormat {
  width: number;
  height: number;
  fps: number;
}

/** The fields a timeline scene needs from a composition clip source. */
export interface TimelineSceneCompositionSource {
  kind: "composition";
  id: string;
  metadata: {
    width: number;
    height: number;
    fps?: number;
    durationInFrames?: number;
    static?: boolean;
  };
}

/** The fields a timeline scene needs from a nested-timeline clip source. */
export interface TimelineSceneNestedSource {
  kind: "timeline";
  id: string;
  durationInFrames: number;
  timeline: {
    format: TimelineSceneFormat;
    durationInFrames: number;
    background?: string;
  };
}

/** The fields a timeline scene needs from a media clip source. */
export interface TimelineSceneMediaSource {
  kind: "video" | "image" | "audio";
  src: string;
  width?: number;
  height?: number;
  durationInFrames?: number;
  hasAudio?: boolean;
}

export type TimelineSceneSource = TimelineSceneCompositionSource | TimelineSceneNestedSource | TimelineSceneMediaSource;

/**
 * A resolved timeline clip as the scene projection sees it. The preview payload
 * is the same shape with a `url` added to each source, so both sides share one
 * clip model instead of maintaining a second one.
 */
export interface TimelineSceneClip<S extends TimelineSceneSource = TimelineSceneSource> {
  id: string;
  track: string;
  source: S;
  start: number;
  duration: number;
  end: number;
  sourceIn: number;
  props?: Props;
  transform?: TimelineTransform;
  keyframes?: TimelineKeyframes;
  blend?: BlendMode;
  audio?: TimelineClipAudio;
}

export interface TimelineSceneTransition {
  from: string;
  to: string;
  kind: TransitionKind;
  easing?: string;
  track: string;
  start: number;
  end: number;
}

/** The minimal resolved-timeline shape the scene projection reads. */
export interface TimelineSceneInput<S extends TimelineSceneSource = TimelineSceneSource> {
  format: TimelineSceneFormat;
  durationInFrames: number;
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineSceneClip<S>[];
  transitions: readonly TimelineSceneTransition[];
}

/** What the capture path does to turn a scene layer's source into pixels. */
export type TimelineCaptureMode = "frames" | "still" | "video" | "image" | "nested";

/**
 * One active visual clip at a timeline frame or over a render range. Array order
 * is composite order: later layers paint above earlier ones.
 */
export interface TimelineSceneLayer<S extends TimelineSceneSource = TimelineSceneSource> {
  clip: TimelineSceneClip<S>;
  capture: TimelineCaptureMode;
  /** The source frame at the projected range's first timeline frame. */
  sourceStart: number;
  sourceWidth: number;
  sourceHeight: number;
  transform: TimelineTransform;
  keyframes?: TimelineKeyframes;
  blend: BlendMode;
  transition?: {
    window: TransitionWindow;
    role: TransitionRole;
  };
}

export interface TimelineScene<S extends TimelineSceneSource = TimelineSceneSource> {
  timeline: TimelineSceneInput<S>;
  /** Inclusive first timeline frame. */
  start: number;
  /** Exclusive last timeline frame. */
  end: number;
  /** Visual layers from bottom to top. */
  layers: TimelineSceneLayer<S>[];
}

/** One side of a declared transition, in absolute timeline frames. */
export interface TimelineTransitionSpan extends TransitionWindow {
  role: TransitionRole;
}

/**
 * Pairs each transition with its outgoing and incoming clip. Visual scenes and
 * timeline audio both consume this so the window and roles are defined once.
 */
export function transitionSpans(
  timeline: Pick<TimelineSceneInput, "transitions">,
): Map<string, TimelineTransitionSpan[]> {
  const spans = new Map<string, TimelineTransitionSpan[]>();
  for (const transition of timeline.transitions) {
    const window: TransitionWindow = {
      start: transition.start,
      end: transition.end,
      ...(transition.easing !== undefined ? { easing: transition.easing } : {}),
    };
    const outgoing = spans.get(transition.from) ?? [];
    outgoing.push({ role: "out", ...window });
    spans.set(transition.from, outgoing);
    const incoming = spans.get(transition.to) ?? [];
    incoming.push({ role: "in", ...window });
    spans.set(transition.to, incoming);
  }
  return spans;
}

function projectLayer<S extends TimelineSceneSource>(
  clip: TimelineSceneClip<S>,
  start: number,
  end: number,
  spans: ReadonlyMap<string, TimelineTransitionSpan[]>,
): TimelineSceneLayer<S> {
  const source = clip.source;
  let capture: TimelineCaptureMode;
  let sourceWidth: number;
  let sourceHeight: number;

  switch (source.kind) {
    case "composition":
      capture = source.metadata.static === true ? "still" : "frames";
      sourceWidth = source.metadata.width;
      sourceHeight = source.metadata.height;
      break;
    case "timeline":
      capture = "nested";
      sourceWidth = source.timeline.format.width;
      sourceHeight = source.timeline.format.height;
      break;
    case "video":
    case "image":
      if (source.width === undefined || source.height === undefined) {
        throw new FrameyardError(
          "TIMELINE_MEDIA_INVALID",
          `Media ${source.src} is missing width/height metadata for clip "${clip.id}".`,
        );
      }
      capture = source.kind;
      sourceWidth = source.width;
      sourceHeight = source.height;
      break;
    case "audio":
      throw new FrameyardError("INTERNAL", `Clip "${clip.id}" is audio-only and has no visual scene layer.`);
  }

  const span = (spans.get(clip.id) ?? []).find((candidate) => candidate.start < end && candidate.end > start);

  return {
    clip,
    capture,
    sourceStart: clip.sourceIn + (start - clip.start),
    sourceWidth,
    sourceHeight,
    transform: clip.transform ?? { ...DEFAULT_TIMELINE_TRANSFORM },
    ...(clip.keyframes !== undefined ? { keyframes: clip.keyframes } : {}),
    blend: clip.blend ?? "normal",
    ...(span !== undefined
      ? {
          transition: {
            window: {
              start: span.start,
              end: span.end,
              ...(span.easing !== undefined ? { easing: span.easing } : {}),
            },
            role: span.role,
          },
        }
      : {}),
  };
}

/**
 * Projects a resolved timeline onto one render range. Every returned layer is
 * active for the whole range; a single frame is a one-frame range. Nested
 * timelines stay sources and are projected recursively when they are captured.
 */
export function projectScene<S extends TimelineSceneSource>(
  timeline: TimelineSceneInput<S>,
  start: number,
  end: number,
): TimelineScene<S> {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > timeline.durationInFrames ||
    end <= start
  ) {
    throw new FrameyardError("TIMELINE_INVALID", `Invalid timeline range ${start}..${end}.`);
  }

  const spans = transitionSpans(timeline);
  const trackOrder = new Map(timeline.tracks.map((track, index) => [track.id, index]));
  const videoTracks = new Set(timeline.tracks.filter((track) => track.kind === "video").map((track) => track.id));
  const layers = timeline.clips
    .filter((clip) => videoTracks.has(clip.track))
    .filter((clip) => clip.start <= start && clip.end >= end)
    .sort((left, right) => {
      const leftOrder = trackOrder.get(left.track) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = trackOrder.get(right.track) ?? Number.MAX_SAFE_INTEGER;
      // Within one track, the later-starting clip composites above the
      // outgoing clip during a transition overlap.
      return leftOrder - rightOrder || left.start - right.start || left.end - right.end;
    })
    .map((clip) => projectLayer(clip, start, end, spans));

  return { timeline, start, end, layers };
}

/** Projects one timeline frame. */
export function projectSceneAtFrame<S extends TimelineSceneSource>(
  timeline: TimelineSceneInput<S>,
  frame: number,
): TimelineScene<S> {
  return projectScene(timeline, frame, frame + 1);
}
