import { easeProgress, easingFor } from "./easing.js";
import {
  KEYFRAME_CHANNELS,
  type TimelineKeyframe,
  type TimelineKeyframeChannel,
  type TimelineKeyframes,
  type TimelineTransform,
} from "./schema.js";

export type KeyframeChannel = TimelineKeyframeChannel;

export interface PresentationValues {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

function intervalIndex(keys: readonly TimelineKeyframe[], frame: number): number {
  let low = 0;
  let high = keys.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((keys[middle] as TimelineKeyframe).frame <= frame) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * Evaluates one channel at a clip-local frame. Keys are sorted and validated by
 * the schema/resolver. Values before the first key and after the last key hold.
 */
export function evaluateKeyframeTrack(keys: readonly TimelineKeyframe[], frame: number): number {
  if (keys.length === 0) {
    throw new Error("Cannot evaluate an empty keyframe track.");
  }
  const first = keys[0] as TimelineKeyframe;
  if (frame <= first.frame) {
    return first.value;
  }
  const last = keys[keys.length - 1] as TimelineKeyframe;
  if (frame >= last.frame) {
    return last.value;
  }

  const index = intervalIndex(keys, frame);
  const from = keys[index] as TimelineKeyframe;
  const to = keys[index + 1] as TimelineKeyframe;
  if (frame === from.frame) {
    return from.value;
  }
  const progress = (frame - from.frame) / (to.frame - from.frame);
  const eased = easeProgress(easingFor(from.easing), progress);
  return from.value + (to.value - from.value) * eased;
}

/** Resolves every presentation channel for a clip-local frame. */
export function evaluatePresentation(
  transform: TimelineTransform,
  keyframes: TimelineKeyframes | undefined,
  localFrame: number,
): PresentationValues {
  const values: PresentationValues = {
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
    rotation: transform.rotation,
    opacity: transform.opacity,
  };
  if (keyframes) {
    for (const channel of KEYFRAME_CHANNELS) {
      const track = keyframes[channel];
      if (track !== undefined) {
        values[channel] = evaluateKeyframeTrack(track, localFrame);
      }
    }
  }
  // Easing may overshoot. Alpha is clamped by CSS, and a negative scale would
  // mirror a layer that the static schema forbids from being negative.
  values.scale = Math.max(0, values.scale);
  values.opacity = Math.min(1, Math.max(0, values.opacity));
  return values;
}

export function keyframeMarkerFrames(keyframes: TimelineKeyframes | undefined): number[] {
  if (!keyframes) {
    return [];
  }
  const frames = new Set<number>();
  for (const channel of KEYFRAME_CHANNELS) {
    for (const key of keyframes[channel] ?? []) {
      frames.add(key.frame);
    }
  }
  return [...frames].sort((left, right) => left - right);
}

export function keyframeChannelsAt(
  keyframes: TimelineKeyframes | undefined,
  frame: number,
): Array<{ channel: KeyframeChannel; value: number; easing?: string }> {
  if (!keyframes) {
    return [];
  }
  const channels: Array<{ channel: KeyframeChannel; value: number; easing?: string }> = [];
  for (const channel of KEYFRAME_CHANNELS) {
    const key = keyframes[channel]?.find((entry) => entry.frame === frame);
    if (key) {
      channels.push({
        channel,
        value: key.value,
        ...(key.easing !== undefined ? { easing: key.easing } : {}),
      });
    }
  }
  return channels;
}
