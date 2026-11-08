import { boldText, colors, dimText } from "./ui.js";
import type { ProgressPhase } from "../renderer/progress.js";

export type { ProgressPhase } from "../renderer/progress.js";

/**
 * Progress events from composition checks and renders, and from timeline
 * checks and renders. Timeline events add the completed segment.
 */
export interface RenderProgressEvent {
  frame: number;
  total: number;
  elapsedMs: number;
  segment?: number;
  segments?: number;
  phase?: ProgressPhase;
  /** True when the phase has no frame-level progress, such as encoder drain. */
  indeterminate?: boolean;
  /** Optional short suffix for a phase, such as "audio" or "output". */
  detail?: string;
}

export type ProgressReporter = ((event: RenderProgressEvent) => void) & {
  /** Ends a live line if the renderer never emitted a final event. */
  finish: () => void;
};

const CLEAR_LINE = "\r\u001b[2K";

const PHASE_LABELS: Record<ProgressPhase, string> = {
  checking: "Checking",
  capturing: "Capturing",
  rendering: "Rendering",
  encoding: "Encoding",
  muxing: "Muxing",
  finalizing: "Finalizing",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

let active: { clear: () => boolean } | undefined;

/**
 * Clears a live progress line before an error or cancellation message.
 * Returns true when a line was active.
 */
export function clearActiveProgress(): boolean {
  if (active === undefined) {
    return false;
  }
  const current = active;
  active = undefined;
  return current.clear();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "?";
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function rateFor(frame: number, elapsedMs: number): number | undefined {
  if (frame < 5 || elapsedMs < 500) {
    return undefined;
  }
  return frame / (elapsedMs / 1000);
}

function etaFor(frame: number, total: number, rate: number | undefined): number | undefined {
  if (rate === undefined || rate <= 0 || frame >= total) {
    return undefined;
  }
  return (total - frame) / rate;
}

function percentFor(frame: number, total: number): number {
  return total <= 0 ? 100 : Math.min(100, Math.floor((frame / total) * 100));
}

function barFor(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  return `${colors.cyan("█".repeat(filled))}${colors.dim("░".repeat(Math.max(0, width - filled)))}`;
}

function liveLine(options: {
  label: string;
  event: RenderProgressEvent;
  frame: number;
  percent: number;
  completedSegments: number;
  totalSegments: number;
}): string {
  const columns = process.stderr.columns > 0 ? process.stderr.columns : 80;
  const compact = columns < 96;
  const barWidth = compact ? 12 : 20;
  const rate = rateFor(options.frame, options.event.elapsedMs);
  const eta = etaFor(options.frame, options.event.total, rate);
  const parts = [
    boldText(options.label),
    barFor(options.percent, barWidth),
    colors.bold(`${String(options.percent).padStart(3)}%`),
    `${options.frame}/${options.event.total}`,
    dimText(formatDuration(options.event.elapsedMs / 1000)),
  ];
  if (!compact) {
    if (rate !== undefined) {
      parts.push(dimText(`${rate.toFixed(1)} fps`));
    }
    if (eta !== undefined) {
      parts.push(dimText(`ETA ${formatDuration(eta)}`));
    }
  }
  if (options.totalSegments > 1) {
    parts.push(dimText(`segments ${options.completedSegments}/${options.totalSegments}`));
  }
  return parts.join("  ");
}

function logLine(options: {
  label: string;
  event: RenderProgressEvent;
  frame: number;
  percent: number;
  completedSegments: number;
  totalSegments: number;
}): string {
  const rate = rateFor(options.frame, options.event.elapsedMs);
  const eta = etaFor(options.frame, options.event.total, rate);
  const parts = [
    `${options.label} ${options.frame}/${options.event.total} (${options.percent}%)`,
    formatDuration(options.event.elapsedMs / 1000),
  ];
  if (rate !== undefined) {
    parts.push(`${rate.toFixed(1)} fps`);
  }
  if (eta !== undefined) {
    parts.push(`ETA ${formatDuration(eta)}`);
  }
  if (options.totalSegments > 1) {
    parts.push(`segments ${options.completedSegments}/${options.totalSegments}`);
  }
  return parts.join(" ");
}

function phaseLabel(event: RenderProgressEvent & { phase: ProgressPhase }): string {
  return `${PHASE_LABELS[event.phase]}${event.detail ? ` ${event.detail}` : ""}`;
}

/**
 * Creates a progress reporter. On a terminal it paints one live line with a
 * bar, rate, ETA, and timeline segments, plus a spinner for phases without
 * frame-level progress. Elsewhere it writes a line at every ten percent and
 * one line per phase change so CI logs stay readable.
 */
export function progressReporter(label: string): ProgressReporter {
  const live = process.stderr.isTTY === true && process.env.TERM !== "dumb";
  const completedSegments = new Set<number>();
  let totalSegments = 0;
  let maxFrame = 0;
  let nextPercent = 0;
  let lastPaint = 0;
  let lastLogFrame = -1;
  let lastLogPercent = -1;
  let lastLogSegments = "";
  let finished = false;
  let liveVisible = false;
  let currentPhase: ProgressPhase | undefined;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerIndex = 0;
  let phaseStartedAt = 0;
  let phaseText = "";

  const stopSpinner = (): void => {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const clearLive = (): boolean => {
    stopSpinner();
    if (!liveVisible) {
      active = undefined;
      return false;
    }
    process.stderr.write(CLEAR_LINE);
    liveVisible = false;
    active = undefined;
    return true;
  };

  const paint = (text: string, endLine: boolean): void => {
    process.stderr.write(`${CLEAR_LINE}${text}${endLine ? "\n" : ""}`);
    liveVisible = !endLine;
    active = endLine ? undefined : { clear: clearLive };
  };

  const spinnerLine = (): string => {
    const elapsed = (performance.now() - phaseStartedAt) / 1000;
    const frame = SPINNER[spinnerIndex % SPINNER.length] as string;
    spinnerIndex += 1;
    return `${colors.cyan(frame)}  ${boldText(phaseText)}  ${dimText(formatDuration(elapsed))}`;
  };

  const startPhase = (event: RenderProgressEvent & { phase: ProgressPhase }): void => {
    clearLive();
    currentPhase = event.phase;
    phaseStartedAt = performance.now();
    phaseText = phaseLabel(event);
    spinnerIndex = 0;
    paint(spinnerLine(), false);
    spinnerTimer = setInterval(() => {
      if (liveVisible && !finished) {
        process.stderr.write(`${CLEAR_LINE}${spinnerLine()}`);
      }
    }, 100);
    spinnerTimer.unref();
  };

  const finish = (): void => {
    if (finished) {
      return;
    }
    clearLive();
    finished = true;
  };

  const reporter = ((event: RenderProgressEvent): void => {
    if (finished) {
      return;
    }

    if (event.indeterminate === true && event.phase !== undefined) {
      const text = phaseLabel({ ...event, phase: event.phase });
      if (!live) {
        if (text !== phaseText) {
          phaseText = text;
          currentPhase = event.phase;
          process.stderr.write(`${text}...\n`);
        }
        return;
      }
      if (text !== phaseText || !liveVisible) {
        startPhase({ ...event, phase: event.phase });
      }
      return;
    }

    if (event.segments !== undefined) {
      totalSegments = event.segments;
    }
    if (event.segment !== undefined) {
      completedSegments.add(event.segment);
    }
    maxFrame = Math.max(maxFrame, Math.min(event.frame, event.total <= 0 ? event.frame : event.total));
    const percent = percentFor(maxFrame, event.total);
    const isComplete = event.total > 0 && maxFrame >= event.total;
    if (event.phase !== undefined && event.phase !== currentPhase) {
      currentPhase = event.phase;
      nextPercent = 0;
      if (live) {
        clearLive();
      }
    }
    const phase = event.phase === undefined ? label : PHASE_LABELS[event.phase];
    const details = {
      label: phase,
      event,
      frame: maxFrame,
      percent,
      completedSegments: completedSegments.size,
      totalSegments,
    };

    if (live) {
      const now = performance.now();
      if (!isComplete && now - lastPaint < 80) {
        return;
      }
      lastPaint = now;
      paint(liveLine(details), isComplete);
      return;
    }

    if (!isComplete && percent < nextPercent) {
      return;
    }
    const segmentKey = totalSegments > 1 ? `${completedSegments.size}/${totalSegments}` : "";
    if (maxFrame === lastLogFrame && percent === lastLogPercent && segmentKey === lastLogSegments) {
      return;
    }
    lastLogFrame = maxFrame;
    lastLogPercent = percent;
    lastLogSegments = segmentKey;
    nextPercent = percent + 10;
    process.stderr.write(`${logLine(details)}\n`);
  }) as ProgressReporter;

  reporter.finish = finish;
  return reporter;
}

const NOOP_REPORTER: ProgressReporter = Object.assign((_event: RenderProgressEvent): void => {}, {
  finish: (): void => {},
});

/**
 * Runs one render stage with a reporter and guarantees that a live line never
 * leaks into the final summary or an error message.
 */
export async function withProgress<T>(
  label: string,
  enabled: boolean,
  task: (onProgress: ProgressReporter) => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return task(NOOP_REPORTER);
  }
  const reporter = progressReporter(label);
  try {
    return await task(reporter);
  } finally {
    reporter.finish();
  }
}
