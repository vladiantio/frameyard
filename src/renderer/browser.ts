import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type {
  CompositionDiagnostic,
  CompositionMetadata,
  CompositionSourceInfo,
  Props,
  ResolvedAudioClip,
  ResolvedTranscriptClip,
} from "../contracts.js";
import { FrameyardError, isFrameyardError, type FrameyardDiagnostic, type FrameyardErrorCode } from "../errors.js";

export interface CompositionSession {
  readonly entry: string;
  readonly controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  readonly metadata: CompositionMetadata;
  readonly props: Props;
  readonly audioClips: ResolvedAudioClip[];
  readonly embeddedAudioClips: ResolvedAudioClip[];
  readonly transcriptClips: ResolvedTranscriptClip[];
  seek(frame: number): Promise<void>;
  capture(): Promise<Buffer>;
  readDiagnostics(): Promise<CompositionDiagnostic[]>;
  assertHealthy(): void;
  close(): Promise<void>;
}

interface HostSessionApi {
  readonly ready: Promise<void>;
  readonly metadata: CompositionMetadata;
  readonly props: Props;
  readonly controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  readonly audioClips: ResolvedAudioClip[];
  readonly embeddedAudioClips: ResolvedAudioClip[];
  readonly transcriptClips: ResolvedTranscriptClip[];
  readonly diagnostics: CompositionDiagnostic[];
  load(options?: { props?: unknown }): Promise<void>;
  seek(frame: number): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

interface CaptureScreenshotResult {
  data: string;
}

export const BROWSER_ARGS: string[] = [
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  // WebGL frames must not vary with the host GPU. SwiftShader is the pinned
  // software rasterizer shipped with the Playwright Chromium build.
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

type BrowserContextOptions = Parameters<Browser["newContext"]>[0];

export const BROWSER_CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "no-preference",
  locale: "en-US",
  timezoneId: "UTC",
};

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

function diagnosticKey(diagnostic: CompositionDiagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
}

function mergeDiagnostics(...groups: readonly CompositionDiagnostic[][]): CompositionDiagnostic[] {
  const seen = new Set<string>();
  const result: CompositionDiagnostic[] = [];
  for (const group of groups) {
    for (const diagnostic of group) {
      const key = diagnosticKey(diagnostic);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(diagnostic);
      }
    }
  }
  return result;
}

export async function openCompositionSession(options: {
  serverUrl: string;
  entry: string;
  props?: unknown;
  info: CompositionSourceInfo;
  staticDiagnostics: readonly CompositionDiagnostic[];
}): Promise<CompositionSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
    });
  } catch (error) {
    throw new FrameyardError(
      "BROWSER_FAILED",
      `Chromium could not start. Install the pinned browser with "npx playwright install chromium".\n${browserError(error)}`,
      { cause: error },
    );
  }

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;

  try {
    context = await browser.newContext({
      ...BROWSER_CONTEXT_OPTIONS,
      viewport: { width: options.info.metadata.width, height: options.info.metadata.height },
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

    const compositionUrl = new URL(options.entry, options.serverUrl);
    compositionUrl.searchParams.set("__fy-manual", "1");
    await page.goto(compositionUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        Boolean((window as unknown as Record<string, unknown>).__fy) ||
        Boolean((window as unknown as Record<string, unknown>).__fyError),
      undefined,
      { timeout: 30_000 },
    );

    const initError = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__fyError as
          | { code: string; message: string; diagnostics?: FrameyardDiagnostic[] }
          | undefined,
    );
    if (initError) {
      throw new FrameyardError(initError.code as FrameyardErrorCode, initError.message, {
        diagnostics: initError.diagnostics,
      });
    }

    let loaded: {
      metadata: CompositionMetadata;
      props: Props;
      controller: { kind: "inline" } | { kind: "external"; src: string } | null;
      audioClips: ResolvedAudioClip[];
      embeddedAudioClips: ResolvedAudioClip[];
      transcriptClips: ResolvedTranscriptClip[];
      diagnostics: CompositionDiagnostic[];
    };
    try {
      loaded = await page.evaluate(
        async ({ props }) => {
          const api = (window as unknown as Record<string, unknown>).__fy as HostSessionApi;
          await api.ready;
          await api.load({ props });
          return {
            metadata: api.metadata,
            props: api.props,
            controller: api.controller,
            audioClips: api.audioClips,
            embeddedAudioClips: api.embeddedAudioClips,
            transcriptClips: api.transcriptClips,
            diagnostics: api.diagnostics,
          };
        },
        { props: options.props },
      );
    } catch (error) {
      throw browserCommandError(error);
    }

    if (
      loaded.metadata.width !== options.info.metadata.width ||
      loaded.metadata.height !== options.info.metadata.height ||
      loaded.metadata.fps !== options.info.metadata.fps ||
      loaded.metadata.durationInFrames !== options.info.metadata.durationInFrames
    ) {
      throw new FrameyardError(
        "COMPOSITION_INVALID",
        `Composition "${options.entry}" metadata changed between static validation and browser load.`,
        { diagnostics: [...options.staticDiagnostics] },
      );
    }

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
      entry: options.entry,
      controller: options.info.controller
        ? options.info.controller.kind === "inline"
          ? { kind: "inline" }
          : { kind: "external", src: options.info.controller.src ?? "" }
        : null,
      metadata: loaded.metadata,
      props: loaded.props,
      audioClips: loaded.audioClips,
      embeddedAudioClips: loaded.embeddedAudioClips,
      transcriptClips: loaded.transcriptClips,

      async seek(frame: number): Promise<void> {
        assertHealthy();
        try {
          await activePage.evaluate(async (targetFrame) => {
            const api = (window as unknown as Record<string, unknown>).__fy as HostSessionApi;
            api.seek(targetFrame);
            await api.settle();
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
            // Lossless PNG with fast compression. The default zlib level is the
            // dominant cost of a 1080p frame; decoded pixels are identical.
            optimizeForSpeed: true,
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

      async readDiagnostics(): Promise<CompositionDiagnostic[]> {
        const runtime = await activePage.evaluate(
          () => ((window as unknown as Record<string, unknown>).__fy as HostSessionApi).diagnostics,
        );
        return mergeDiagnostics([...options.staticDiagnostics], runtime);
      },

      assertHealthy,

      async close(): Promise<void> {
        await closeQuietly(async () => {
          await activePage.evaluate(async () => {
            const api = (window as unknown as Record<string, unknown>).__fy as HostSessionApi | undefined;
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
