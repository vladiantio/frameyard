import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

const exec = promisify(execFile);

// The host seeks 1ms past the frame time so Chromium selects the frame with a
// millisecond-rounded timestamp instead of the previous one.
const MEDIA_SEEK_BIAS_SECONDS = 0.001;

let root: string;
let server: PreviewServer;
let browser: Browser;

const helloHtml = `<script type="application/json" data-fy="props">
    { "title": "Hello", "accent": "#b8f36b", "show": true, "items": [{ "label": "A" }, { "label": "B" }] }
    </script>
    <style>
      @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(100px); } }
      #box { width: 40px; height: 40px; background: var(--fy-prop-accent); animation: slide 2s linear infinite; }
    </style>
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
`;

const controllerHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller" src="./controller.js"></script>
`;

const partialHtml = `<script type="application/json" data-fy="props">{ "title": "Parent", "parentOnly": "leak" }</script>
<fy-composition width="200" height="100" fps="10" duration-in-frames="4">
  <div id="parent" data-fy-text="title"></div>
  <fy-include src="./partials/badge.html" props='{"label":"Live"}'></fy-include>
  <fy-include src="./partials/badge.html" props='{"label":"Replay"}'></fy-include>
</fy-composition>
`;

const invalidPartialPropsHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="4">
  <fy-include src="./partials/required.html"></fy-include>
</fy-composition>
`;

const requiredPartial = `<fy-partial>
  <div id="required"></div>
  <script type="text/fy-controller">
export default {
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label is required"];
  },
  mount({ root }) {
    root.dataset.mounted = "yes";
  },
};
  </script>
</fy-partial>
`;

const lifecycleHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="4">
  <fy-include src="./partials/lifecycle-badge.html" props='{"label":"Live"}'></fy-include>
  <fy-include src="./partials/lifecycle-badge.html" props='{"label":"Replay"}'></fy-include>
</fy-composition>
<script type="text/fy-controller">
export default {
  mount() {
    (window.__fyLifecycle ??= []).push("mount:root");
  },
  update({ frame }) {
    (window.__fyLifecycle ??= []).push("update:root@" + frame);
  },
  dispose() {
    (window.__fyLifecycle ??= []).push("dispose:root");
  },
};
</script>
`;

const lifecycleBadge = `<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <div data-fy-text="label"></div>
  <script type="text/fy-controller">
let label;
export default {
  mount({ props }) {
    label = props.label;
    (window.__fyLifecycle ??= []).push("mount:" + label);
  },
  update({ frame, props }) {
    (window.__fyLifecycle ??= []).push("update:" + props.label + "@" + frame);
  },
  dispose() {
    (window.__fyLifecycle ??= []).push("dispose:" + label);
  },
};
  </script>
</fy-partial>
`;

const staticPartialHtml = `<fy-composition width="200" height="100">
  <fy-include src="./partials/static-badge.html"></fy-include>
</fy-composition>
`;

const staticBadgePartial = `<fy-partial>
  <div id="static-badge"></div>
  <script type="text/fy-controller">
export default {
  mount({ root }) {
    root.dataset.mounted = "yes";
  },
  update({ root }) {
    root.dataset.updated = "yes";
  },
};
  </script>
</fy-partial>
`;

const badgePartial = `<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <style>
    .badge { color: rgb(1, 2, 3); }
    body { background: rgb(255, 0, 0); }
  </style>
  <span class="badge" data-fy-text="label" data-fy-attr-data-label="label"></span>
  <span id="missing" data-fy-text="parentOnly"></span>
  <script type="text/fy-controller">
import { normalizeLabel } from "./badge-lib.js";

let currentRoot;
let mounts = 0;
let disposals = 0;

export default {
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  mount({ root, props }) {
    currentRoot = root;
    mounts += 1;
    Math.random();
    root.dataset.mounts = String(mounts);
    root.dataset.disposals = String(disposals);
    root.dataset.mountedLabel = normalizeLabel(props.label);
  },
  update({ frame, props, root }) {
    root.dataset.frame = String(frame);
    root.dataset.updatedLabel = normalizeLabel(props.label);
  },
  dispose() {
    disposals += 1;
    (window.__fyDisposeOrder ??= []).push(currentRoot?.dataset.mountedLabel ?? "unknown");
  },
};
  </script>
</fy-partial>
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

const inlineHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="20">
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
`;

const diagnosticsHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="20">
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
`;

const mediaHtml = `<fy-composition width="160" height="90" fps="10" duration-in-frames="12">
      <video id="clip" src="assets/clip.webm" data-fy-start="1" data-fy-trim="0.2" data-fy-duration="0.5" data-fy-volume="0.6"></video>
    </fy-composition>
`;

const schemaHtml = `<script type="application/json" data-fy="props">
    { "title": "Schema default" }
    </script>
    <script type="application/json" data-fy="props-schema">
    {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "accent": { "type": "string", "default": "lime" },
        "count": { "type": "number", "default": 3 }
      },
      "required": ["title"]
    }
    </script>
    <fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <h1 id="title" data-fy-text="title"></h1>
    </fy-composition>
`;

const presetHtml = `<fy-composition width="200" height="100" fps="10" duration-in-frames="20">
      <div id="box" data-fy-anim-preset="fade-up" data-fy-anim-start="2" data-fy-anim-duration="8" data-fy-anim-easing="linear"
        style="width: 40px; height: 40px; background: #b8f36b;"></div>
    </fy-composition>
`;

const staticHtml = `<style>
      @keyframes pulse { from { opacity: 1; } to { opacity: 0.5; } }
      #box { width: 20px; height: 20px; background: #b8f36b; animation: pulse 1s linear infinite; }
    </style>
    <fy-composition width="200" height="100">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  mount({ root }) {
    root.querySelector("#box").dataset.mounted = "yes";
  },
  update({ root }) {
    root.querySelector("#box").dataset.updated = "yes";
  },
};
    </script>
`;

const staticMediaHtml = `<fy-composition width="200" height="100"></fy-composition>
    <script type="text/fy-controller">
export default {
  mount({ root }) {
    const video = document.createElement("video");
    video.src = "assets/clip.webm";
    root.append(video);
  },
};
    </script>
`;

const staticAnimationHtml = `<fy-composition width="200" height="100"></fy-composition>
    <script type="text/fy-controller">
export default {
  mount({ root }) {
    const box = document.createElement("div");
    box.setAttribute("data-fy-anim-start", "0");
    root.append(box);
  },
};
    </script>
`;

const boundHtml = `<fy-composition width="160" height="90" fps="10" duration-in-frames="12">
      <audio data-fy-attr-src="voice"></audio>
      <fy-transcript data-fy-attr-src="transcript"></fy-transcript>
    </fy-composition>
`;

const importMapHtml = `<script type="importmap">{"imports":{"demo-lib":"./demo-lib.js"}}</script>
<fy-composition width="200" height="100" fps="10" duration-in-frames="2"></fy-composition>
<script type="text/fy-controller">
import { label } from "demo-lib";
export default {
  update({ root }) {
    root.dataset.label = label;
  },
};
</script>
`;

const demoLibJs = `export const label = "mapped";\n`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-host-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { compositions: {
      hello: "./compositions/hello.html",
      controller: "./compositions/controller.html",
      inline: "./compositions/inline.html",
      diagnostics: "./compositions/diagnostics.html",
      media: "./compositions/media.html",
      bound: "./compositions/bound.html",
      "import-map": "./compositions/import-map.html",
      preset: "./compositions/preset.html",
      schema: "./compositions/schema.html",
      static: "./compositions/static.html",
      "static-media": "./compositions/static-media.html",
      "static-animation": "./compositions/static-animation.html",
      partial: "./compositions/partial.html",
      "partial-invalid-props": "./compositions/partial-invalid-props.html",
      "partial-static": "./compositions/partial-static.html",
      "partial-lifecycle": "./compositions/partial-lifecycle.html",
    } };\n`,
  );
  await writeFile(path.join(root, "compositions", "hello.html"), helloHtml);
  await writeFile(path.join(root, "compositions", "controller.html"), controllerHtml);
  await writeFile(path.join(root, "compositions", "controller.js"), controllerJs);
  await writeFile(path.join(root, "compositions", "inline.html"), inlineHtml);
  await writeFile(path.join(root, "compositions", "diagnostics.html"), diagnosticsHtml);
  await writeFile(path.join(root, "compositions", "media.html"), mediaHtml);
  await writeFile(path.join(root, "compositions", "bound.html"), boundHtml);
  await writeFile(path.join(root, "compositions", "import-map.html"), importMapHtml);
  await writeFile(path.join(root, "compositions", "preset.html"), presetHtml);
  await writeFile(path.join(root, "compositions", "schema.html"), schemaHtml);
  await writeFile(path.join(root, "compositions", "static.html"), staticHtml);
  await writeFile(path.join(root, "compositions", "static-media.html"), staticMediaHtml);
  await writeFile(path.join(root, "compositions", "static-animation.html"), staticAnimationHtml);
  await writeFile(path.join(root, "compositions", "partial.html"), partialHtml);
  await writeFile(path.join(root, "compositions", "partial-invalid-props.html"), invalidPartialPropsHtml);
  await writeFile(path.join(root, "compositions", "partial-static.html"), staticPartialHtml);
  await writeFile(path.join(root, "compositions", "partial-lifecycle.html"), lifecycleHtml);
  await mkdir(path.join(root, "compositions", "partials"), { recursive: true });
  await writeFile(path.join(root, "compositions", "partials", "badge.html"), badgePartial);
  await writeFile(
    path.join(root, "compositions", "partials", "badge-lib.js"),
    "export function normalizeLabel(value) { return String(value); }\n",
  );
  await writeFile(path.join(root, "compositions", "partials", "required.html"), requiredPartial);
  await writeFile(path.join(root, "compositions", "partials", "static-badge.html"), staticBadgePartial);
  await writeFile(path.join(root, "compositions", "partials", "lifecycle-badge.html"), lifecycleBadge);
  await writeFile(path.join(root, "compositions", "demo-lib.js"), demoLibJs);
  await writeFile(
    path.join(root, "broken.html"),
    `<script type="module" src="/__frameyard/framework/runtime/host.js"></script>
  <p>No composition root.</p>`,
  );
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

  it("expands includes with scoped props, bindings, and CSS", async () => {
    const page = await openHost("partial.html");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await host(page, async (api) => {
      await (api.load as (options: { props: unknown }) => Promise<void>)({
        props: { title: "Parent", parentOnly: "leak" },
      });
    });

    const state = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll(".badge")) as HTMLElement[];
      const partials = Array.from(document.querySelectorAll("fy-partial")) as HTMLElement[];
      return {
        badges: badges.map((badge) => ({
          text: badge.textContent,
          label: badge.dataset.label,
          color: getComputedStyle(badge).color,
          line: badge.getAttribute("data-fy-source-line"),
        })),
        partials: partials.map((partial) => ({
          src: partial.getAttribute("data-fy-include-src"),
          label: partial.style.getPropertyValue("--fy-prop-label"),
          display: getComputedStyle(partial).display,
          mounts: partial.dataset.mounts,
          disposals: partial.dataset.disposals,
          mountedLabel: partial.dataset.mountedLabel,
          frame: partial.dataset.frame,
          updatedLabel: partial.dataset.updatedLabel,
        })),
        parent: document.querySelector("#parent")?.textContent,
        missing: Array.from(document.querySelectorAll("#missing")).map((element) => element.textContent),
        body: getComputedStyle(document.body).backgroundColor,
      };
    });

    expect(state.badges).toEqual([
      { text: "Live", label: "Live", color: "rgb(1, 2, 3)", line: "7" },
      { text: "Replay", label: "Replay", color: "rgb(1, 2, 3)", line: "7" },
    ]);
    expect(state.partials).toEqual([
      {
        src: "compositions/partials/badge.html",
        label: "Live",
        display: "contents",
        mounts: "1",
        disposals: "0",
        mountedLabel: "Live",
        frame: "0",
        updatedLabel: "Live",
      },
      {
        src: "compositions/partials/badge.html",
        label: "Replay",
        display: "contents",
        mounts: "1",
        disposals: "0",
        mountedLabel: "Replay",
        frame: "0",
        updatedLabel: "Replay",
      },
    ]);
    expect(state.parent).toBe("Parent");
    expect(state.missing).toEqual(["", ""]);
    expect(state.body).not.toBe("rgb(255, 0, 0)");

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(2);
    });
    const atTwo = await page.evaluate(() =>
      Array.from(document.querySelectorAll("fy-partial")).map((partial) => ({
        frame: (partial as HTMLElement).dataset.frame,
        updatedLabel: (partial as HTMLElement).dataset.updatedLabel,
      })),
    );
    expect(atTwo).toEqual([
      { frame: "2", updatedLabel: "Live" },
      { frame: "2", updatedLabel: "Replay" },
    ]);

    const diagnostics = await host(page, (api) => api.diagnostics);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BINDING_PATH_MISSING",
        details: expect.objectContaining({
          path: "compositions/partials/badge.html",
          line: 8,
          value: "parentOnly",
        }),
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "DETERMINISM_WARNING",
        message: expect.stringContaining("Math.random()"),
        details: expect.objectContaining({
          path: "compositions/partials/badge.html",
          includeChain: ["compositions/partial.html", "compositions/partials/badge.html"],
        }),
      }),
    );

    await host(page, async (api) => {
      await (api.load as (options: { props: unknown }) => Promise<void>)({
        props: { title: "Second", parentOnly: "leak" },
      });
    });
    const afterReload = await page.evaluate(() =>
      Array.from(document.querySelectorAll("fy-partial")).map((partial) => ({
        mounts: (partial as HTMLElement).dataset.mounts,
        disposals: (partial as HTMLElement).dataset.disposals,
        mountedLabel: (partial as HTMLElement).dataset.mountedLabel,
      })),
    );
    expect(afterReload).toEqual([
      { mounts: "2", disposals: "1", mountedLabel: "Live" },
      { mounts: "2", disposals: "1", mountedLabel: "Replay" },
    ]);

    await page.evaluate(() => {
      (window as Window & { __fyDisposeOrder?: string[] }).__fyDisposeOrder = [];
    });
    await host(page, async (api) => {
      await (api.dispose as () => Promise<void>)();
    });
    const disposeOrder = await page.evaluate(
      () => (window as Window & { __fyDisposeOrder?: string[] }).__fyDisposeOrder ?? [],
    );
    expect(disposeOrder).toEqual(["Replay", "Live"]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("rejects invalid include controller props before mounting", async () => {
    const page = await openHost("partial-invalid-props.html");

    const result = await page.evaluate(async () => {
      const api = (window as unknown as Record<string, unknown>).__fy as {
        ready: Promise<void>;
        load(): Promise<void>;
        diagnostics: Array<{ code: string; details?: Record<string, unknown> }>;
      };
      await api.ready;
      let message = "";
      try {
        await api.load();
      } catch (error) {
        message = (error as Error).message;
      }
      const partial = document.querySelector("fy-partial") as HTMLElement | null;
      return {
        message,
        mounted: partial?.dataset.mounted,
        diagnostics: api.diagnostics,
      };
    });

    expect(result.message).toContain("[PROPS_INVALID]");
    expect(result.mounted).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        details: expect.objectContaining({
          path: "compositions/partials/required.html",
          includeChain: ["compositions/partial-invalid-props.html", "compositions/partials/required.html"],
        }),
      }),
    );
    await page.close();
  });

  it("mounts included controllers in a static composition without update", async () => {
    const page = await openHost("partial-static.html");
    await host(page, async (api) => {
      await (api.load as () => Promise<void>)();
    });

    const state = await page.evaluate(() => {
      const partial = document.querySelector("fy-partial") as HTMLElement | null;
      const api = (window as unknown as Record<string, unknown>).__fy as {
        diagnostics: Array<{ code: string; details?: Record<string, unknown> }>;
      };
      return {
        mounted: partial?.dataset.mounted,
        updated: partial?.dataset.updated,
        diagnostics: api.diagnostics,
      };
    });

    expect(state.mounted).toBe("yes");
    expect(state.updated).toBeUndefined();
    expect(state.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "STATIC_UPDATE_IGNORED",
        details: expect.objectContaining({
          path: "compositions/partials/static-badge.html",
          includeChain: ["compositions/partial-static.html", "compositions/partials/static-badge.html"],
        }),
      }),
    );
    await page.close();
  });

  it("runs root and include controllers in pre-order and disposes in reverse", async () => {
    const page = await openHost("partial-lifecycle.html");
    await host(page, async (api) => {
      await (api.load as () => Promise<void>)();
    });
    const afterLoad = await page.evaluate(() => (window as Window & { __fyLifecycle?: string[] }).__fyLifecycle ?? []);
    expect(afterLoad).toEqual([
      "mount:root",
      "mount:Live",
      "mount:Replay",
      "update:root@0",
      "update:Live@0",
      "update:Replay@0",
    ]);

    await page.evaluate(() => {
      (window as Window & { __fyLifecycle?: string[] }).__fyLifecycle = [];
    });
    await host(page, (api) => {
      (api.seek as (frame: number) => void)(3);
    });
    expect(await page.evaluate(() => (window as Window & { __fyLifecycle?: string[] }).__fyLifecycle ?? [])).toEqual([
      "update:root@3",
      "update:Live@3",
      "update:Replay@3",
    ]);

    await page.evaluate(() => {
      (window as Window & { __fyLifecycle?: string[] }).__fyLifecycle = [];
    });
    await host(page, async (api) => {
      await (api.dispose as () => Promise<void>)();
    });
    expect(await page.evaluate(() => (window as Window & { __fyLifecycle?: string[] }).__fyLifecycle ?? [])).toEqual([
      "dispose:Replay",
      "dispose:Live",
      "dispose:root",
    ]);
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
      controller: { kind: "external", src: "compositions/controller.js" },
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

  it("applies schema defaults and rejects invalid props before mounting", async () => {
    const page = await openHost("schema.html");

    await host(page, async (api) => {
      const load = api.load as (options: { props: unknown }) => Promise<void>;
      await load({ props: {} });
    });
    const loaded = await page.evaluate(() => ({
      props: ((window as unknown as Record<string, unknown>).__fy as { props: unknown }).props,
      title: document.querySelector("#title")?.textContent,
    }));
    expect(loaded.props).toMatchObject({ title: "Schema default", accent: "lime", count: 3 });
    expect(loaded.title).toBe("Schema default");

    const invalid = await page.evaluate(async () => {
      try {
        await (
          (window as unknown as Record<string, unknown>).__fy as { load(options: { props: unknown }): Promise<void> }
        ).load({ props: { title: 3 } });
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(invalid).toContain("[PROPS_SCHEMA_INVALID]");
    await page.close();
  });

  it("schedules animation presets with start, duration, and easing", async () => {
    const page = await openHost("preset.html");
    await host(page, async (api) => {
      const load = api.load as (options?: { props?: unknown }) => Promise<void>;
      await load();
    });

    const timing = await page.evaluate(() => {
      const box = document.querySelector("#box") as HTMLElement;
      const animation = box.getAnimations()[0];
      const effect = animation?.effect?.getTiming();
      return {
        duration: effect?.duration,
        delay: effect?.delay,
        easing: effect?.easing,
      };
    });
    expect(timing).toEqual({ duration: 800, delay: 200, easing: "linear" });

    const atZero = await page.evaluate(() => {
      const box = document.querySelector("#box") as HTMLElement;
      const style = getComputedStyle(box);
      return { opacity: style.opacity, transform: style.transform };
    });
    expect(atZero.opacity).toBe("0");
    expect(atZero.transform).not.toBe("none");

    await host(page, (api) => {
      (api.seek as (frame: number) => void)(10);
    });
    const atTen = await page.evaluate(() => {
      const box = document.querySelector("#box") as HTMLElement;
      const style = getComputedStyle(box);
      return { opacity: style.opacity, transform: style.transform };
    });
    expect(atTen.opacity).toBe("1");
    expect(atTen.transform).not.toBe(atZero.transform);
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

  it("resolves author import maps before importing the controller", async () => {
    const page = await openHost("import-map.html");
    await host(page, async (api) => {
      await (api.load as (options?: { props?: unknown }) => Promise<void>)();
    });

    const label = await page.evaluate(() => (document.querySelector("fy-composition") as HTMLElement).dataset.label);
    expect(label).toBe("mapped");
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
    expect(video.currentTime).toBeCloseTo(0.3 + MEDIA_SEEK_BIAS_SECONDS, 3);
    await mediaPage.close();
  });

  it("resolves prop-bound media and transcript sources after bindings", async () => {
    const page = await openHost("bound.html");
    await host(page, async (api) => {
      await (api.load as (options: { props: unknown }) => Promise<void>)({
        props: { voice: "assets/tone.wav", transcript: "assets/voice.json" },
      });
    });
    const loaded = await page.evaluate(() => {
      const api = (window as unknown as Record<string, unknown>).__fy as {
        audioClips: unknown;
        transcriptClips: unknown;
      };
      return { audio: api.audioClips, transcripts: api.transcriptClips };
    });

    expect(loaded.audio).toEqual([{ src: "assets/tone.wav", startFrame: 0, trimStart: 0, volume: 1 }]);
    expect(loaded.transcripts).toEqual([{ src: "assets/voice.json", words: false }]);
    await page.close();
  });

  it("publishes descriptor diagnostics through __fyError", async () => {
    const page = await browser.newPage();
    await page.goto(new URL("/broken.html", server.url).href);
    await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__fyError));
    const error = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__fyError as {
          code: string;
          message: string;
          diagnostics?: Array<{ code: string; severity: string; details?: { path?: string } }>;
        },
    );

    expect(error).toMatchObject({
      code: "COMPOSITION_INVALID",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "COMPOSITION_INVALID",
          details: expect.objectContaining({ path: "broken.html" }),
        }),
      ]),
    });
    await page.close();
  });

  it("loads a static composition without a frame clock and warns about update and CSS animation", async () => {
    const page = await openHost("static.html");
    await host(page, async (api) => {
      await (api.load as (options?: { props?: unknown }) => Promise<void>)({});
    });
    const before = await host(page, (api) => ({
      metadata: api.metadata,
      frame: api.frame,
      diagnostics: api.diagnostics,
      audioClips: api.audioClips,
      transcriptClips: api.transcriptClips,
    }));

    expect(before.metadata).toEqual({ width: 200, height: 100, static: true });
    expect(before.frame).toBe(0);
    expect(before.audioClips).toEqual([]);
    expect(before.transcriptClips).toEqual([]);
    expect(before.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "STATIC_UPDATE_IGNORED" }),
        expect.objectContaining({ code: "STATIC_ANIMATION_PAUSED" }),
      ]),
    );

    const dom = await page.evaluate(() => {
      const box = document.querySelector("#box") as HTMLElement;
      const animation = box.getAnimations()[0];
      return {
        mounted: box.dataset.mounted,
        updated: box.dataset.updated ?? null,
        frame: document.documentElement.style.getPropertyValue("--fy-frame"),
        fps: document.documentElement.style.getPropertyValue("--fy-fps"),
        playState: animation?.playState,
        currentTime: animation?.currentTime,
      };
    });
    expect(dom.mounted).toBe("yes");
    expect(dom.updated).toBeNull();
    expect(dom.frame).toBe("");
    expect(dom.fps).toBe("");
    expect(dom.playState).toBe("paused");
    expect(dom.currentTime).toBe(0);

    const afterSeek = await host(page, (api) => {
      (api.seek as (frame: number) => void)(5);
      return { frame: api.frame };
    });
    expect(afterSeek.frame).toBe(0);
    await page.close();
  });

  it("rejects media and animation drivers in a static composition", async () => {
    for (const [entry, code] of [
      ["static-media.html", "STATIC_MEDIA_UNSUPPORTED"],
      ["static-animation.html", "STATIC_ANIMATION_UNSUPPORTED"],
    ] as const) {
      const page = await openHost(entry);
      const message = await host(page, async (api) => {
        try {
          await (api.load as (options?: { props?: unknown }) => Promise<void>)({});
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      });
      expect(message).toContain(`[${code}]`);
      await page.close();
    }
  });
});
