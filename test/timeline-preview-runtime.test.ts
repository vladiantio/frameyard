import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

let root: string;
let server: PreviewServer;
let browser: Browser;

const composition = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; width: 100%; height: 100%; background: #123; }</style>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="10">
      <div id="box" data-frame="-1" style="width: 40px; height: 40px; background: #b8f36b"></div>
    </fy-composition>
    <script type="text/fy-controller">
let box;
export default {
  mount({ root }) { box = root.querySelector("#box"); },
  update({ frame }) { box.dataset.frame = String(frame); },
};
    </script>
  </body>
</html>
`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-preview-runtime-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await writeFile(path.join(root, "compositions", "intro.html"), composition);
  await writeFile(
    path.join(root, "timelines", "main.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "intro",
            track: "v1",
            source: { kind: "composition", id: "intro" },
            start: 0,
            duration: 10,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "video.config.js"),
    `export default {
      format: { width: 320, height: 180, fps: 10 },
      compositions: { intro: "./compositions/intro.html" },
      timelines: { main: "./timelines/main.json" },
    };\n`,
  );
  server = await startPreviewServer({ projectRoot: root, port: 0 });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function waitForFrame(page: Page, frame: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const iframe = document.querySelector<HTMLIFrameElement>(".timeline-layer iframe");
      return iframe?.contentDocument?.querySelector<HTMLElement>("#box")?.dataset.frame === String(expected);
    },
    frame,
    { timeout: 30_000 },
  );
}

describe("timeline preview runtime", () => {
  it("serves the embedded timeline host and seeks composition layers", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/main?__fy-embed=1", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => Boolean((window as Window & { __fyTimeline?: unknown }).__fyTimeline));
      await page.evaluate(async () => {
        const api = (
          window as Window & {
            __fyTimeline?: { ready: Promise<void>; load(): Promise<void>; seek(frame: number): Promise<void> };
          }
        ).__fyTimeline;
        if (!api) {
          throw new Error("Missing embedded timeline host.");
        }
        await api.ready;
        await api.load();
        await api.seek(5);
      });

      await waitForFrame(page, 5);
      const layers = await page.locator(".timeline-layer").count();
      expect(layers).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("renders the timeline UI and scrubs the host", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/main", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => document.querySelectorAll(".timeline-layer iframe").length === 1);
      await waitForFrame(page, 0);

      expect(await page.locator(".track").count()).toBe(1);
      expect(await page.locator(".clip").count()).toBe(1);

      await page.locator("#scrub").evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "5";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await waitForFrame(page, 5);
      expect(await page.locator("#frame").textContent()).toBe("5");
    } finally {
      await page.close();
    }
  }, 60_000);
});
