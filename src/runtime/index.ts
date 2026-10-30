import {
  normalizeComposition,
  resolveAudioClips,
  resolveProps,
  resolveTranscriptClips,
  type Composition,
  type Props,
  type ResolvedAudioClip,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { frameToMilliseconds } from "./clock.js";
import { describeMediaAudio, prepareMedia, releaseMedia, settleMedia } from "./media.js";

export { frameToMilliseconds, frameToSeconds } from "./clock.js";
export { random } from "./random.js";

export interface CreateRuntimeOptions<P extends Props = Props> {
  composition: Composition<P> | unknown;
  container: HTMLElement;
  /** JSON prop overrides merged over the composition's defaultProps. */
  props?: unknown;
  /** Development-only callback for best-effort diagnostics about forbidden clocks and randomness. */
  diagnostics?: (warning: string) => void;
}

export interface CompositionRuntime<P extends Props = Props> {
  readonly composition: Composition<P>;
  readonly props: Readonly<P>;
  readonly audioClips: readonly ResolvedAudioClip[];
  readonly embeddedAudioClips: readonly ResolvedAudioClip[];
  readonly transcriptClips: readonly ResolvedTranscriptClip[];
  readonly frame: number;
  seek(frame: number): void;
  /** Waits for embedded media decode and browser paint after a seek. */
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function wrapCompositionError(phase: string, frame: number | null, error: unknown): FrameyardError {
  if (isFrameyardError(error)) {
    return error;
  }
  const location = frame === null ? "" : ` at frame ${frame}`;
  return new FrameyardError(
    "COMPOSITION_ERROR",
    `Composition ${phase}() failed${location}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function seekAnimations(
  container: HTMLElement,
  frame: number,
  fps: number,
  onTransition: (() => void) | undefined,
): void {
  if (typeof container.getAnimations !== "function") {
    return;
  }

  const time = frameToMilliseconds(frame, fps);
  let sawTransition = false;

  for (const animation of container.getAnimations({ subtree: true })) {
    if (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition) {
      sawTransition = true;
    }
    try {
      animation.pause();
      animation.currentTime = time;
    } catch (error) {
      throw new FrameyardError(
        "COMPOSITION_ERROR",
        `A CSS or Web Animation could not be seeked to frame ${frame}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  if (sawTransition) {
    onTransition?.();
  }
}

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

function withDiagnosticsSync<T>(
  scope: string,
  frame: number | null,
  diagnostics: CreateRuntimeOptions["diagnostics"],
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

async function withDiagnosticsAsync<T>(
  scope: string,
  diagnostics: CreateRuntimeOptions["diagnostics"],
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

async function disposeAfterFailure<P extends Props>(composition: Composition<P>): Promise<void> {
  try {
    const result = composition.dispose?.();
    if (isThenable(result)) {
      await result;
    }
  } catch {
    // Cleanup after a failed mount or first update must not mask the failure.
  }
}

function clearContainer(container: HTMLElement): void {
  releaseMedia(container);
  container.replaceChildren();
}

async function discardRuntime<P extends Props>(composition: Composition<P>, container: HTMLElement): Promise<void> {
  await disposeAfterFailure(composition);
  clearContainer(container);
}

async function waitForMountedAssets(container: HTMLElement): Promise<void> {
  await document.fonts.ready;

  const images = Array.from(container.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (!image.currentSrc && !image.src) {
        return;
      }
      try {
        await image.decode();
      } catch (error) {
        throw new FrameyardError("ASSET_NOT_FOUND", `Could not load image asset "${image.currentSrc || image.src}".`, {
          cause: error,
        });
      }
    }),
  );
}

/** Imports a composition module through the preview server and normalizes its default export. */
export async function loadCompositionModule(url: string): Promise<Composition> {
  let module: { default?: unknown };
  try {
    module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } catch (error) {
    throw new FrameyardError(
      "COMPOSITION_INVALID",
      `Could not load composition module ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (module.default === undefined) {
    throw new FrameyardError("COMPOSITION_INVALID", `Composition module ${url} has no default export.`);
  }

  return normalizeComposition(module.default);
}

/**
 * Mounts a composition and returns a seekable runtime. Mounting and asset
 * loading complete before this promise resolves; every subsequent seek is
 * synchronous and independent of previously visited frames.
 */
export async function createCompositionRuntime<P extends Props = Props>(
  options: CreateRuntimeOptions<P>,
): Promise<CompositionRuntime<P>> {
  const composition = normalizeComposition(options.composition) as Composition<P>;
  const props = resolveProps(composition, options.props);
  const audioClips = resolveAudioClips(composition, props);
  const transcriptClips = resolveTranscriptClips(composition, props);
  const { container } = options;
  const diagnostics = options.diagnostics;
  let warnedTransition = false;
  let embeddedAudioClips: readonly ResolvedAudioClip[] = Object.freeze([]);

  const warnTransition = (): void => {
    if (!diagnostics || warnedTransition) {
      return;
    }
    warnedTransition = true;
    try {
      diagnostics("Composition uses CSS transitions; derive visual styles from frame and props in update() instead.");
    } catch {
      // Diagnostics must never affect composition execution.
    }
  };

  container.replaceChildren();

  try {
    await withDiagnosticsAsync("Composition mount()", diagnostics, () => composition.mount({ container, props }));
  } catch (error) {
    await discardRuntime(composition, container);
    throw wrapCompositionError("mount", null, error);
  }

  try {
    await waitForMountedAssets(container);
    await prepareMedia(container);
  } catch (error) {
    await discardRuntime(composition, container);
    throw error;
  }

  embeddedAudioClips = describeMediaAudio(container);
  let frame = 0;
  let disposed = false;
  let settleLoop: Promise<void> | null = null;
  let settleWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let settleFrame: number | null = null;

  function seek(targetFrame: number): void {
    if (disposed) {
      throw new FrameyardError("COMPOSITION_ERROR", "Cannot seek a disposed composition runtime.");
    }
    if (!Number.isInteger(targetFrame) || targetFrame < 0 || targetFrame >= composition.durationInFrames) {
      throw new FrameyardError(
        "FRAME_OUT_OF_RANGE",
        `Frame ${targetFrame} is outside the valid range 0..${composition.durationInFrames - 1}.`,
      );
    }

    try {
      const result = withDiagnosticsSync("Composition update()", targetFrame, diagnostics, () =>
        composition.update({ frame: targetFrame, props }),
      ) as unknown;
      if (isThenable(result)) {
        throw new FrameyardError(
          "COMPOSITION_UPDATE_ASYNC",
          `Composition update() must be synchronous, but it returned a promise at frame ${targetFrame}.`,
        );
      }
      seekAnimations(container, targetFrame, composition.fps, warnTransition);
    } catch (error) {
      throw wrapCompositionError("update", targetFrame, error);
    }

    frame = targetFrame;
  }

  function settle(): Promise<void> {
    if (disposed) {
      return Promise.reject(new FrameyardError("COMPOSITION_ERROR", "Cannot settle a disposed composition runtime."));
    }
    const targetFrame = frame;
    const promise = new Promise<void>((resolve, reject) => {
      settleWaiters.push({ resolve, reject });
    });
    settleFrame = targetFrame;
    settleLoop ??= runSettleLoop();
    return promise;
  }

  async function runSettleLoop(): Promise<void> {
    try {
      while (settleWaiters.length > 0) {
        const waiters = settleWaiters;
        settleWaiters = [];
        const targetFrame = settleFrame ?? frame;
        settleFrame = null;

        if (disposed) {
          const error = new FrameyardError("COMPOSITION_ERROR", "Cannot settle a disposed composition runtime.");
          for (const waiter of waiters) {
            waiter.reject(error);
          }
          continue;
        }

        try {
          await settleMedia(container, targetFrame, composition.fps);
          if (disposed) {
            const error = new FrameyardError("COMPOSITION_ERROR", "Cannot settle a disposed composition runtime.");
            for (const waiter of waiters) {
              waiter.reject(error);
            }
          } else {
            for (const waiter of waiters) {
              waiter.resolve();
            }
          }
        } catch (error) {
          for (const waiter of waiters) {
            waiter.reject(error);
          }
        }
      }
    } finally {
      settleLoop = null;
      if (settleWaiters.length > 0) {
        settleLoop = runSettleLoop();
      }
    }
  }

  try {
    seek(0);
    await settleMedia(container, 0, composition.fps);
  } catch (error) {
    await discardRuntime(composition, container);
    throw error;
  }

  return Object.freeze({
    composition,
    props,
    audioClips,
    embeddedAudioClips,
    transcriptClips,
    get frame() {
      return frame;
    },
    seek,
    settle,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const stopped = new FrameyardError("COMPOSITION_ERROR", "Cannot settle a disposed composition runtime.");
      for (const waiter of settleWaiters) {
        waiter.reject(stopped);
      }
      settleWaiters = [];
      try {
        if (composition.dispose) {
          const result = composition.dispose();
          if (isThenable(result)) {
            await result;
          }
        }
      } catch (error) {
        clearContainer(container);
        throw wrapCompositionError("dispose", null, error);
      }
      clearContainer(container);
    },
  });
}
