import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

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
    `export default { compositions: { demo: "./compositions/demo.js", diagnostics: "./compositions/diagnostics.js" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.js"), composition);
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

    const loaded = await page.evaluate(async ({ entry }) => {
      const api = (window as unknown as Record<string, unknown>).__frameyardPreview as {
        load(entry: string, props?: unknown): Promise<{
          metadata: { width: number; height: number; fps: number; durationInFrames: number };
          props: Record<string, unknown>;
          audioClips: Array<Record<string, unknown>>;
          transcriptClips: Array<Record<string, unknown>>;
        }>;
        seek(frame: number): void;
        dispose(): Promise<void>;
      };
      return api.load(entry, { label: "Custom" });
    }, { entry: "compositions/demo.js" });

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
    await expect(page.evaluate(() => (document.querySelector("#box") as HTMLElement | null)?.dataset.disposed)).resolves.toBeUndefined();

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
    expect(message.text()).toContain("use random(\"stable:key\")");
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
