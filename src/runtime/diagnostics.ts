export type DiagnosticSink = (warning: string) => void;

interface DiagnosticsClock {
  warnings: Set<string>;
  restore(): void;
}

function installDiagnosticsClock(): DiagnosticsClock {
  const warnings = new Set<string>();
  const originalRandom = Math.random;
  const originalDateNow = Date.now;
  const originalSetTimeout = window.setTimeout;
  const originalSetInterval = window.setInterval;
  const originalRaf = window.requestAnimationFrame;
  const perf = performance as unknown as { now: () => number };
  const originalPerfNow = perf.now;
  let perfPatched = false;

  Math.random = () => {
    warnings.add("Math.random()");
    return originalRandom();
  };
  Date.now = () => {
    warnings.add("Date.now()");
    return originalDateNow();
  };
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    warnings.add("setTimeout()");
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    warnings.add("setInterval()");
    return originalSetInterval(handler, timeout, ...args);
  }) as typeof window.setInterval;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    warnings.add("requestAnimationFrame()");
    return originalRaf(callback);
  }) as typeof window.requestAnimationFrame;
  try {
    perf.now = () => {
      warnings.add("performance.now()");
      return originalPerfNow();
    };
    perfPatched = true;
  } catch {
    // Some engines make performance.now non-writable; skip that signal.
  }

  return {
    warnings,
    restore() {
      Math.random = originalRandom;
      Date.now = originalDateNow;
      window.setTimeout = originalSetTimeout;
      window.setInterval = originalSetInterval;
      window.requestAnimationFrame = originalRaf;
      if (perfPatched) {
        perf.now = originalPerfNow;
      }
    },
  };
}

function diagnosticsMessage(scope: string, frame: number | null, warning: string): string {
  const location = frame === null ? "" : ` at frame ${frame}`;
  switch (warning) {
    case "Math.random()":
      return `${scope}${location} used Math.random(); use random("stable:key") for deterministic values.`;
    case "Date.now()":
    case "performance.now()":
      return `${scope}${location} read ${warning}; derive time from the frame and frame rate.`;
    default:
      return `${scope}${location} used ${warning}; drive animation from update({ frame }).`;
  }
}

export function withDiagnosticsSync<T>(
  scope: string,
  frame: number | null,
  diagnostics: DiagnosticSink | undefined,
  callback: () => T,
): T {
  if (!diagnostics) {
    return callback();
  }
  const clock = installDiagnosticsClock();
  try {
    return callback();
  } finally {
    clock.restore();
    for (const warning of clock.warnings) {
      try {
        diagnostics(diagnosticsMessage(scope, frame, warning));
      } catch {
        // Diagnostics must never affect composition execution.
      }
    }
  }
}

export async function withDiagnosticsAsync<T>(
  scope: string,
  diagnostics: DiagnosticSink | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (!diagnostics) {
    return callback();
  }
  const clock = installDiagnosticsClock();
  try {
    return await callback();
  } finally {
    clock.restore();
    for (const warning of clock.warnings) {
      try {
        diagnostics(diagnosticsMessage(scope, null, warning));
      } catch {
        // Diagnostics must never affect composition execution.
      }
    }
  }
}
