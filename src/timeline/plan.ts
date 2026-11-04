import type { ResolvedTimeline, ResolvedTimelineSource } from "./resolve.js";
import { projectScene, type TimelineSceneLayer } from "./scene.js";

export interface TimelineRenderSegment {
  index: number;
  /** Inclusive first timeline frame. */
  start: number;
  /** Exclusive last timeline frame. */
  end: number;
  frames: number;
  /** Visual layers from bottom to top. */
  layers: TimelineSceneLayer<ResolvedTimelineSource>[];
}

export interface TimelineRenderPlan {
  segments: TimelineRenderSegment[];
}

/**
 * Splits a resolved timeline into independently renderable segments. Segment
 * boundaries fall on visual clip starts and ends, so every segment has a fixed
 * scene projection; audio is mixed globally and never appears here.
 */
export function planTimelineRender(
  timeline: ResolvedTimeline,
  options: { maxSegmentFrames?: number; startFrame?: number; endFrame?: number } = {},
): TimelineRenderPlan {
  const maxSegmentFrames = options.maxSegmentFrames ?? Math.max(1, Math.round(timeline.format.fps * 10));
  if (!Number.isInteger(maxSegmentFrames) || maxSegmentFrames <= 0) {
    throw new Error("maxSegmentFrames must be a positive integer.");
  }
  const startFrame = options.startFrame ?? 0;
  const endFrame = options.endFrame ?? timeline.durationInFrames;
  if (
    !Number.isInteger(startFrame) ||
    !Number.isInteger(endFrame) ||
    startFrame < 0 ||
    endFrame > timeline.durationInFrames ||
    endFrame <= startFrame
  ) {
    throw new Error(`Invalid timeline range ${startFrame}..${endFrame}.`);
  }

  const boundaries = new Set<number>([startFrame, endFrame]);
  const videoTracks = new Set(timeline.tracks.filter((track) => track.kind === "video").map((track) => track.id));
  for (const clip of timeline.clips) {
    if (!videoTracks.has(clip.track)) {
      continue;
    }
    if (clip.start > startFrame && clip.start < endFrame) {
      boundaries.add(clip.start);
    }
    if (clip.end > startFrame && clip.end < endFrame) {
      boundaries.add(clip.end);
    }
  }

  const ordered = [...boundaries].sort((left, right) => left - right);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const start = ordered[index - 1] as number;
    const end = ordered[index] as number;
    if (end <= start) {
      continue;
    }
    for (let cursor = start; cursor < end; cursor += maxSegmentFrames) {
      ranges.push({ start: cursor, end: Math.min(end, cursor + maxSegmentFrames) });
    }
  }

  const segments = ranges.map((range, index) => ({
    index,
    start: range.start,
    end: range.end,
    frames: range.end - range.start,
    layers: projectScene<ResolvedTimelineSource>(timeline, range.start, range.end).layers,
  }));

  return { segments };
}
