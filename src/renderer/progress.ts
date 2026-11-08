/** Phases reported by the composition and timeline renderers. */
export type ProgressPhase = "checking" | "capturing" | "rendering" | "encoding" | "muxing" | "finalizing";

export interface ProgressEvent {
  /**
   * Completed frames. Parallel timeline renders sum per-segment work, so this
   * is a progress counter rather than the timeline playhead.
   */
  frame: number;
  total: number;
  elapsedMs: number;
  phase?: ProgressPhase;
  /** True when the phase has no frame-level progress, such as encoder drain. */
  indeterminate?: boolean;
  /** Optional short suffix for a phase, such as "audio" or "output". */
  detail?: string;
}

export interface TimelineProgressEvent extends ProgressEvent {
  /** One-based segment number, present on segment completion events. */
  segment?: number;
  segments?: number;
}
