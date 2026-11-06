/**
 * Opt-in stage timings for the timeline renderer. Enable with
 * `FRAMEYARD_TIMINGS=1`; each event is one JSON line on stderr so stdout keeps
 * the public `--json` result contract. This is a profiling aid, not a public
 * output format.
 */

const enabled = process.env.FRAMEYARD_TIMINGS === "1";

export function timingsEnabled(): boolean {
  return enabled;
}

export interface Timing {
  finish(details?: Record<string, unknown>): void;
}

/** Starts a timing; when disabled it is a no-op with no measurable overhead. */
export function startTiming(event: string, details: Record<string, unknown> = {}): Timing {
  if (!enabled) {
    return { finish: () => undefined };
  }
  const startedAt = performance.now();
  return {
    finish(extra) {
      process.stderr.write(
        `${JSON.stringify({
          type: "fy-timing",
          event,
          ms: Number((performance.now() - startedAt).toFixed(3)),
          ...details,
          ...extra,
        })}\n`,
      );
    },
  };
}
