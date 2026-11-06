import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";
import { captureTimelineStills } from "../src/renderer/timeline.ts";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";
import { loadTimeline, openEmbeddedTimeline, seekTimeline, waitForFrame } from "./helpers/preview.ts";
import { mediaPixel } from "./helpers/media.ts";

const exec = promisify(execFile);

let root: string;
let server: PreviewServer;
let browser: Browser;

const composition = `<style>html, body { margin: 0; width: 100%; height: 100%; background: #123; }</style>
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
`;

const staticComposition = `<style>html, body { margin: 0; width: 100%; height: 100%; background: #123456; }</style>
    <fy-composition width="320" height="180">
      <div id="still">Still</div>
    </fy-composition>
`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-preview-runtime-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "out"), { recursive: true });
  for (const [index, color] of ["red", "lime", "blue", "#808080"].entries()) {
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
  await writeFile(path.join(root, "compositions", "still.html"), staticComposition);
  await writeFile(
    path.join(root, "timelines", "static.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "still",
            track: "v1",
            source: { kind: "composition", id: "still" },
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
    path.join(root, "timelines", "blend.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [
          { id: "v1", kind: "video" },
          { id: "v2", kind: "video" },
        ],
        clips: [
          {
            id: "top-screen",
            track: "v2",
            source: { kind: "image", src: "assets/frame-1.png" },
            start: 0,
            duration: 5,
            blend: "screen",
          },
          {
            id: "bottom-screen",
            track: "v1",
            source: { kind: "image", src: "assets/frame-3.png" },
            start: 0,
            duration: 5,
          },
          {
            id: "top-multiply",
            track: "v2",
            source: { kind: "image", src: "assets/frame-1.png" },
            start: 5,
            duration: 5,
            blend: "multiply",
          },
          {
            id: "bottom-multiply",
            track: "v1",
            source: { kind: "image", src: "assets/frame-4.png" },
            start: 5,
            duration: 5,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "timelines", "motion.json"),
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
            keyframes: {
              opacity: [
                { frame: 0, value: 0 },
                { frame: 5, value: 0.5 },
                { frame: 10, value: 1 },
              ],
              x: [
                { frame: 0, value: -30 },
                { frame: 10, value: 0 },
              ],
              y: [
                { frame: 0, value: 0 },
                { frame: 10, value: 20 },
              ],
              scale: [
                { frame: 0, value: 0.5 },
                { frame: 10, value: 1 },
              ],
              rotation: [
                { frame: 0, value: 0 },
                { frame: 10, value: 90 },
              ],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "timelines", "dissolve.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "red",
            track: "v1",
            source: { kind: "image", src: "assets/frame-1.png" },
            start: 0,
            duration: 10,
          },
          {
            id: "lime",
            track: "v1",
            source: { kind: "image", src: "assets/frame-2.png" },
            start: 6,
            duration: 10,
          },
        ],
        transitions: [{ from: "red", to: "lime", kind: "dissolve" }],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default {
      format: { width: 320, height: 180, fps: 10 },
      compositions: { intro: "./compositions/intro.html", still: "./compositions/still.html" },
      timelines: { main: "./timelines/main.json", static: "./timelines/static.json", sized: "./timelines/sized.json", video: "./timelines/video.json", blend: "./timelines/blend.json", motion: "./timelines/motion.json", dissolve: "./timelines/dissolve.json" },
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

  it("keeps a static composition layer loaded without seeking it", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/static?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 0);
      await page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('[data-clip="still"] iframe');
        return iframe?.contentDocument?.querySelector("#still")?.textContent === "Still";
      });

      const frame = page.locator('[data-clip="still"] iframe').first();
      const read = () =>
        frame.evaluate((element) => {
          const contentWindow = (element as HTMLIFrameElement).contentWindow as unknown as {
            __fy?: { metadata?: unknown; frame?: number };
            document: Document;
          };
          return {
            metadata: contentWindow.__fy?.metadata,
            frame: contentWindow.__fy?.frame,
            text: contentWindow.document.querySelector("#still")?.textContent,
          };
        });

      expect(await read()).toEqual({
        metadata: { width: 320, height: 180, static: true },
        frame: 0,
        text: "Still",
      });

      await seekTimeline(page, 7);

      expect(await read()).toEqual({
        metadata: { width: 320, height: 180, static: true },
        frame: 0,
        text: "Still",
      });
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

  it("applies keyframed presentation on every seek", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/motion?__fy-embed=1", server.url).href);
      await loadTimeline(page);

      const read = () =>
        page.locator('[data-clip="intro"]').evaluate((element) => ({
          opacity: (element as HTMLElement).style.opacity,
          transform: (element as HTMLElement).style.transform,
        }));

      await seekTimeline(page, 0);
      expect(await read()).toEqual({
        opacity: "0",
        transform: "translate(-50%, -50%) translate(-30px, 0px) rotate(0deg) scale(0.5)",
      });

      await seekTimeline(page, 5);
      await waitForFrame(page, 5);
      expect(await read()).toEqual({
        opacity: "0.5",
        transform: "translate(-50%, -50%) translate(-15px, 10px) rotate(45deg) scale(0.75)",
      });

      await seekTimeline(page, 9);
      await waitForFrame(page, 9);
      const opacity = await page
        .locator('[data-clip="intro"]')
        .evaluate((element) => Number.parseFloat((element as HTMLElement).style.opacity));
      expect(opacity).toBeCloseTo(0.9, 6);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("renders keyframe markers and seeks from a marker", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/motion", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => document.querySelectorAll(".keyframe-marker").length === 3);
      await waitForFrame(page, 0);

      const marker = page.locator('.keyframe-marker[data-frame="5"]');
      expect(await marker.getAttribute("title")).toContain("opacity 0.5");
      await marker.click();
      await waitForFrame(page, 5);
      expect(await page.locator("#frame").textContent()).toBe("5");
      expect(
        await page.locator('[data-clip="intro"]').evaluate((element) => (element as HTMLElement).style.opacity),
      ).toBe("0.5");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("stacks blended layers by track order and matches production pixels", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/blend?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 0);

      const topScreen = page.locator('[data-clip="top-screen"]');
      const bottomScreen = page.locator('[data-clip="bottom-screen"]');
      const topZ = Number(await topScreen.evaluate((element) => getComputedStyle(element).zIndex));
      const bottomZ = Number(await bottomScreen.evaluate((element) => getComputedStyle(element).zIndex));
      expect(topZ).toBeGreaterThan(bottomZ);
      expect(topZ % 2).toBe(0);
      expect(await topScreen.evaluate((element) => getComputedStyle(element).mixBlendMode)).toBe("screen");
      expect(await bottomScreen.evaluate((element) => getComputedStyle(element).mixBlendMode)).toBe("normal");
      expect(await page.locator("#stage").evaluate((element) => getComputedStyle(element).isolation)).toBe("isolate");

      const stage = page.locator("#stage");
      const box = await stage.boundingBox();
      if (box === null) {
        throw new Error("Missing timeline stage.");
      }
      const screenImage = path.join(root, "out", "blend-preview-screen.png");
      await writeFile(screenImage, await page.screenshot({ clip: box }));
      const screenPixel = await mediaPixel(screenImage, Math.floor(box.width / 2), Math.floor(box.height / 2));
      expect(screenPixel[0], "screen of red over blue must be magenta").toBeGreaterThan(200);
      expect(screenPixel[2], "screen of red over blue must be magenta").toBeGreaterThan(200);
      expect(screenPixel[1]).toBeLessThan(60);

      await seekTimeline(page, 5);
      const topMultiply = page.locator('[data-clip="top-multiply"]');
      const bottomMultiply = page.locator('[data-clip="bottom-multiply"]');
      expect(await topMultiply.evaluate((element) => getComputedStyle(element).mixBlendMode)).toBe("multiply");
      expect(await bottomMultiply.evaluate((element) => getComputedStyle(element).mixBlendMode)).toBe("normal");
      const multiplyImage = path.join(root, "out", "blend-preview-multiply.png");
      await writeFile(multiplyImage, await page.screenshot({ clip: box }));
      const multiplyPixel = await mediaPixel(multiplyImage, Math.floor(box.width / 2), Math.floor(box.height / 2));

      const stillPaths = [path.join(root, "out", "blend-still-0.png"), path.join(root, "out", "blend-still-5.png")];
      await captureTimelineStills({
        project: await loadProject(root),
        timelineId: "blend",
        frames: [0, 5],
        outPaths: stillPaths,
      });
      const screenStill = await mediaPixel(stillPaths[0] as string, 160, 90);
      const multiplyStill = await mediaPixel(stillPaths[1] as string, 160, 90);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs((screenPixel[channel] as number) - (screenStill[channel] as number))).toBeLessThanOrEqual(10);
        expect(Math.abs((multiplyPixel[channel] as number) - (multiplyStill[channel] as number))).toBeLessThanOrEqual(
          10,
        );
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it("dissolves between overlapping clips in preview and matches production pixels", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    try {
      await openEmbeddedTimeline(page, new URL("/__frameyard/timeline/dissolve?__fy-embed=1", server.url).href);
      await loadTimeline(page);
      await seekTimeline(page, 0);

      const red = page.locator('[data-clip="red"]');
      const lime = page.locator('[data-clip="lime"]');
      expect(await lime.evaluate((element) => getComputedStyle(element).display)).toBe("none");

      await seekTimeline(page, 8);
      expect(await red.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await lime.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.5");
      const redZ = Number(await red.evaluate((element) => getComputedStyle(element).zIndex));
      const limeZ = Number(await lime.evaluate((element) => getComputedStyle(element).zIndex));
      expect(limeZ).toBeGreaterThan(redZ);

      const stage = page.locator("#stage");
      const box = await stage.boundingBox();
      if (box === null) {
        throw new Error("Missing timeline stage.");
      }
      const image = path.join(root, "out", "dissolve-preview.png");
      await writeFile(image, await page.screenshot({ clip: box }));
      const pixel = await mediaPixel(image, Math.floor(box.width / 2), Math.floor(box.height / 2));
      expect(Math.abs((pixel[0] as number) - 128)).toBeLessThanOrEqual(12);
      expect(Math.abs((pixel[1] as number) - 128)).toBeLessThanOrEqual(12);
      expect(pixel[2]).toBeLessThan(30);

      const stillPath = path.join(root, "out", "dissolve-still-8.png");
      await captureTimelineStills({
        project: await loadProject(root),
        timelineId: "dissolve",
        frames: [8],
        outPaths: [stillPath],
      });
      const still = await mediaPixel(stillPath, 160, 90);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs((pixel[channel] as number) - (still[channel] as number))).toBeLessThanOrEqual(10);
      }

      await seekTimeline(page, 10);
      expect(await lime.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await red.evaluate((element) => getComputedStyle(element).display)).toBe("none");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("draws a read-only transition band on the timeline strip", async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    try {
      await page.goto(new URL("/__frameyard/timeline/dissolve", server.url).href);
      await page.waitForSelector(".transition");
      const band = page.locator(".transition");
      expect(await band.count()).toBe(1);
      expect(await band.getAttribute("title")).toContain("dissolve red → lime");
      const box = await band.boundingBox();
      if (box === null) {
        throw new Error("Missing transition band.");
      }
      expect(box.width).toBeGreaterThan(0);
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
      ).toBe("light");

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
