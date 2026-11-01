import type { Page } from "playwright";

/** The embedded timeline host API exposed by `?__fy-embed=1`. */
export interface EmbeddedTimelineApi {
  ready: Promise<void>;
  format: { width: number; height: number; fps: number };
  durationInFrames: number;
  load(): Promise<void>;
  seek(frame: number): Promise<void>;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Opens an embedded timeline page and waits for its host API. */
export async function openEmbeddedTimeline(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as Window & { __fyTimeline?: unknown }).__fyTimeline));
}

/** Loads the timeline layers through the embedded host. */
export async function loadTimeline(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as Window & { __fyTimeline?: EmbeddedTimelineApi }).__fyTimeline;
    if (!api) {
      throw new Error("Missing embedded timeline host.");
    }
    await api.ready;
    await api.load();
  });
}

/** Seeks the embedded timeline and waits for the host to settle. */
export async function seekTimeline(page: Page, frame: number): Promise<void> {
  await page.evaluate(async (target) => {
    const api = (window as Window & { __fyTimeline?: EmbeddedTimelineApi }).__fyTimeline;
    if (!api) {
      throw new Error("Missing embedded timeline host.");
    }
    await api.seek(target);
    await api.settle();
  }, frame);
}

/**
 * Waits for a composition layer's controller to publish the requested frame.
 * Composition layers are iframes; reading their `data-frame` marker is the
 * deterministic equivalent of waiting for a paint.
 */
export async function waitForFrame(page: Page, frame: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const iframe = document.querySelector<HTMLIFrameElement>(".timeline-layer iframe");
      return iframe?.contentDocument?.querySelector<HTMLElement>("#box")?.dataset.frame === String(expected);
    },
    frame,
    { timeout: 30_000 },
  );
}
