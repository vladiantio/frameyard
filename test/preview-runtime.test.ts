import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

const exec = promisify(execFile);

const composition = String.raw`
import { defineComposition } from "frameyard";
import { random } from "frameyard/runtime";

let box;
let label;
let canvas;
let context;

export default defineComposition({
  width: 200,
  height: 100,
  fps: 10,
  durationInFrames: 20,
  defaultProps: { label: "Hello", color: "#ff0000" },
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  audio: ({ props }) => [
    { src: "assets/tone.wav", startFrame: 2, volume: 0.5 },
    { src: "assets/tone.wav", startFrame: 8, trimStart: 0.1, trimDuration: 0.2 },
  ],
  transcripts: [{ src: "assets/voice.json", words: true }],
  mount({ container, props }) {
    container.innerHTML =
      '<style>' +
      '@keyframes slide { from { transform: translateX(0px); } to { transform: translateX(100px); } }' +
      '#box { width: 40px; height: 40px; background: ' + props.color + '; animation: slide 2s linear infinite; }' +
      '</style>' +
      '<div id="box" data-frame="-1"></div>' +
      '<div id="label"></div>' +
      '<canvas id="canvas" width="20" height="20"></canvas>';
    box = container.querySelector("#box");
    label = container.querySelector("#label");
    canvas = container.querySelector("#canvas");
    context = canvas.getContext("2d");
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
});
`;

const mediaComposition = String.raw`
import { defineComposition } from "frameyard";

let video;
let gl;

export default defineComposition({
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 12,
  mount({ container }) {
    container.innerHTML =
      '<style>video,canvas{position:absolute;top:0;width:80px;height:90px}video{left:0}canvas{left:80px}</style>' +
      '<video id="clip" src="assets/clip.webm" data-frameyard-start="1" data-frameyard-trim="0.2" data-frameyard-duration="0.5" data-frameyard-volume="0.6"></video>' +
      '<canvas id="gl" width="80" height="90"></canvas>';
    video = container.querySelector("#clip");
    gl = container.querySelector("#gl").getContext("webgl2") ?? container.querySelector("#gl").getContext("webgl");
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
});
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
    path.join(root, "video.config.js"),
    `export default { compositions: { demo: "./compositions/demo.js", diagnostics: "./compositions/diagnostics.js", media: "./compositions/media.js" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.js"), composition);
  await writeFile(path.join(root, "compositions", "media.js"), mediaComposition);
  await writeFile(
    path.join(root, "compositions", "diagnostics.js"),
    `export default {
  width: 200,
  height: 100,
  fps: 10,
  durationInFrames: 20,
  mount() {},
  update() {
    Math.random();
  },
};
`,
  );
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
          seek(frame: number): void;
          dispose(): Promise<void>;
        };
        return api.load(entry, { label: "Custom" });
      },
      { entry: "compositions/demo.js" },
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
        const box = document.querySelector("#box") as HTMLElement;
        const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
        const pixel = Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
        return {
          frame: box.dataset.frame,
          random: box.dataset.random,
          label: document.querySelector("#label")!.textContent,
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
    await expect(
      page.evaluate(() => (document.querySelector("#box") as HTMLElement | null)?.dataset.disposed),
    ).resolves.toBeUndefined();

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
      return api.load("compositions/media.js");
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
        const video = document.querySelector("#clip") as HTMLVideoElement;
        const canvas = document.querySelector("#gl") as HTMLCanvasElement;
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
    expect(atTwo.currentTime).toBeCloseTo(0.3, 3);
    expect(atTwo.videoPixel.slice(0, 3)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(atTwo.videoPixel[0]).toBeGreaterThan(180);
    expect(atTwo.videoPixel[1]).toBeLessThan(60);

    const atEight = await readFrame(8);
    expect(atEight).toMatchObject({ videoFrame: "8", webglPixel: "255,0,0,255" });
    expect(atEight.currentTime).toBeCloseTo(0.7, 3);
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
    await page.waitForFunction(() => document.querySelector("#clip")?.getAttribute("data-frame") === "0");
    await page.waitForFunction(() => !(document.querySelector("#play") as HTMLButtonElement).disabled);

    expect(await page.locator("#clip").evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
    expect(await page.locator("#play").isEnabled()).toBe(true);

    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrub") as HTMLInputElement;
      scrubber.value = "8";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const video = document.querySelector("#clip") as HTMLVideoElement | null;
      return video?.dataset.frame === "8" && Math.abs(video.currentTime - 0.7) < 0.01;
    });

    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("loads the interactive preview, scrubs, and applies props", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(new URL("/__frameyard/", server.url).href);
    await page.waitForFunction(() => document.querySelector("#box")?.getAttribute("data-frame") === "0");

    expect(await page.locator("#composition").inputValue()).toBe("demo");
    expect(await page.locator("#meta").textContent()).toContain("200×100");
    expect(await page.locator("#duration").textContent()).toBe("19");
    expect(await page.locator("#props").inputValue()).toContain('"label": "Hello"');
    expect(await page.locator("#play").isEnabled()).toBe(true);

    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrub") as HTMLInputElement;
      scrubber.value = "10";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await page.locator("#box").getAttribute("data-frame")).toBe("10");
    expect(await page.locator("#clock").textContent()).toBe("1.00s");

    await page.evaluate(() => {
      const editor = document.querySelector("#props") as HTMLTextAreaElement;
      editor.value = JSON.stringify({ label: "Preview" });
      (document.querySelector("#apply") as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => document.querySelector("#label")?.textContent?.startsWith("Preview"));
    expect(await page.locator("#label").textContent()).toBe("Preview:0");
    expect(pageErrors).toEqual([]);

    await context.close();
  });

  it("warns about forbidden clocks and randomness in preview mode", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    await page.goto(new URL("/__frameyard/", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__frameyardPreview));

    const warning = page.waitForEvent("console", {
      predicate: (message) => message.text().includes("Math.random()"),
    });
    await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<unknown>;
      };
      await api.load("compositions/diagnostics.js");
    });

    const message = await warning;
    expect(message.type()).toBe("warning");
    expect(message.text()).toContain('use random("stable:key")');
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
      return api.load("compositions/demo.js", { label: 42 });
    });
    await expect(invalidProps).rejects.toThrow(/label must be a string/);

    await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<unknown>;
      };
      await api.load("compositions/demo.js", {});
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
});
