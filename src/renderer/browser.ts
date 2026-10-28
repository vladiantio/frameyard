import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { CompositionMetadata, Props, ResolvedAudioClip } from "../contracts.js";
import { FrameyardError, isFrameyardError, type FrameyardErrorCode } from "../errors.js";

export interface CompositionSession {
  readonly metadata: CompositionMetadata;
  readonly props: Props;
  readonly audioClips: ResolvedAudioClip[];
  seek(frame: number): Promise<void>;
  capture(): Promise<Buffer>;
  assertHealthy(): void;
  close(): Promise<void>;
}

interface BrowserLoadResult {
  metadata: CompositionMetadata;
  props: Props;
  audioClips: ResolvedAudioClip[];
}

interface PreviewApi {
  load(entry: string, props?: unknown): Promise<BrowserLoadResult>;
  seek(frame: number): void;
}

interface CaptureScreenshotResult {
  data: string;
}

function browserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^page\.evaluate: /, "")
    .replace(/^Error: /, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("at "))
    .join("\n")
    .trim();
}

function browserCommandError(error: unknown): FrameyardError {
  if (isFrameyardError(error)) {
    return error;
  }
  const message = browserError(error);
  const match = /^\[([A-Z_]+)\]\s*([\s\S]*)$/.exec(message);
  if (match) {
    return new FrameyardError(match[1] as FrameyardErrorCode, (match[2] as string).trim(), { cause: error });
  }
  return new FrameyardError("COMPOSITION_ERROR", message, { cause: error });
}

async function closeQuietly(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup must not hide the original failure.
  }
}

export async function openCompositionSession(options: {
  serverUrl: string;
  entry: string;
  props?: unknown;
}): Promise<CompositionSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--force-color-profile=srgb",
        "--disable-lcd-text",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-dev-shm-usage",
      ],
    });
  } catch (error) {
    throw new FrameyardError(
      "BROWSER_FAILED",
      `Chromium could not start. Install the pinned browser with "pnpm exec playwright install chromium".\n${browserError(error)}`,
      { cause: error },
    );
  }

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;

  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "no-preference",
      locale: "en-US",
      timezoneId: "UTC",
    });
    page = await context.newPage();
    page.setDefaultTimeout(60_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("crash", () => {
      pageErrors.push("The browser page crashed.");
    });

    await page.goto(new URL("/__frameyard/?render=1", options.serverUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview),
      undefined,
      { timeout: 30_000 },
    );

    let loaded: BrowserLoadResult;
    try {
      loaded = await page.evaluate(
        async ({ entry, props }) => {
          const api = (window as unknown as Record<string, unknown>).__frameyardPreview as PreviewApi;
          return api.load(entry, props);
        },
        { entry: options.entry, props: options.props },
      );
    } catch (error) {
      throw browserCommandError(error);
    }

    await page.setViewportSize({ width: loaded.metadata.width, height: loaded.metadata.height });

    try {
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
    } catch (error) {
      throw new FrameyardError(
        "RENDER_FAILED",
        "Timed out waiting for composition assets and network requests to finish loading.",
        { cause: error },
      );
    }

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    // Loading is complete. Frame production must not depend on new network data.
    await page.route("**/*", (route) => route.abort("blockedbyclient"));

    cdp = await context.newCDPSession(page);
    const activePage = page as Page;
    const activeCdp = cdp as CDPSession;

    const assertHealthy = (): void => {
      if (pageErrors.length > 0) {
        throw new FrameyardError("COMPOSITION_ERROR", `Unhandled browser error: ${pageErrors.join("\n")}`);
      }
    };

    assertHealthy();

    const session: CompositionSession = {
      metadata: loaded.metadata,
      props: loaded.props,
      audioClips: loaded.audioClips,

      async seek(frame: number): Promise<void> {
        assertHealthy();
        try {
          await activePage.evaluate((targetFrame) => {
            const api = (window as unknown as Record<string, unknown>).__frameyardPreview as PreviewApi;
            api.seek(targetFrame);
          }, frame);
        } catch (error) {
          throw browserCommandError(error);
        }
        assertHealthy();
      },

      async capture(): Promise<Buffer> {
        assertHealthy();
        let result: CaptureScreenshotResult;
        try {
          result = (await activeCdp.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          })) as CaptureScreenshotResult;
        } catch (error) {
          if (isFrameyardError(error)) {
            throw error;
          }
          throw new FrameyardError("RENDER_FAILED", `Could not capture a browser frame: ${browserError(error)}`, {
            cause: error,
          });
        }
        assertHealthy();
        return Buffer.from(result.data, "base64");
      },

      assertHealthy,

      async close(): Promise<void> {
        await closeQuietly(async () => {
          await activePage.evaluate(async () => {
            const api = (window as unknown as Record<string, unknown>).__frameyardPreview as
              | { dispose?: () => Promise<void> }
              | undefined;
            await api?.dispose?.();
          });
        });
        await closeQuietly(async () => cdp?.detach());
        await closeQuietly(async () => context?.close());
        await closeQuietly(async () => browser.close());
      },
    };

    return session;
  } catch (error) {
    await closeQuietly(async () => cdp?.detach());
    await closeQuietly(async () => context?.close());
    await closeQuietly(async () => browser.close());
    throw error;
  }
}
