import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";
import { mediaPixel } from "./helpers/media.ts";

const exec = promisify(execFile);

// The host seeks 1ms past the frame time so Chromium selects the frame with a
// millisecond-rounded timestamp instead of the previous one.
const MEDIA_SEEK_BIAS_SECONDS = 0.001;

const demoHtml = String.raw`<script type="application/json" data-fy="props">{ "label": "Hello", "color": "#ff0000" }</script>
    <style>
      @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(100px); } }
      #box { width: 40px; height: 40px; background: var(--fy-prop-color); animation: slide 2s linear infinite; }
    </style>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box" data-frame="-1" data-fy-anim-start="0" data-fy-anim-duration="20"></div>
      <div id="label"></div>
      <canvas id="canvas" width="20" height="20"></canvas>
      <input id="note" aria-label="Note" />
      <audio src="assets/tone.wav" data-fy-start="2" data-fy-volume="0.5"></audio>
      <audio src="assets/tone.wav" data-fy-start="8" data-fy-trim="0.1" data-fy-duration="0.2"></audio>
      <fy-transcript src="assets/voice.json" words></fy-transcript>
    </fy-composition>
    <script type="text/fy-controller">
import { random } from "frameyard/runtime";

let box;
let label;
let context;

export default {
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  mount({ root }) {
    box = root.querySelector("#box");
    label = root.querySelector("#label");
    context = root.querySelector("#canvas").getContext("2d");
  },
  update({ frame, props }) {
    box.dataset.frame = String(frame);
    box.dataset.random = random("frame:" + frame).toFixed(12);
    label.textContent = props.label + ":" + frame;
    context.fillStyle = frame % 2 === 0 ? "#0000ff" : "#00ff00";
    context.fillRect(0, 0, 20, 20);
  },
  dispose() {
    box.dataset.disposed = "yes";
  },
};
    </script>
`;

const mediaHtml = String.raw`<style>video,canvas{position:absolute;top:0;width:80px;height:90px}video{left:0}canvas{left:80px}</style>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="12">
      <video id="clip" src="assets/clip.webm" data-fy-start="1" data-fy-trim="0.2" data-fy-duration="0.5" data-fy-volume="0.6"></video>
      <canvas id="gl" width="80" height="90"></canvas>
    </fy-composition>
    <script type="text/fy-controller">
let video;
let gl;

export default {
  mount({ root }) {
    video = root.querySelector("#clip");
    const canvas = root.querySelector("#gl");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  },
  update({ frame }) {
    const red = frame >= 6;
    gl.clearColor(red ? 1 : 0, 0, red ? 0 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.canvas.dataset.pixel = Array.from(pixel).join(",");
    video.dataset.frame = String(frame);
  },
};
    </script>
`;

const htmlComposition = `<script type="application/json" data-fy="props">{ "title": "HTML", "accent": "#b8f36b" }</script>
    <style>
      @keyframes move { from { transform: translateX(0px); } to { transform: translateX(40px); } }
      #box { width: 20px; height: 20px; background: var(--fy-prop-accent); animation: move 0.6s linear infinite; }
    </style>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box" data-fy-anim-start="0" data-fy-anim-duration="20"></div>
      <div id="title" data-fy-text="title"></div>
      <div id="missing" data-fy-text="missing" style="width: 1px; height: 1px"></div>
      <div id="warning" data-fy-anim-start="0"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update({ frame, root }) {
    root.querySelector("#box").dataset.frame = String(frame);
  },
};
    </script>
`;

const diagnosticsHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update() {
    Math.random();
  },
};
    </script>
`;

const staticHtml = `<style>
      html, body { margin: 0; width: 100%; height: 100%; background: #123456; }
      #still { color: #b8f36b; font: 16px monospace; }
    </style>
    <fy-composition width="200" height="100">
      <div id="still">Static preview</div>
    </fy-composition>
`;

let root: string;
let server: PreviewServer;
let browser: Browser;

function toneWav(seconds = 1): Buffer {
  const sampleRate = 8_000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 6_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-runtime-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { compositions: { demo: "./compositions/demo.html", diagnostics: "./compositions/diagnostics.html", media: "./compositions/media.html", html: "./compositions/html.html", static: "./compositions/static.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.html"), demoHtml);
  await writeFile(path.join(root, "compositions", "media.html"), mediaHtml);
  await writeFile(path.join(root, "compositions", "html.html"), htmlComposition);
  await writeFile(path.join(root, "compositions", "diagnostics.html"), diagnosticsHtml);
  await writeFile(path.join(root, "compositions", "static.html"), staticHtml);
  await writeFile(path.join(root, "assets", "tone.wav"), toneWav());
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:r=10:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=c=lime:s=64x64:r=10:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "200k",
    "-c:a",
    "libopus",
    "-shortest",
    path.join(root, "assets", "clip.webm"),
  ]);
  await writeFile(
    path.join(root, "assets", "voice.json"),
    JSON.stringify({
      schemaVersion: 1,
      text: "Hello",
      source: { path: "assets/tone.wav", sha256: "a".repeat(64), bytes: 1 },
      segments: [{ startMs: 0, endMs: 1000, text: "Hello" }],
      words: [{ startMs: 0, endMs: 1000, text: "Hello" }],
    }),
  );

  server = await startPreviewServer({ projectRoot: root, port: 0 });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe("browser preview runtime", () => {
  it("publishes the preview API after project config loads", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    let release!: () => void;
    const configGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/__frameyard/project.json", async (route) => {
      await configGate;
      await route.continue();
    });
    const configRequest = page.waitForRequest("**/__frameyard/project.json");
    await page.goto(new URL("/__frameyard/?render=1", server.url).href, { waitUntil: "domcontentloaded" });
    await configRequest;

    const exposedBeforeConfig = await page.evaluate(() =>
      Boolean((window as unknown as Record<string, unknown>).__frameyardPreview),
    );
    expect(exposedBeforeConfig).toBe(false);

    release();
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));
    await context.close();
  });

  it("lays out assets, the monitor, the inspector, and the hidden timeline strip", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });

    const regions = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector) as HTMLElement | null;
        const rect = element?.getBoundingClientRect();
        return rect
          ? {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              scrollWidth: element!.scrollWidth,
              clientWidth: element!.clientWidth,
              scrollHeight: element!.scrollHeight,
              clientHeight: element!.clientHeight,
            }
          : null;
      };
      return {
        assets: box(".assets-panel"),
        monitor: box(".monitor-panel"),
        inspector: box(".inspector-panel"),
        timeline: box(".timeline-panel"),
        assetsBody: box(".assets-panel .panel-body"),
      };
    });
    expect(regions.assets, "assets panel").not.toBeNull();
    expect(regions.monitor, "monitor").not.toBeNull();
    expect(regions.inspector, "inspector").not.toBeNull();
    expect(regions.assets!.left).toBeLessThan(regions.monitor!.left);
    expect(regions.monitor!.left).toBeLessThan(regions.inspector!.left);
    expect(regions.assets!.top).toBe(regions.monitor!.top);
    expect(regions.monitor!.top).toBe(regions.inspector!.top);
    expect(regions.inspector!.height).toBe(regions.assets!.height);
    expect(regions.assetsBody!.scrollWidth).toBeLessThanOrEqual(regions.assetsBody!.clientWidth);
    expect(regions.assetsBody!.scrollHeight).toBeLessThanOrEqual(regions.assetsBody!.clientHeight);
    expect(await page.locator("#timeline").isVisible()).toBe(false);
    expect(await page.locator("#tab-program").isVisible()).toBe(false);
    expect(await page.locator("#program-view").isVisible()).toBe(false);

    expect(await page.locator('.asset[data-asset-kind="composition"]').count()).toBe(5);
    expect(await page.locator('.asset[data-asset-kind="timeline"]').count()).toBe(0);
    expect(await page.locator(".asset-thumb iframe").count()).toBe(0);

    await page.locator('.asset[data-asset-kind="composition"][data-asset-id="demo"]').click();
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return (
        stage?.getAttribute("src")?.includes("demo.html") === true &&
        Boolean(stage.contentDocument?.querySelector("#label"))
      );
    });
    expect(await page.locator("#monitor-title").textContent()).toContain("demo");
    expect(new URL(page.url()).searchParams.get("composition")).toBe("demo");
    await context.close();
  });

  it("switches system, light, and dark themes and persists a manual override", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    expect(await page.locator("#theme-system").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#stage-frame").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(
      "light",
    );

    await page.locator("#theme-dark").click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("frameyard.preview.theme"))).toBe("dark");
    expect(await page.locator("#stage-frame").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(
      "light",
    );

    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    expect(await page.locator("#theme-dark").getAttribute("aria-pressed")).toBe("true");

    await page.locator("#theme-system").click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await context.close();
  });

  it("zooms, fits, pans, and fullscreens the monitor", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-wrap") as HTMLElement | null;
      return stage !== null && !stage.hidden;
    });

    expect(await page.locator("#zoom-readout").textContent()).toBe("fit");
    await page.locator("#zoom-in").click();
    expect(await page.locator("#zoom-readout").textContent()).toBe("150%");
    expect(
      await page.locator("#stage-wrap").evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    ).toBe(300);
    await page.locator("#zoom-actual").click();
    expect(await page.locator("#zoom-readout").textContent()).toBe("100%");
    await page.locator("#zoom-in").click();
    await page.locator("#zoom-in").click();
    await page.locator("#zoom-in").click();
    expect(await page.locator("#zoom-readout").textContent()).toBe("400%");

    await page.locator("#pan-toggle").click();
    expect(await page.locator("#source-pan").isVisible()).toBe(true);
    const viewport = await page.locator("#source-viewport").boundingBox();
    if (viewport === null) {
      throw new Error("Missing source viewport.");
    }
    const before = await page.locator('[data-monitor-scroll="source"]').evaluate((element) => element.scrollLeft);
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width / 2 - 120, viewport.y + viewport.height / 2);
    await page.mouse.up();
    const after = await page.locator('[data-monitor-scroll="source"]').evaluate((element) => element.scrollLeft);
    expect(after).toBeGreaterThan(before);
    await page.locator("#pan-toggle").click();

    await page.locator("#monitor-fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement?.id === "monitor-panel");
    expect(await page.locator("#monitor-fullscreen").getAttribute("aria-label")).toBe("Exit fullscreen");
    await page.evaluate(async () => {
      await document.exitFullscreen();
    });
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.waitForFunction(
      () => document.querySelector("#monitor-fullscreen")?.getAttribute("aria-label") === "Enter fullscreen",
    );
    await context.close();
  });

  it("keeps props explicit with dirty and reset state", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#title")?.textContent === "HTML";
    });
    const baseline = await page.locator("#props").inputValue();

    await page.locator("#props").evaluate(
      (element, value) => {
        const editor = element as HTMLTextAreaElement;
        editor.value = value as string;
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      },
      JSON.stringify({ title: "Dirty", accent: "#b8f36b" }),
    );
    expect(await page.locator("#props-dirty").isVisible()).toBe(true);
    expect(
      await page.locator("#stage-frame").evaluate((element) => {
        const frame = element as HTMLIFrameElement;
        return frame.contentDocument?.querySelector("#title")?.textContent;
      }),
    ).toBe("HTML");

    await page.locator("#props-reset").click();
    expect(await page.locator("#props").inputValue()).toBe(baseline);
    expect(await page.locator("#props-dirty").isVisible()).toBe(false);

    await page.locator("#props").evaluate(
      (element, value) => {
        const editor = element as HTMLTextAreaElement;
        editor.value = value as string;
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      },
      JSON.stringify({ title: "Applied", accent: "#b8f36b" }),
    );
    await page.locator("#apply").click();
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#title")?.textContent === "Applied";
    });
    expect(await page.locator("#props-dirty").isVisible()).toBe(false);
    await context.close();
  });

  it("loads, seeks, and resolves props and audio deterministically", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/?render=1", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));

    const loaded = await page.evaluate(
      async ({ entry }) => {
        const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
          load(
            entry: string,
            props?: unknown,
          ): Promise<{
            metadata: { width: number; height: number; fps: number; durationInFrames: number };
            props: Record<string, unknown>;
            audioClips: Array<Record<string, unknown>>;
            transcriptClips: Array<Record<string, unknown>>;
          }>;
        };
        return api.load(entry, { label: "Custom" });
      },
      { entry: "compositions/demo.html" },
    );

    expect(loaded.metadata).toEqual({ width: 200, height: 100, fps: 10, durationInFrames: 20 });
    expect(loaded.props).toEqual({ label: "Custom", color: "#ff0000" });
    expect(loaded.audioClips).toEqual([
      { src: "assets/tone.wav", startFrame: 2, trimStart: 0, volume: 0.5 },
      { src: "assets/tone.wav", startFrame: 8, trimStart: 0.1, trimDuration: 0.2, volume: 1 },
    ]);
    expect(loaded.transcriptClips).toEqual([{ src: "assets/voice.json", words: true }]);

    const readFrame = (frame: number) =>
      page.evaluate(async (targetFrame) => {
        const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
          seek(frame: number): void;
        };
        api.seek(targetFrame);
        const stage = document.querySelector("#stage-frame") as HTMLIFrameElement;
        const frameDocument = stage.contentDocument as Document;
        const box = frameDocument.querySelector("#box") as HTMLElement;
        const canvas = frameDocument.querySelector("#canvas") as HTMLCanvasElement;
        const pixel = Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
        return {
          frame: box.dataset.frame,
          random: box.dataset.random,
          label: frameDocument.querySelector("#label")!.textContent,
          transform: getComputedStyle(box).transform,
          pixel,
        };
      }, frame);

    const atZero = await readFrame(0);
    expect(atZero).toMatchObject({ frame: "0", label: "Custom:0", pixel: [0, 0, 255, 255] });
    expect(atZero.transform).toMatch(/matrix\(1, 0, 0, 1, 0, 0\)|none/);

    const atTen = await readFrame(10);
    expect(atTen).toMatchObject({ frame: "10", label: "Custom:10", pixel: [0, 0, 255, 255] });
    expect(atTen.transform).toMatch(/matrix\(1, 0, 0, 1, 50, 0\)/);

    const atSeven = await readFrame(7);
    await readFrame(3);
    const atSevenAgain = await readFrame(7);
    expect(atSevenAgain).toEqual(atSeven);

    await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        dispose(): Promise<void>;
      };
      await api.dispose();
    });
    expect(
      await page.evaluate(() => {
        const stage = document.querySelector("#stage-frame") as HTMLIFrameElement;
        return {
          hidden: stage.hidden,
          box: stage.contentDocument?.querySelector("#box") ?? null,
        };
      }),
    ).toEqual({ hidden: true, box: null });

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("seeks embedded video and renders WebGL deterministically", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/?render=1", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));

    const loaded = await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(
          entry: string,
          props?: unknown,
        ): Promise<{
          embeddedAudioClips: Array<Record<string, unknown>>;
        }>;
      };
      return api.load("compositions/media.html");
    });
    expect(loaded.embeddedAudioClips).toEqual([
      {
        src: "assets/clip.webm",
        startFrame: 1,
        trimStart: 0.2,
        trimDuration: 0.5,
        volume: 0.6,
      },
    ]);

    const readFrame = (frame: number) =>
      page.evaluate(async (targetFrame) => {
        const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
          seek(frame: number): void;
          settle(): Promise<void>;
        };
        api.seek(targetFrame);
        await api.settle();
        const stage = document.querySelector("#stage-frame") as HTMLIFrameElement;
        const frameDocument = stage.contentDocument as Document;
        const video = frameDocument.querySelector("#clip") as HTMLVideoElement;
        const canvas = frameDocument.querySelector("#gl") as HTMLCanvasElement;
        const sample = document.createElement("canvas");
        sample.width = video.videoWidth;
        sample.height = video.videoHeight;
        const sampleContext = sample.getContext("2d")!;
        sampleContext.drawImage(video, 0, 0);
        const pixel = Array.from(sampleContext.getImageData(10, 10, 1, 1).data);
        return {
          currentTime: video.currentTime,
          paused: video.paused,
          muted: video.muted,
          videoFrame: video.dataset.frame,
          videoPixel: pixel,
          webglPixel: canvas.dataset.pixel,
        };
      }, frame);

    const atTwo = await readFrame(2);
    expect(atTwo).toMatchObject({ paused: true, muted: true, videoFrame: "2", webglPixel: "0,0,255,255" });
    expect(atTwo.currentTime).toBeCloseTo(0.3 + MEDIA_SEEK_BIAS_SECONDS, 3);
    expect(atTwo.videoPixel.slice(0, 3)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(atTwo.videoPixel[0]).toBeGreaterThan(180);
    expect(atTwo.videoPixel[1]).toBeLessThan(60);

    const atEight = await readFrame(8);
    expect(atEight).toMatchObject({ videoFrame: "8", webglPixel: "255,0,0,255" });
    expect(atEight.currentTime).toBeCloseTo(0.7 + MEDIA_SEEK_BIAS_SECONDS, 3);
    expect(atEight.videoPixel[1]).toBeGreaterThan(180);
    expect(atEight.videoPixel[0]).toBeLessThan(60);

    const atTwoAgain = await readFrame(2);
    expect(atTwoAgain).toEqual(atTwo);

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("loads embedded media in the interactive preview", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/?composition=media", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#clip")?.getAttribute("data-frame") === "0";
    });
    await page.waitForFunction(() => !(document.querySelector("#play") as HTMLButtonElement).disabled);

    const frame = page.frameLocator("#stage-frame");
    expect(await frame.locator("#clip").evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
    expect(await page.locator("#play").isEnabled()).toBe(true);

    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrub") as HTMLInputElement;
      scrubber.value = "8";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction((expected) => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      const video = stage?.contentDocument?.querySelector("#clip") as HTMLVideoElement | null;
      return video?.dataset.frame === "8" && Math.abs(video.currentTime - expected) < 0.01;
    }, 0.7 + MEDIA_SEEK_BIAS_SECONDS);

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("loads the interactive preview, scrubs, and applies props", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });

    const frame = page.frameLocator("#stage-frame");
    expect(
      await page.locator('.asset[data-asset-kind="composition"][data-asset-id="demo"]').getAttribute("class"),
    ).toContain("selected");
    expect(await page.locator("#meta").textContent()).toContain("200×100");
    expect(await page.locator("#duration").textContent()).toBe("19");
    expect(await page.locator("#props").inputValue()).toContain('"label": "Hello"');
    expect(await page.locator("#play").isEnabled()).toBe(true);
    expect(await page.locator("#step-back").isEnabled()).toBe(true);
    expect(await page.locator("#step-forward").isEnabled()).toBe(true);
    expect(await page.locator("#jump-back").isEnabled()).toBe(true);
    expect(await page.locator("#jump-forward").isEnabled()).toBe(true);

    await page.locator("#step-forward").click();
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "1";
    });
    expect(await page.locator("#frame").textContent()).toBe("1");

    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });
    expect(await page.locator("#frame").textContent()).toBe("0");

    await page.locator("#jump-forward").click();
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "10";
    });
    expect(await page.locator("#frame").textContent()).toBe("10");
    expect(
      await page
        .locator("#scrub")
        .evaluate((element) => Number.parseFloat((element as HTMLInputElement).style.getPropertyValue("--progress"))),
    ).toBeCloseTo((10 / 19) * 100, 1);

    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });
    expect(await page.locator("#frame").textContent()).toBe("0");

    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrub") as HTMLInputElement;
      scrubber.value = "10";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "10";
    });
    expect(await page.locator("#clock").textContent()).toBe("1.00s");

    await page.evaluate(() => {
      const editor = document.querySelector("#props") as HTMLTextAreaElement;
      editor.value = JSON.stringify({ label: "Preview" });
      (document.querySelector("#apply") as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#label")?.textContent?.startsWith("Preview");
    });
    expect(await frame.locator("#label").textContent()).toBe("Preview:0");
    expect(pageErrors).toEqual([]);

    await context.close();
  });

  it("forwards transport keys from the stage iframe and ignores text entry", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/", server.url).href);
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });

    const frame = page.frameLocator("#stage-frame");
    await frame.locator("body").click({ position: { x: 180, y: 50 } });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "1";
    });
    expect(await page.locator("#frame").textContent()).toBe("1");

    await frame.locator("#note").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("#frame").textContent()).toBe("1");

    await page.locator("#step-forward").click();
    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return stage?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "2";
    });
    await page.locator("#tab-props").click();
    await page.locator("#props").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("#frame").textContent()).toBe("2");

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("loads an HTML composition in the iframe preview, scrubs, and applies props", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const element = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return element?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });
    await page.waitForFunction(() => !(document.querySelector("#play") as HTMLButtonElement).disabled);
    await page.waitForFunction(() =>
      document.querySelector("#diagnostics")?.textContent?.includes("ANIMATION_NOT_FOUND"),
    );

    const frame = page.frameLocator("#stage-frame");
    expect(
      await page.locator('.asset[data-asset-kind="composition"][data-asset-id="html"]').getAttribute("class"),
    ).toContain("selected");
    expect(
      await page.evaluate(() => {
        const element = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
        return element ? getComputedStyle(element).colorScheme : null;
      }),
    ).toBe("light");
    const stageFrame = page.locator("#stage-frame");
    const stageBox = await stageFrame.boundingBox();
    if (stageBox === null) {
      throw new Error("Missing preview stage frame.");
    }
    const stageImage = path.join(root, "preview-stage.png");
    await writeFile(stageImage, await page.screenshot({ clip: stageBox }));
    const [stageRed, stageGreen, stageBlue] = await mediaPixel(
      stageImage,
      Math.floor(stageBox.width * 0.9),
      Math.floor(stageBox.height * 0.9),
    );
    expect(
      stageRed + stageGreen + stageBlue,
      "a transparent composition must show the black stage, not a white iframe base",
    ).toBeLessThan(200);
    expect(await page.locator("#meta").textContent()).toContain("200×100");
    expect(await page.locator("#duration").textContent()).toBe("19");
    expect(await page.locator("#props").inputValue()).toContain('"title": "HTML"');
    expect(await page.locator("#play").isEnabled()).toBe(true);
    expect(await frame.locator("#title").textContent()).toBe("HTML");
    expect(await page.locator("#diagnostics").textContent()).toContain("ANIMATION_NOT_FOUND");

    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrub") as HTMLInputElement;
      scrubber.value = "10";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const element = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return element?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "10";
    });
    expect(await page.locator("#clock").textContent()).toBe("1.00s");

    await page.evaluate(() => {
      const editor = document.querySelector("#props") as HTMLTextAreaElement;
      editor.value = JSON.stringify({ title: "Preview", accent: "#ff0000" });
      (document.querySelector("#apply") as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => {
      const element = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return element?.contentDocument?.querySelector("#title")?.textContent === "Preview";
    });
    expect(await frame.locator("#title").textContent()).toBe("Preview");

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("inspects bound elements, jumps, copies a still command, and closes with Escape", async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const element = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return element?.contentDocument?.querySelector("#box")?.getAttribute("data-frame") === "0";
    });

    const frame = page.frameLocator("#stage-frame");
    await frame.locator("#title").click();
    await page.waitForFunction(() => !(document.querySelector("#inspector") as HTMLElement | null)?.hidden);
    expect(await page.locator("#inspector-title").textContent()).toBe("<div>");
    expect(await page.locator("#inspector").evaluate((element) => element.closest(".props-panel") !== null)).toBe(true);
    expect(await page.locator("#props-view").isVisible()).toBe(false);
    expect(await page.locator('#inspector-content [data-label="tag"] .inspector-value').textContent()).toBe("div");
    expect(
      await page.locator('#inspector-content [data-label="data-fy-text"] .inspector-value').textContent(),
    ).toContain('"HTML"');
    expect(await page.locator("#inspector-open").getAttribute("href")).toContain("/compositions/html.html");

    await frame.locator("#missing").click();
    await page.waitForFunction(() =>
      document.querySelector("#inspector-diagnostics")?.textContent?.includes("BINDING_PATH_MISSING"),
    );

    await page.locator("#inspector-jump-end").click();
    await page.waitForFunction(() => document.querySelector("#frame")?.textContent === "19");
    await page.locator("#inspector-copy").click();
    expect(await page.locator("#inspector-copy").getAttribute("data-copy-text")).toBe(
      "npx frameyard still html --frame 19",
    );

    await page.locator("#inspector-jump-start").click();
    await page.waitForFunction(() => document.querySelector("#frame")?.textContent === "0");
    await page.keyboard.press("Escape");
    expect(await page.locator("#inspector").getAttribute("hidden")).not.toBeNull();
    expect(await page.locator("#props-view").isVisible()).toBe(true);
    await context.close();
  });

  it("switches compositions from the assets list", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();

    await page.goto(new URL("/__frameyard/?composition=html", server.url).href);
    await page.waitForFunction(() => {
      const frame = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return (
        frame?.getAttribute("src")?.includes("html.html") === true &&
        Boolean(frame.contentDocument?.querySelector("#title"))
      );
    });

    await page.locator('.asset[data-asset-kind="composition"][data-asset-id="demo"]').click();
    await page.waitForFunction(() => {
      const frame = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return (
        frame?.getAttribute("src")?.includes("demo.html") === true &&
        Boolean(frame.contentDocument?.querySelector("#label"))
      );
    });
    expect(await page.locator("#stage-frame").getAttribute("src")).toContain("demo.html");
    expect(new URL(page.url()).searchParams.get("composition")).toBe("demo");

    await page.locator('.asset[data-asset-kind="composition"][data-asset-id="html"]').click();
    await page.waitForFunction(() => {
      const frame = document.querySelector("#stage-frame") as HTMLIFrameElement | null;
      return (
        frame?.getAttribute("src")?.includes("html.html") === true &&
        Boolean(frame.contentDocument?.querySelector("#title"))
      );
    });
    expect(await page.locator("#stage-frame").getAttribute("src")).toContain("html.html");
    expect(new URL(page.url()).searchParams.get("composition")).toBe("html");

    await context.close();
  }, 60_000);

  it("warns about forbidden clocks and randomness in preview mode", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?composition=diagnostics", server.url).href);
    await page.waitForFunction(() => document.querySelector("#diagnostics")?.textContent?.includes("Math.random()"));

    const diagnostics = await page.locator("#diagnostics").textContent();
    expect(diagnostics).toContain('use random("stable:key")');
    expect(diagnostics).toContain("DETERMINISM_WARNING");
    await context.close();
  });

  it("rejects invalid props and out-of-range frames", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?render=1", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));

    const invalidProps = page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<unknown>;
      };
      return api.load("compositions/demo.html", { label: 42 });
    });
    await expect(invalidProps).rejects.toThrow(/label must be a string/);

    await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<unknown>;
      };
      await api.load("compositions/demo.html", {});
    });

    const outOfRange = page.evaluate(() => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        seek(frame: number): void;
      };
      api.seek(20);
    });
    await expect(outOfRange).rejects.toThrow(/0.*19|range/i);

    await context.close();
  });

  it("previews a static composition without a transport", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/?render=1", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));

    const loaded = await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<{ metadata: unknown }>;
      };
      return api.load("compositions/static.html");
    });
    expect(loaded.metadata).toEqual({ width: 200, height: 100, static: true });

    const ui = await page.evaluate(() => {
      const stage = document.querySelector("#stage-frame") as HTMLIFrameElement;
      const stageWindow = stage.contentWindow as unknown as {
        __fy?: { metadata?: unknown };
      };
      return {
        meta: document.querySelector("#meta")?.textContent,
        playDisabled: (document.querySelector("#play") as HTMLButtonElement).disabled,
        scrubDisabled: (document.querySelector("#scrub") as HTMLInputElement).disabled,
        frame: document.querySelector("#frame")?.textContent,
        stageText: stage.contentDocument?.querySelector("#still")?.textContent,
        stageMetadata: stageWindow.__fy?.metadata,
      };
    });
    expect(ui.meta).toContain("static");
    expect(ui.playDisabled).toBe(true);
    expect(ui.scrubDisabled).toBe(true);
    expect(ui.frame).toBe("0");
    expect(ui.stageText).toBe("Static preview");
    expect(ui.stageMetadata).toEqual({ width: 200, height: 100, static: true });

    const seeked = await page.evaluate(() => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        seek(frame: number): void;
      };
      api.seek(10);
      return document.querySelector("#frame")?.textContent;
    });
    expect(seeked).toBe("0");
    await context.close();
  });
});
