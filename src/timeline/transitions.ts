import { easeProgress, easingFor } from "./easing.js";

/** The overlap window of one transition, in absolute timeline frames. */
export interface TransitionWindow {
  /** Inclusive first timeline frame. */
  start: number;
  /** Exclusive last timeline frame. */
  end: number;
  /** CSS timing function applied to the progress. Defaults to `linear`. */
  easing?: string;
}

export type TransitionRole = "in" | "out";

/**
 * Eased 0..1 progress of a transition at an absolute timeline frame. Frames
 * outside the window clamp to 0 or 1, so segment boundaries never change values.
 */
export function transitionProgress(window: TransitionWindow, frame: number): number {
  const length = window.end - window.start;
  if (length <= 0) {
    return 1;
  }
  const raw = (frame - window.start) / length;
  return easeProgress(easingFor(window.easing), Math.max(0, Math.min(1, raw)));
}

/**
 * Equal-power gain for one side of a transition at an absolute timeline frame.
 * The incoming clip ramps as `sqrt(t)`; the outgoing as `sqrt(1 - t)`.
 */
export function transitionGain(window: TransitionWindow, frame: number, role: TransitionRole): number {
  const progress = transitionProgress(window, frame);
  const value = role === "in" ? progress : 1 - progress;
  return Math.sqrt(Math.max(0, Math.min(1, value)));
}
