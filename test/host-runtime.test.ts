import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

const exec = promisify(execFile);

let root: string;
let server: PreviewServer;
let browser: Browser;

const helloHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">
    { "title": "Hello", "accent": "#b8f36b", "show": true, "items": [{ "label": "A" }, { "label": "B" }] }
    </script>
    <style>
      @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(100px); } }
      #box { width: 40px; height: 40px; background: var(--fy-prop-accent); animation: slide 2s linear infinite; }
    </style>
  </head>
  <body>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box" data-fy-anim-start="0" data-fy-anim-duration="20"></div>
      <h1 id="title" data-fy-text="title"></h1>
      <p id="conditional" data-fy-if="show" data-fy-text="title"></p>
      <ul id="items">
        <template data-fy-repeat="items">
          <li data-fy-text="item.label" data-fy-attr-data-index="index"></li>
        </template>
      </ul>
      <div id="classy" data-fy-class-active="show"></div>
      <audio src="assets/tone.wav" data-fy-start="2" data-fy-trim="0.1" data-fy-volume="0.5"></audio>
      <fy-transcript src="assets/voice.json" words></fy-transcript>
    </fy-composition>
  </body>
</html>
`;

const controllerHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller" src="./controller.js"></script>
  </body>
</html>
`;

const controllerJs = `import { random } from "frameyard/runtime";

let box;

export default {
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  mount({ root }) {
    box = root.querySelector("#box");
    box.dataset.mounted = "yes";
  },
  update({ frame, props }) {
    box.dataset.frame = String(frame);
    box.dataset.label = props.label;
    box.dataset.random = random("frame:" + frame).toFixed(12);
  },
  dispose() {
    document.body.dataset.disposed = "yes";
    box = undefined;
  },
};
`;

const inlineHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  mount({ root }) {
    root.querySelector("#box").dataset.mounted = "yes";
  },
  update({ frame, root }) {
    root.querySelector("#box").dataset.frame = String(frame);
  },
};
    </script>
  </body>
</html>
`;

const diagnosticsHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box" data-fy-anim-start="0"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update({ frame, root }) {
    Math.random();
    root.querySelector("#box").dataset.frame = String(frame);
  },
};
    </script>
  </body>
</html>
`;

const mediaHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="12">
      <video id="clip" src="assets/clip.webm" data-fy-start="1" data-fy-trim="0.2" data-fy-duration="0.5" data-fy-volume="0.6"></video>
    </fy-composition>
  </body>
</html>
`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-host-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: {
      hello: "./compositions/hello.html",
      controller: "./compositions/controller.html",
      inline: "./compositions/inline.html",
      diagnostics: "./compositions/diagnostics.html",
      media: "./compositions/media.html",
    } };\n`,
  );
  await writeFile(path.join(root, "compositions", "hello.html"), helloHtml);
  await writeFile(path.join(root, "compositions", "controller.html"), controllerHtml);
  await writeFile(path.join(root, "compositions", "controller.js"), controllerJs);
  await writeFile(path.join(root, "compositions", "inline.html"), inlineHtml);
  await writeFile(path.join(root, "compositions", "diagnostics.html"), diagnosticsHtml);
  await writeFile(path.join(root, "compositions", "media.html"), mediaHtml);
  await writeFile(path.join(root, "assets", "tone.wav"), "");
  await writeFile(
    path.join(root, "assets", "voice.json"),
    JSON.stringify({
      schemaVersion: 1,
      text: "Hello",
      source: { path: "assets/tone.wav", sha256: "a".repeat(64), bytes: 0 },
      segments: [{ startMs: 0, endMs: 1000, text: "Hello" }],
      words: [{ startMs: 0, endMs: 500, text: "Hello" }],
    }),
  );
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
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "200k",
    "-c:a",
    "libopus",
    "-shortest",
    path.join(root, "assets", "clip.webm"),
  ]);

  server = await startPreviewServer({ projectRoot: root, port: 0 });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function openHost(entry: string, manual = true): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(new URL(`/compositions/${entry}${manual ? "?__fy-manual" : ""}`, server.url).href);
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__fy));
  await page.evaluate(async () => {
    const api = (window as unknown as Record<string, unknown>).__fy as { ready: Promise<void> };
    await api.ready;
  });
  return page;
}

async function host<T>(page: Page, callback: (api: Record<string, unknown>) => T | Promise<T>): Promise<T> {
  return page.evaluate(async (source) => {
    const api = (window as unknown as Record<string, unknown>).__fy as Record<string, unknown>;
    const fn = new Function("api", `return (${source})(api);`) as (api: Record<string, unknown>) => T | Promise<T>;
    return fn(api);
  }, callback.toString()) as Promise<T>;
}

describe("browser composition host", () => {
  it("binds props, repeats, conditionals, animations, and frame state", async () => {
    const page = await openHost("hello.html");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const notReady = await page.evaluate(() => {
      try {
        ((window as unknown as Record<string, unknown>).__fy as { seek(frame: number): void }).seek(1);
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(notReady).toContain("[COMPOSITION_NOT_READY]");

    const before = await host(page, (api) => ({
      metadata: api.metadata,
      defaultProps: api.defaultProps,
      controller: api.controller,
      audioClips: api.audioClips,
      transcriptClips: api.transcriptClips,
      frame: api.frame,
    }));
    expect(before.metadata).toEqual({ width: 200, height: 100, fps: 10, durationInFrames: 20 });
    expect(before.defaultProps).toMatchObject({ title: "Hello", accent: "#b8f36b" });
    expect(before.controller).toBeNull();
    expect(before.audioClips).toEqual([]);
    expect(before.transcriptClips).toEqual([]);
    expect(before.frame).toBe(0);

    await host(page, async (api) => {
      const load = api.load as (options: { props: unknown }) => Promise<void>;
      await load({ props: { title: "Custom", show: false, items: [{ label: "X" }, { label: "Y" }] } });
    });

    const clips = await host(page, (api) => ({
      audioClips: api.audioClips,
      transcriptClips: api.transcriptClips,
    }));
    expect(clips.audioClips).toEqual([{ src: "assets/tone.wav", startFrame: 2, trimStart: 0.1, volume: 0.5 }]);
    expect(clips.transcriptClips).toEqual([{ src: "assets/voice.json", words: true }]);

    const atZero = await page.evaluate(() => {
      const root = document.querySelector("fy-composition") as HTMLElement;
      return {
        title: document.querySelector("#title")?.textContent,
        conditional: Boolean(document.querySelector("#conditional")),
        items: Array.from(document.querySelectorAll("#items li")).map((item) => ({
          text: item.textContent,
          index: (item as HTMLElement).dataset.index,
          variable: (item as HTMLElement).style.getPropertyValue("--fy-index"),
        })),
        active: document.querySelector("#classy")?.classList.contains("active"),
        accent: root.style.getPropertyValue("--fy-prop-accent"),
        frame: document.documentElement.style.getPropertyValue("--fy-frame"),
        progress: document.documentElement.style.getPropertyValue("--fy-progress"),
        pending: root.hasAttribute("data-fy-pending"),
      };
    });
    expect(atZero).toMatchObject({
      title: "Custom",
      conditional: false,
      active: false,
      accent: "#b8f36b",
      frame: "0",
      pending: false,
    });
    expect(atZero.items).toEqual([
      { text: "X", index: "0", variable: "0" },
      { text: "Y", index: "1", variable: "1" },
    ]);

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(10);
    });
    const atTen = await page.evaluate(() => ({
      transform: getComputedStyle(document.querySelector("#box") as HTMLElement).transform,
      frame: document.documentElement.style.getPropertyValue("--fy-frame"),
      time: document.documentElement.style.getPropertyValue("--fy-time"),
      progress: document.documentElement.style.getPropertyValue("--fy-progress"),
      duration: document.documentElement.style.getPropertyValue("--fy-duration"),
      durationFrames: document.documentElement.style.getPropertyValue("--fy-duration-frames"),
    }));
    expect(atTen.transform).toMatch(/matrix\(1, 0, 0, 1, 50, 0\)/);
    expect(atTen.frame).toBe("10");
    expect(atTen.time).toBe("1");
    expect(atTen.progress).toBe(String(10 / 19));
    expect(atTen.duration).toBe("2");
    expect(atTen.durationFrames).toBe("20");

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(5);
      (api.seek as (frame: number) => void)(10);
    });
    const atTenAgain = await page.evaluate(
      () => getComputedStyle(document.querySelector("#box") as HTMLElement).transform,
    );
    expect(atTenAgain).toBe(atTen.transform);

    await host(page, async (api) => {
      const load = api.load as (options: { props: unknown }) => Promise<void>;
      await load({ props: { title: "Second", show: true, items: [] } });
    });
    const reloaded = await page.evaluate(() => ({
      title: document.querySelector("#title")?.textContent,
      conditional: document.querySelector("#conditional")?.textContent,
      items: document.querySelectorAll("#items li").length,
      active: document.querySelector("#classy")?.classList.contains("active"),
    }));
    expect(reloaded).toEqual({ title: "Second", conditional: "Second", items: 0, active: true });

    await host(page, async (api) => {
      await (api.dispose as () => Promise<void>)();
    });
    const disposed = await page.evaluate(() => {
      const root = document.querySelector("fy-composition") as HTMLElement;
      return { children: root.childElementCount };
    });
    expect(disposed.children).toBe(0);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("loads an external controller, validates props, and disposes the previous mount", async () => {
    const page = await openHost("controller.html");

    await host(page, async (api) => {
      const load = api.load as (options: { props: unknown }) => Promise<void>;
      await load({ props: { label: "Custom" } });
    });

    const loaded = await page.evaluate(() => ({
      controller: ((window as unknown as Record<string, unknown>).__fy as { controller: unknown }).controller,
      mounted: (document.querySelector("#box") as HTMLElement).dataset.mounted,
      frame: (document.querySelector("#box") as HTMLElement).dataset.frame,
      label: (document.querySelector("#box") as HTMLElement).dataset.label,
    }));
    expect(loaded).toMatchObject({
      controller: { kind: "external", src: "./controller.js" },
      mounted: "yes",
      frame: "0",
      label: "Custom",
    });

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(7);
    });
    const atSeven = await page.evaluate(() => ({
      frame: (document.querySelector("#box") as HTMLElement).dataset.frame,
      random: (document.querySelector("#box") as HTMLElement).dataset.random,
    }));
    expect(atSeven.frame).toBe("7");

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(3);
    });
    await host(page, (api) => {
      (api.seek as (frame: number) => void)(7);
    });
    const atSevenAgain = await page.evaluate(() => (document.querySelector("#box") as HTMLElement).dataset.random);
    expect(atSevenAgain).toBe(atSeven.random);

    const invalid = await page.evaluate(async () => {
      try {
        await (
          (window as unknown as Record<string, unknown>).__fy as { load(options: { props: unknown }): Promise<void> }
        ).load({
          props: { label: 123 },
        });
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(invalid).toContain("[PROPS_INVALID]");
    expect(await page.evaluate(() => (document.querySelector("#box") as HTMLElement).dataset.label)).toBe("Custom");

    await host(page, async (api) => {
      const load = api.load as (options: { props: unknown }) => Promise<void>;
      await load({ props: { label: "Second" } });
    });
    const reloaded = await page.evaluate(() => ({
      disposed: document.body.dataset.disposed,
      mounted: (document.querySelector("#box") as HTMLElement).dataset.mounted,
      label: (document.querySelector("#box") as HTMLElement).dataset.label,
    }));
    expect(reloaded).toEqual({ disposed: "yes", mounted: "yes", label: "Second" });
    await page.close();
  });

  it("loads an inline controller through the virtual module URL", async () => {
    const page = await openHost("inline.html");
    await host(page, async (api) => {
      await (api.load as (options?: { props?: unknown }) => Promise<void>)();
    });

    const loaded = await page.evaluate(() => ({
      controller: ((window as unknown as Record<string, unknown>).__fy as { controller: unknown }).controller,
      mounted: (document.querySelector("#box") as HTMLElement).dataset.mounted,
    }));
    expect(loaded).toEqual({ controller: { kind: "inline" }, mounted: "yes" });

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(3);
    });
    expect(await page.evaluate(() => (document.querySelector("#box") as HTMLElement).dataset.frame)).toBe("3");
    await page.close();
  });

  it("reports runtime determinism and animation diagnostics", async () => {
    const page = await openHost("diagnostics.html");
    await host(page, async (api) => {
      await (api.load as (options?: { props?: unknown }) => Promise<void>)();
    });
    await host(page, (api) => {
      (api.seek as (frame: number) => void)(1);
    });

    const diagnostics = await page.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>).__fy as { diagnostics: Array<{ code: string }> }).diagnostics,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ANIMATION_NOT_FOUND" }),
        expect.objectContaining({ code: "DETERMINISM_WARNING" }),
      ]),
    );
    await page.close();
  });

  it("auto-loads defaults and seeks video media", async () => {
    const page = await openHost("hello.html", false);
    const auto = await page.evaluate(() => ({
      title: document.querySelector("#title")?.textContent,
      conditional: Boolean(document.querySelector("#conditional")),
      items: document.querySelectorAll("#items li").length,
      pending: (document.querySelector("fy-composition") as HTMLElement).hasAttribute("data-fy-pending"),
    }));
    expect(auto).toEqual({ title: "Hello", conditional: true, items: 2, pending: false });
    await page.close();

    const mediaPage = await openHost("media.html");
    await host(mediaPage, async (api) => {
      await (api.load as (options?: { props?: unknown }) => Promise<void>)();
    });

    const embedded = await mediaPage.evaluate(
      () => ((window as unknown as Record<string, unknown>).__fy as { embeddedAudioClips: unknown }).embeddedAudioClips,
    );
    expect(embedded).toEqual([
      {
        src: "assets/clip.webm",
        startFrame: 1,
        trimStart: 0.2,
        trimDuration: 0.5,
        volume: 0.6,
      },
    ]);

    await host(mediaPage, async (api) => {
      (api.seek as (frame: number) => void)(2);
      await (api.settle as () => Promise<void>)();
    });
    const video = await mediaPage.evaluate(() => {
      const element = document.querySelector("#clip") as HTMLVideoElement;
      return { currentTime: element.currentTime, paused: element.paused, muted: element.muted };
    });
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.currentTime).toBeCloseTo(0.3, 3);
    await mediaPage.close();
  });
});
