import type { ResolvedTimeline, ResolvedTimelineClip } from "./resolve.js";

export interface TimelineRenderLayer {
  clip: ResolvedTimelineClip;
  /** Source frame used at the segment's first timeline frame. */
  sourceStart: number;
}

export interface TimelineRenderSegment {
  index: number;
  /** Inclusive first timeline frame. */
  start: number;
  /** Exclusive last timeline frame. */
  end: number;
  frames: number;
  /** Visual layers from bottom to top. */
  layers: TimelineRenderLayer[];
}

export interface TimelineRenderPlan {
  timeline: ResolvedTimeline;
  maxSegmentFrames: number;
  segments: TimelineRenderSegment[];
}

function isVisualClip(clip: ResolvedTimelineClip): boolean {
  return clip.source.kind !== "audio";
}

/**
 * Splits a resolved timeline at visual clip boundaries and a maximum segment
 * duration. Every segment has a fixed set of visual layers; audio is mixed
 * globally and never appears here.
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

  const visualClips = timeline.clips.filter(isVisualClip);
  const boundaries = new Set<number>([startFrame, endFrame]);
  for (const clip of visualClips) {
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

  const trackOrder = new Map(timeline.tracks.map((track, index) => [track.id, index]));
  const segments: TimelineRenderSegment[] = ranges.map((range, index) => {
    const layers = visualClips
      .filter((clip) => clip.start <= range.start && clip.end >= range.end)
      .sort((left, right) => {
        const leftOrder = trackOrder.get(left.track) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = trackOrder.get(right.track) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder;
      })
      .map((clip) => ({
        clip,
        sourceStart: clip.sourceIn + (range.start - clip.start),
      }));

    return {
      index,
      start: range.start,
      end: range.end,
      frames: range.end - range.start,
      layers,
    };
  });

  return { timeline, maxSegmentFrames, segments };
}
