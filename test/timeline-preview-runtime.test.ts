import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";
import { loadTimeline, openEmbeddedTimeline, seekTimeline, waitForFrame } from "./helpers/preview.ts";

const exec = promisify(execFile);

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
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "out"), { recursive: true });
  for (const [index, color] of ["red", "lime", "blue"].entries()) {
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:d=1`,
      "-frames:v",
      "1",
      path.join(root, "assets", `frame-${index + 1}.png`),
    ]);
  }
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    "10",
    "-i",
    path.join(root, "assets", "frame-%d.png"),
    "-c:v",
    "libvpx-vp9",
    "-lossless",
    "1",
    "-g",
    "1",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "assets", "flash.webm"),
  ]);
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
    path.join(root, "timelines", "sized.json"),
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
            transform: { fit: "cover", width: 160, height: 60, x: 0, y: 0 },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "timelines", "video.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "flash",
            track: "v1",
            source: { kind: "video", src: "assets/flash.webm" },
            start: 0,
            duration: 3,
            audio: { muted: true },
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
      timelines: { main: "./timelines/main.json", sized: "./timelines/sized.json", video: "./timelines/video.json" },
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

async function mediaPixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  return [buffer[0] ?? 0, buffer[1] ?? 0, buffer[2] ?? 0];
}

describe("timeline preview runtime", () => {
  it("serves the embedded timeline host and seeks composition layers", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/main?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 5);

      await waitForFrame(page, 5);
      const layers = await page.locator(".timeline-layer").count();
      expect(layers).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("sizes and clips a layer into an explicit transform box", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/sized?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 0);

      await waitForFrame(page, 0);
      const wrapper = page.locator(".timeline-layer").first();
      const frame = page.locator(".timeline-layer iframe").first();
      const wrapperBox = await wrapper.boundingBox();
      const frameBox = await frame.boundingBox();
      expect(wrapperBox?.width).toBeCloseTo(160, 5);
      expect(wrapperBox?.height).toBeCloseTo(60, 5);
      expect(frameBox?.width).toBeCloseTo(160, 5);
      expect(frameBox?.height).toBeCloseTo(90, 5);
      expect(await wrapper.evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("presents the seeked video frame before settling", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await page.addInitScript(() => {
        const state = window as Window & { __videoFramePaints?: number };
        state.__videoFramePaints = 0;
        const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
        if (typeof original !== "function") {
          return;
        }
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (
          this: HTMLVideoElement,
          callback: VideoFrameRequestCallback,
        ): number {
          return original.call(this, (now, metadata) => {
            setTimeout(() => {
              state.__videoFramePaints = (state.__videoFramePaints ?? 0) + 1;
              callback.call(this, now, metadata);
            }, 100);
          });
        };
      });
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/video?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 1);

      const paints = await page.evaluate(
        () => (window as Window & { __videoFramePaints?: number }).__videoFramePaints ?? 0,
      );
      expect(paints, "settle must await a presented video frame").toBeGreaterThan(0);

      const stage = page.locator("#stage");
      const box = await stage.boundingBox();
      if (box === null) {
        throw new Error("Missing timeline stage.");
      }
      const image = path.join(root, "out", "video-preview-frame.png");
      await writeFile(image, await page.screenshot({ clip: box }));

      const [red, green, blue] = await mediaPixel(image, Math.floor(box.width / 2), Math.floor(box.height / 2));
      expect(green).toBeGreaterThan(red + 40);
      expect(green).toBeGreaterThan(blue + 40);
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
      expect(
        await page.evaluate(() => {
          const frame = document.querySelector(".timeline-layer iframe") as HTMLIFrameElement | null;
          return frame ? getComputedStyle(frame).colorScheme : null;
        }),
      ).toBe("normal");

      await page.locator("#step-forward").click();
      await waitForFrame(page, 1);
      expect(await page.locator("#frame").textContent()).toBe("1");

      await page.keyboard.press("ArrowRight");
      await waitForFrame(page, 2);

      await page.locator("#step-back").click();
      await waitForFrame(page, 1);

      await page.keyboard.press("ArrowLeft");
      await waitForFrame(page, 0);

      await page.locator("#jump-forward").click();
      await waitForFrame(page, 9);
      expect(await page.locator("#frame").textContent()).toBe("9");

      await page.keyboard.press("Shift+ArrowLeft");
      await waitForFrame(page, 0);
      expect(await page.locator("#frame").textContent()).toBe("0");

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

  it("coalesces rapid timeline steps onto the latest frame", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/main", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => document.querySelectorAll(".timeline-layer iframe").length === 1);
      await waitForFrame(page, 0);

      await page.evaluate(() => {
        const step = document.querySelector("#step-forward") as HTMLButtonElement;
        step.click();
        step.click();
      });
      await waitForFrame(page, 2);
      expect(await page.locator("#frame").textContent()).toBe("2");

      await page.evaluate(() => {
        const step = document.querySelector("#step-back") as HTMLButtonElement;
        step.click();
        step.click();
      });
      await waitForFrame(page, 0);
      expect(await page.locator("#frame").textContent()).toBe("0");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("forwards transport keys from a focused timeline layer", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/main", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => document.querySelectorAll(".timeline-layer iframe").length === 1);
      await waitForFrame(page, 0);

      await page
        .frameLocator(".timeline-layer iframe")
        .locator("body")
        .click({ position: { x: 300, y: 160 } });
      await page.keyboard.press("ArrowRight");
      await waitForFrame(page, 1);
      expect(await page.locator("#frame").textContent()).toBe("1");
    } finally {
      await page.close();
    }
  }, 60_000);
});
