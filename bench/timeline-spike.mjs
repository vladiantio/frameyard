#!/usr/bin/env node
/**
 * Spike for ADR 0011: measure a live timeline host.
 *
 * This is intentionally not production code. It builds a throwaway project,
 * loads two compositions, a video, an image-backed nested timeline, and
 * captures 100 timeline frames through the same Chromium/CDP path a timeline
 * renderer would use. It also compares:
 *   - frame 50 before and after seeking 100 frames (seek safety)
 *   - frame 50 from two independent browser sessions (reproducibility)
 *   - a one-clip timeline host against a direct composition capture (parity)
 *
 * Run with: node bench/timeline-spike.mjs [--work <dir>] [--output <dir>]
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { validateHtmlComposition } from "../dist/html/validate.js";
import { BROWSER_ARGS, BROWSER_CONTEXT_OPTIONS, openCompositionSession } from "../dist/renderer/browser.js";
import { startPreviewServer } from "../dist/server/server.js";
import {
  defaultTimelineBenchRoot,
  parseTimelineBenchArgs,
  printTimelineBenchOptions,
  repoRoot,
} from "./timeline-bench-config.mjs";

const exec = promisify(execFile);
const options = parseTimelineBenchArgs(process.argv.slice(2));
if (options.help) {
  printTimelineBenchOptions(
    "timeline-spike.mjs",
    "\nWrites a generated project and frame comparisons under --work/--output.\n",
  );
  process.exit(0);
}
const outputRoot = options.output
  ? path.resolve(options.output)
  : options.work
    ? path.resolve(options.work)
    : path.join(defaultTimelineBenchRoot, "spike");
const projectRoot = options.project ? path.resolve(options.project) : path.join(outputRoot, "project");
const FORMAT = { width: 1920, height: 1080, fps: 30 };
const FRAMES = 100;
const SAMPLE_FRAME = 50;

const BASE_COMPOSITION = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #0b1016; overflow: hidden; }
      .stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .grid {
        position: absolute; inset: 0; opacity: 0.22;
        background-image:
          linear-gradient(to right, #ffffff22 1px, transparent 1px),
          linear-gradient(to bottom, #ffffff22 1px, transparent 1px);
        background-size: 120px 120px;
      }
      h1 { position: absolute; left: 96px; top: 84px; margin: 0; color: #f4f7fb; font: 800 96px/1 system-ui, sans-serif; letter-spacing: -0.04em; }
      .sub { position: absolute; left: 100px; top: 196px; color: #8fa3b8; font: 500 30px/1.2 system-ui, sans-serif; }
      .bar {
        position: absolute; top: 54%; left: calc(var(--fy-progress) * 100%);
        width: 260px; height: 160px; border-radius: 32px;
        background: linear-gradient(135deg, #5fd6ff, #b8f36b);
        transform: translate(-50%, -50%);
        box-shadow: 0 40px 120px #5fd6ff55;
      }
      .rail { position: absolute; left: 90px; right: 90px; top: 54%; height: 1px; background: #ffffff22; }
    </style>
  </head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="300">
      <div class="stage">
        <div class="grid"></div>
        <h1>BASE</h1>
        <div class="sub">live timeline host spike</div>
        <div class="rail"></div>
        <div class="bar"></div>
      </div>
    </fy-composition>
  </body>
</html>
`;

const OVERLAY_COMPOSITION = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
      .badge {
        position: absolute; left: 50%; top: 50%;
        width: 210px; height: 210px; border-radius: 50%;
        background: radial-gradient(circle at 32% 28%, #ffffff, #5fd6ff 55%, #1a6dff);
        transform: translate(-50%, -50%) rotate(calc(var(--fy-progress) * 360deg));
        box-shadow: 0 20px 60px #00000066;
      }
      .label {
        position: absolute; right: 18px; bottom: 18px;
        color: #08111a; background: #b8f36b; border-radius: 999px;
        padding: 8px 16px; font: 800 22px/1 system-ui, sans-serif;
      }
    </style>
  </head>
  <body>
    <fy-composition width="640" height="360" fps="30" duration-in-frames="300">
      <div class="badge"></div>
      <div class="label">OVERLAY</div>
    </fy-composition>
  </body>
</html>
`;

const TOP_HOST = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
      #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      iframe, video { position: absolute; border: 0; display: block; }
      #base { left: 0; top: 0; width: 1920px; height: 1080px; }
      #video { left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; opacity: 0.28; }
      #overlay { right: 56px; top: 56px; width: 640px; height: 360px; transform: scale(1.25); transform-origin: top right; opacity: 0.95; }
      #nested { left: 0; top: 0; width: 1920px; height: 1080px; opacity: 0.92; }
    </style>
  </head>
  <body>
    <div id="stage">
      <iframe id="base" src="/compositions/base.html?__fy-manual=1"></iframe>
      <video id="video" src="/assets/clip.mp4" muted playsinline preload="auto"></video>
      <iframe id="overlay" src="/compositions/overlay.html?__fy-manual=1"></iframe>
      <iframe id="nested" src="/nested-host.html"></iframe>
    </div>
    <script>
      const base = document.getElementById("base");
      const overlay = document.getElementById("overlay");
      const nested = document.getElementById("nested");
      const video = document.getElementById("video");

      function waitFor(predicate, timeout = 30000) {
        return new Promise((resolve, reject) => {
          const started = performance.now();
          const tick = () => {
            let value;
            try { value = predicate(); } catch (error) { reject(error); return; }
            if (value) { resolve(value); return; }
            if (performance.now() - started > timeout) {
              reject(new Error("Timed out waiting for a timeline clip source."));
              return;
            }
            setTimeout(tick, 16);
          };
          tick();
        });
      }

      async function loadComposition(frame) {
        const win = frame.contentWindow;
        await waitFor(() => win.__fy || win.__fyError);
        if (win.__fyError) {
          throw new Error(win.__fyError.message || "Composition failed to initialize.");
        }
        await win.__fy.ready;
        const props = win.JSON.parse(JSON.stringify({}));
        await win.__fy.load({ props });
        return win.__fy;
      }

      async function loadNested(frame) {
        const win = frame.contentWindow;
        await waitFor(() => win.__fyTimeline);
        await win.__fyTimeline.ready;
        if (win.__fyTimeline.load) {
          await win.__fyTimeline.load();
        }
        return win.__fyTimeline;
      }

      async function loadVideo() {
        if (video.readyState < 2) {
          await new Promise((resolve, reject) => {
            video.addEventListener("loadeddata", resolve, { once: true });
            video.addEventListener("error", () => reject(new Error("Video failed to load.")), { once: true });
          });
        }
        video.pause();
      }

      const ready = Promise.all([
        loadComposition(base),
        loadComposition(overlay),
        loadNested(nested),
        loadVideo(),
      ]).then(([baseApi, overlayApi, nestedApi]) => ({ baseApi, overlayApi, nestedApi }));

      async function seekVideo(frame) {
        // Match the composition media rule: seek just past the frame boundary so
        // millisecond-rounded video timestamps select the intended source frame.
        const time = frame / 30 + 0.001;
        if (Math.abs(video.currentTime - time) > 0.000001) {
          await new Promise((resolve, reject) => {
            const onSeeked = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error("Video seek failed.")); };
            const cleanup = () => {
              video.removeEventListener("seeked", onSeeked);
              video.removeEventListener("error", onError);
            };
            video.addEventListener("seeked", onSeeked);
            video.addEventListener("error", onError);
            video.currentTime = time;
          });
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      async function seek(frame) {
        const apis = await ready;
        apis.baseApi.seek(frame);
        apis.overlayApi.seek(frame);
        apis.nestedApi.seek(frame);
        await Promise.all([
          apis.baseApi.settle(),
          apis.overlayApi.settle(),
          apis.nestedApi.settle(),
          seekVideo(frame),
        ]);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      window.__spike = {
        ready,
        seek,
        async dispose() {
          const apis = await ready;
          await apis.baseApi.dispose();
          await apis.overlayApi.dispose();
          await apis.nestedApi.dispose();
        },
      };
    </script>
  </body>
</html>
`;

const SINGLE_HOST = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
      #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      iframe { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; border: 0; display: block; }
    </style>
  </head>
  <body>
    <div id="stage"><iframe id="base" src="/compositions/base.html?__fy-manual=1"></iframe></div>
    <script>
      const base = document.getElementById("base");
      function waitFor(predicate, timeout = 30000) {
        return new Promise((resolve, reject) => {
          const started = performance.now();
          const tick = () => {
            let value;
            try { value = predicate(); } catch (error) { reject(error); return; }
            if (value) { resolve(value); return; }
            if (performance.now() - started > timeout) {
              reject(new Error("Timed out waiting for the single clip source."));
              return;
            }
            setTimeout(tick, 16);
          };
          tick();
        });
      }
      const ready = (async () => {
        const win = base.contentWindow;
        await waitFor(() => win.__fy || win.__fyError);
        if (win.__fyError) {
          throw new Error(win.__fyError.message || "Composition failed to initialize.");
        }
        await win.__fy.ready;
        const props = win.JSON.parse(JSON.stringify({}));
        await win.__fy.load({ props });
        return win.__fy;
      })();
      window.__spikeSingle = {
        ready,
        async seek(frame) {
          const api = await ready;
          api.seek(frame);
          await api.settle();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        },
      };
    </script>
  </body>
</html>
`;

const NESTED_HOST = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
      .stage { position: relative; width: 100%; height: 100%; }
      img { position: absolute; left: 72px; bottom: 72px; width: 400px; height: 400px; opacity: 0.9; }
    </style>
  </head>
  <body>
    <div class="stage"><img id="badge" src="/assets/badge.png" alt=""></div>
    <script>
      const image = document.getElementById("badge");
      window.__fyTimeline = {
        ready: image.decode().catch(() => {}),
        seek() {},
        settle() { return Promise.resolve(); },
        dispose() {},
        audioClips: [],
      };
    </script>
  </body>
</html>
`;

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeProject() {
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await mkdir(path.join(projectRoot, "assets"), { recursive: true });

  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2));
  await writeFile(
    path.join(projectRoot, "video.config.js"),
    `export default {\n  format: { width: 1920, height: 1080, fps: 30 },\n  compositions: {\n    base: "./compositions/base.html",\n    overlay: "./compositions/overlay.html",\n  },\n};\n`,
  );
  await writeFile(path.join(projectRoot, "compositions", "base.html"), BASE_COMPOSITION);
  await writeFile(path.join(projectRoot, "compositions", "overlay.html"), OVERLAY_COMPOSITION);
  await writeFile(path.join(projectRoot, "timeline-host.html"), TOP_HOST);
  await writeFile(path.join(projectRoot, "timeline-single.html"), SINGLE_HOST);
  await writeFile(path.join(projectRoot, "nested-host.html"), NESTED_HOST);

  const videoSource = path.join(repoRoot, "examples", "video", "assets", "clip.mp4");
  if (!(await fileExists(videoSource))) {
    throw new Error(`Missing spike video source: ${videoSource}`);
  }
  await copyFile(videoSource, path.join(projectRoot, "assets", "clip.mp4"));

  try {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#ffcc00@0.85:s=400x400:d=1",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      path.join(projectRoot, "assets", "badge.png"),
    ]);
  } catch (error) {
    throw new Error(`Could not generate the spike PNG: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function newSession(browser, url) {
  const context = await browser.newContext({
    ...BROWSER_CONTEXT_OPTIONS,
    viewport: { width: FORMAT.width, height: FORMAT.height },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const pageErrors = [];
  const consoleMessages = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleMessages.push(message.text());
    }
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__spike || window.__spikeSingle), undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window.__spike ?? window.__spikeSingle).ready);
  try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
  } catch {
    // The ready promise is the real load boundary; networkidle is best effort.
  }
  await page.route("**/*", (route) => route.abort("blockedbyclient"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  return { context, page, cdp, pageErrors, consoleMessages };
}

async function capture(cdp) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  return Buffer.from(result.data, "base64");
}

async function seek(page, frame, single = false) {
  await page.evaluate(
    ({ targetFrame, isSingle }) => {
      const api = isSingle ? window.__spikeSingle : window.__spike;
      return api.seek(targetFrame);
    },
    { targetFrame: frame, isSingle: single },
  );
}

function summarize(times, elapsedMs) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    elapsedMs: Math.round(elapsedMs),
    averageFrameMs: Number((elapsedMs / times.length).toFixed(2)),
    medianFrameMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    p95FrameMs: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
    minFrameMs: Number(sorted[0].toFixed(2)),
    maxFrameMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function measurePage(page, cdp, single) {
  const times = [];
  const started = performance.now();
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const frameStarted = performance.now();
    await seek(page, frame, single);
    await capture(cdp);
    times.push(performance.now() - frameStarted);
  }
  return summarize(times, performance.now() - started);
}

async function compareStills(first, second) {
  try {
    const { stdout } = await exec("node", [path.join(repoRoot, "scripts", "compare-stills.mjs"), first, second]);
    return { identical: true, output: stdout.trim() };
  } catch (error) {
    return {
      identical: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(error),
    };
  }
}

async function metrics(cdp) {
  const { metrics: values } = await cdp.send("Performance.getMetrics");
  const map = Object.fromEntries(values.map((entry) => [entry.name, entry.value]));
  return {
    jsHeapUsedSize: map.JSHeapUsedSize ?? null,
    jsHeapTotalSize: map.JSHeapTotalSize ?? null,
    documents: map.Documents ?? null,
    frames: map.Frames ?? null,
    nodes: map.Nodes ?? null,
  };
}

async function main() {
  await writeProject();

  const baseValidation = await validateHtmlComposition({
    projectRoot,
    entry: "compositions/base.html",
    props: {},
  });
  const overlayValidation = await validateHtmlComposition({
    projectRoot,
    entry: "compositions/overlay.html",
    props: {},
  });
  for (const [name, validation] of [
    ["base", baseValidation],
    ["overlay", overlayValidation],
  ]) {
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!validation.info || errors.length > 0) {
      throw new Error(
        `Spike composition ${name} is invalid: ${errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
      );
    }
  }

  await mkdir(outputRoot, { recursive: true });
  const server = await startPreviewServer({ projectRoot, port: 0, host: "127.0.0.1" });
  const rssBefore = process.memoryUsage().rss;
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });

  try {
    const hostUrl = new URL("timeline-host.html", server.url).href;
    const first = await newSession(browser, hostUrl);
    await seek(first.page, SAMPLE_FRAME);
    const before = await capture(first.cdp);
    await writeFile(path.join(outputRoot, "frame50-before.png"), before);

    const fullHostTiming = await measurePage(first.page, first.cdp, false);

    await seek(first.page, SAMPLE_FRAME);
    const after = await capture(first.cdp);
    await writeFile(path.join(outputRoot, "frame50-after.png"), after);

    const hostMetrics = await metrics(first.cdp);
    const pageErrors = [...first.pageErrors];
    const consoleMessages = [...first.consoleMessages];
    await first.context.close();

    const second = await newSession(browser, hostUrl);
    await seek(second.page, SAMPLE_FRAME);
    const secondPng = await capture(second.cdp);
    await writeFile(path.join(outputRoot, "frame50-session2.png"), secondPng);
    pageErrors.push(...second.pageErrors);
    consoleMessages.push(...second.consoleMessages);
    await second.context.close();

    const single = await newSession(browser, new URL("timeline-single.html", server.url).href);
    await seek(single.page, SAMPLE_FRAME, true);
    const singlePng = await capture(single.cdp);
    await writeFile(path.join(outputRoot, "frame50-single-host.png"), singlePng);
    const singleHostTiming = await measurePage(single.page, single.cdp, true);
    pageErrors.push(...single.pageErrors);
    consoleMessages.push(...single.consoleMessages);
    await single.context.close();

    const direct = await openCompositionSession({
      serverUrl: server.url,
      entry: "compositions/base.html",
      props: {},
      info: baseValidation.info,
      staticDiagnostics: baseValidation.diagnostics,
    });
    await direct.seek(SAMPLE_FRAME);
    const directPng = await direct.capture();
    await writeFile(path.join(outputRoot, "frame50-direct-composition.png"), directPng);
    const directTimes = [];
    const directStarted = performance.now();
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const frameStarted = performance.now();
      await direct.seek(frame);
      await direct.capture();
      directTimes.push(performance.now() - frameStarted);
    }
    const directCompositionTiming = summarize(directTimes, performance.now() - directStarted);
    await direct.close();

    const comparisons = {
      seekSafety: await compareStills(
        path.join(outputRoot, "frame50-before.png"),
        path.join(outputRoot, "frame50-after.png"),
      ),
      crossSession: await compareStills(
        path.join(outputRoot, "frame50-before.png"),
        path.join(outputRoot, "frame50-session2.png"),
      ),
      singleClipParity: await compareStills(
        path.join(outputRoot, "frame50-single-host.png"),
        path.join(outputRoot, "frame50-direct-composition.png"),
      ),
    };

    const result = {
      spike: "timeline-live-host",
      format: FORMAT,
      layers: 4,
      sources: {
        compositions: 2,
        videos: 1,
        images: 1,
        nestedTimelines: 1,
      },
      framesMeasured: FRAMES,
      timings: {
        fullHost: fullHostTiming,
        singleHost: singleHostTiming,
        directComposition: directCompositionTiming,
      },
      fullHostCostVsDirect: Number((fullHostTiming.averageFrameMs / directCompositionTiming.averageFrameMs).toFixed(2)),
      nodeRssBeforeBytes: rssBefore,
      nodeRssAfterBytes: process.memoryUsage().rss,
      hostMetrics,
      comparisons,
      pageErrors,
      consoleMessages,
      outputs: {
        root: outputRoot,
        before: path.join(outputRoot, "frame50-before.png"),
        after: path.join(outputRoot, "frame50-after.png"),
        session2: path.join(outputRoot, "frame50-session2.png"),
        singleHost: path.join(outputRoot, "frame50-single-host.png"),
        directComposition: path.join(outputRoot, "frame50-direct-composition.png"),
      },
    };

    await writeFile(path.join(outputRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
