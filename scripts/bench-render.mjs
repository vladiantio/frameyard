#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { loadProject } from "../dist/project.js";
import { startPreviewServer } from "../dist/server/server.js";
import { BROWSER_ARGS, BROWSER_CONTEXT_OPTIONS } from "../dist/renderer/browser.js";
import { startVideoEncoder } from "../dist/renderer/ffmpeg.js";
import { validateHtmlComposition } from "../dist/html/validate.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distCli = path.join(repoRoot, "dist", "cli.js");

const CAPTURE_MODES = {
  png: { format: "png", fromSurface: true, captureBeyondViewport: false },
  "png-fast": {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  },
  "jpeg-100": { format: "jpeg", quality: 100, fromSurface: true, captureBeyondViewport: false },
  "jpeg-95": { format: "jpeg", quality: 95, fromSurface: true, captureBeyondViewport: false },
  webp: { format: "webp", fromSurface: true, captureBeyondViewport: false },
};

const HELP = `Usage: pnpm bench [options]

Measure seek, capture, and encode cost on a real Chromium session, then
optionally run the production render end to end.

Options:
  --project <dir>       Project root (default: examples/demo)
  --composition <id>    Composition id (default: the project's first one)
  --fixtures            Benchmark every composition in bench/fixtures
  --props <file>        Props JSON (default: <project>/props/<id>.json when present)
  --frames <n>          Sample frames per composition (default: 24)
  --warmup <n>          Warmup captures per mode (default: 4)
  --capture <list>      Capture modes: ${Object.keys(CAPTURE_MODES).join(", ")}
  --concurrency <n>     Production render concurrency (1-16, default 1)
  --browser-arg <flag>  Add a Chromium flag for this run (repeatable; bench-only)
  --no-browser-arg <flag>
                        Remove a production Chromium flag for an A/B run
                        (repeatable; bench-only)
  --no-full             Skip the end-to-end render
  --no-encode           Skip the encode-only measurement
  --quick               Shorthand for --frames 12 --no-full
  --json                Print a JSON result to stdout
  -h, --help            Show this help
`;

function parseArgs(argv) {
  const options = {
    project: null,
    composition: null,
    props: null,
    fixtures: false,
    frames: 24,
    warmup: 4,
    capture: ["png", "png-fast"],
    concurrency: 1,
    browserArgs: [],
    removeBrowserArgs: [],
    full: true,
    encode: true,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--browser-arg=")) {
      options.browserArgs.push(arg.slice("--browser-arg=".length));
      continue;
    }
    if (arg.startsWith("--no-browser-arg=")) {
      options.removeBrowserArgs.push(arg.slice("--no-browser-arg=".length));
      continue;
    }
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value.`);
      }
      return argv[index];
    };

    switch (arg) {
      case "--project":
        options.project = value();
        break;
      case "--composition":
        options.composition = value();
        break;
      case "--props":
        options.props = value();
        break;
      case "--fixtures":
        options.fixtures = true;
        break;
      case "--frames":
        options.frames = Number(value());
        break;
      case "--warmup":
        options.warmup = Number(value());
        break;
      case "--capture":
        options.capture = value()
          .split(",")
          .map((mode) => mode.trim())
          .filter(Boolean);
        break;
      case "--concurrency":
        options.concurrency = Number(value());
        break;
      case "--browser-arg":
        options.browserArgs.push(value());
        break;
      case "--no-browser-arg":
        options.removeBrowserArgs.push(value());
        break;
      case "--no-full":
        options.full = false;
        break;
      case "--no-encode":
        options.encode = false;
        break;
      case "--quick":
        options.frames = 12;
        options.full = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.frames) || options.frames < 1) {
    throw new Error("--frames must be a positive integer.");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 to 16.");
  }
  if (options.browserArgs.some((arg) => arg.trim() === "")) {
    throw new Error("--browser-arg requires a non-empty Chromium flag.");
  }
  if (options.removeBrowserArgs.some((arg) => arg.trim() === "")) {
    throw new Error("--no-browser-arg requires a non-empty Chromium flag.");
  }
  if (options.capture.length === 0) {
    throw new Error("--capture must name at least one mode.");
  }
  for (const mode of options.capture) {
    if (!(mode in CAPTURE_MODES)) {
      throw new Error(`Unknown capture mode "${mode}". Available: ${Object.keys(CAPTURE_MODES).join(", ")}.`);
    }
  }

  return options;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  return {
    mean,
    p50: percentile(0.5),
    p90: percentile(0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples: values.length,
  };
}

function sampleFrames(total, count) {
  const frames = [];
  const samples = Math.min(count, total);
  for (let index = 0; index < samples; index += 1) {
    frames.push(samples === 1 ? 0 : Math.round((index * (total - 1)) / (samples - 1)));
  }
  return [...new Set(frames)];
}

function decodePngMd5(buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "md5", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`Could not run FFmpeg to decode a PNG: ${error.message}`));
    });
    child.on("close", (code) => {
      const match = /MD5=([0-9a-f]+)/i.exec(stdout);
      if (code !== 0 || !match) {
        reject(new Error(`FFmpeg could not decode a PNG (exit ${code}).${stderr ? ` ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(match[1]);
    });
    child.stdin.end(buffer);
  });
}

function formatMilliseconds(value) {
  return value.toFixed(1);
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveBrowserArgs(options) {
  const removed = new Set(options.removeBrowserArgs);
  return [...BROWSER_ARGS.filter((arg) => !removed.has(arg)), ...options.browserArgs];
}

function pageErrors(session) {
  if (session.errors.length > 0) {
    throw new Error(`Unhandled browser error: ${session.errors.join("\n")}`);
  }
}

async function openSession(serverUrl, projectRoot, entry, props, browserArgs = BROWSER_ARGS) {
  // Mirrors the production HTML session so capture numbers match production;
  // the production session does not expose CDP for capture-mode comparisons.
  const validation = await validateHtmlComposition({ projectRoot, entry, props });
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!validation.info || errors.length > 0) {
    throw new Error(`Composition "${entry}" is invalid: ${errors[0]?.message ?? "unknown error"}`);
  }
  const info = validation.info;

  let browser;
  let context;
  let page;
  let cdp;
  const pageErrorsList = [];

  try {
    browser = await chromium.launch({ headless: true, args: browserArgs });
    context = await browser.newContext({
      ...BROWSER_CONTEXT_OPTIONS,
      viewport: { width: info.metadata.width, height: info.metadata.height },
    });
    page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on("pageerror", (error) => pageErrorsList.push(error.message));
    page.on("crash", () => pageErrorsList.push("The browser page crashed."));

    const url = new URL(entry, serverUrl);
    url.searchParams.set("__fy-manual", "1");
    url.searchParams.set("__fy-load", "bench");
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(() => Boolean(window.__fy) || Boolean(window.__fyError), undefined, { timeout: 30_000 });
    const initError = await page.evaluate(() => window.__fyError);
    if (initError) {
      throw new Error(`[${initError.code}] ${initError.message}`);
    }

    await page.evaluate(
      async ({ props: targetProps }) => {
        await window.__fy.ready;
        await window.__fy.load({ props: targetProps });
      },
      { props },
    );

    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await page.route("**/*", (route) => route.abort("blockedbyclient"));

    cdp = await context.newCDPSession(page);
    const session = { browser, context, page, cdp, metadata: info.metadata, errors: pageErrorsList };
    pageErrors(session);
    return session;
  } catch (error) {
    await closeSession({ browser, context, page, cdp });
    throw error;
  }
}

async function closeSession(session) {
  if (!session) {
    return;
  }
  if (session.page) {
    try {
      await session.page.evaluate(async () => {
        await window.__fy?.dispose?.();
      });
    } catch {
      // Cleanup must not hide the benchmark result.
    }
  }
  if (session.cdp) {
    try {
      await session.cdp.detach();
    } catch {
      // Already detached.
    }
  }
  if (session.context) {
    try {
      await session.context.close();
    } catch {
      // Already closed.
    }
  }
  if (session.browser) {
    try {
      await session.browser.close();
    } catch {
      // Already closed.
    }
  }
}

async function seek(session, frame) {
  pageErrors(session);
  const startedAt = performance.now();
  await session.page.evaluate(async (targetFrame) => {
    window.__fy.seek(targetFrame);
    await window.__fy.settle();
  }, frame);
  pageErrors(session);
  return performance.now() - startedAt;
}

async function capture(session, mode) {
  pageErrors(session);
  const startedAt = performance.now();
  const result = await session.cdp.send("Page.captureScreenshot", CAPTURE_MODES[mode]);
  const buffer = Buffer.from(result.data, "base64");
  pageErrors(session);
  return { ms: performance.now() - startedAt, bytes: buffer.length, buffer };
}

async function resolveProps(project, compositionId, explicitPath) {
  const candidate = explicitPath
    ? path.resolve(explicitPath)
    : path.join(project.root, "props", `${compositionId}.json`);

  if (!existsSync(candidate)) {
    if (explicitPath) {
      throw new Error(`Props file not found: ${candidate}`);
    }
    return { props: undefined, path: null };
  }

  return { props: JSON.parse(await readFile(candidate, "utf8")), path: candidate };
}

async function measureEncode(buffers, fps, outputPath) {
  if (buffers.length === 0) {
    return null;
  }

  const startedAt = performance.now();
  const encoder = await startVideoEncoder({
    outputPath,
    fps,
    frames: buffers.length,
    durationSeconds: buffers.length / fps,
  });
  const writeTimes = [];

  try {
    for (const buffer of buffers) {
      const writeStartedAt = performance.now();
      await encoder.writeFrame(buffer);
      writeTimes.push(performance.now() - writeStartedAt);
    }

    const finishStartedAt = performance.now();
    await encoder.finish();
    const finishMs = performance.now() - finishStartedAt;
    const totalMs = performance.now() - startedAt;
    const output = await stat(outputPath);

    return {
      writeFrame: summarize(writeTimes),
      finishMs,
      totalMs,
      frames: buffers.length,
      bytes: output.size,
    };
  } catch (error) {
    await encoder.abort().catch(() => undefined);
    throw error;
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distCli, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(`Production render failed (exit ${code}).${tail ? `\n${tail}` : ""}`));
    });
  });
}

async function measureFullRender(project, compositionId, propsPath, outputPath, concurrency) {
  const args = ["render", compositionId, "--project", project.root, "--out", outputPath, "--overwrite", "--json"];
  if (propsPath) {
    args.push("--props", propsPath);
  }
  if (concurrency > 1) {
    args.push("--concurrency", String(concurrency));
  }

  const startedAt = performance.now();
  const { stdout } = await runCli(args);
  const wallMs = performance.now() - startedAt;
  const result = JSON.parse(stdout);

  if (result.ok !== true) {
    throw new Error(`Production render failed: ${result.error?.message ?? "unknown error"}`);
  }

  return {
    wallMs,
    elapsedMs: result.elapsedMs,
    framesRendered: result.framesRendered,
    frames: result.durationInFrames,
    fps: (result.framesRendered / wallMs) * 1000,
    bytes: result.bytes,
    concurrency,
  };
}

async function compareDecodedPixels(left, right) {
  if (!left || !right) {
    return null;
  }

  const rightByFrame = new Map(right.map((entry) => [entry.frame, entry]));
  const shared = left.filter((entry) => rightByFrame.has(entry.frame));
  if (shared.length === 0) {
    return null;
  }

  const indexes = [...new Set([0, Math.floor((shared.length - 1) / 2), shared.length - 1])];
  const frames = [];
  for (const index of indexes) {
    const entry = shared[index];
    const other = rightByFrame.get(entry.frame);
    const [leftHash, rightHash] = await Promise.all([decodePngMd5(entry.buffer), decodePngMd5(other.buffer)]);
    frames.push({ frame: entry.frame, identical: leftHash === rightHash });
  }

  return {
    compared: frames.length,
    identical: frames.filter((frame) => frame.identical).length,
    frames,
    decodedPixels: true,
  };
}

async function benchComposition({ project, compositionId, options, tempDir }) {
  const composition = project.compositions.get(compositionId);
  if (!composition) {
    const available = [...project.compositions.keys()].join(", ") || "(none)";
    throw new Error(`Composition "${compositionId}" is not in video.config.js. Available: ${available}.`);
  }

  const resolvedProps = await resolveProps(project, compositionId, options.props);
  const server = await startPreviewServer({ projectRoot: project.root, port: 0 });
  let session;
  let result;
  let fps = 0;
  let pixelSamples = {};
  let encodeBuffers = [];

  try {
    session = await openSession(
      server.url,
      project.root,
      composition.entry,
      resolvedProps.props,
      resolveBrowserArgs(options),
    );
    const { width, height, fps: compositionFps, durationInFrames } = session.metadata;
    fps = compositionFps;
    const frames = sampleFrames(durationInFrames, options.frames);
    const seekTimes = [];
    const captures = {};
    const buffersByMode = {};

    for (const mode of options.capture) {
      // Warm the compositor on a different frame so the first recorded sample
      // is not a cached repaint of the warmup frame.
      await seek(session, frames[frames.length - 1]);
      for (let index = 0; index < options.warmup; index += 1) {
        await capture(session, mode);
      }

      const times = [];
      const bytes = [];
      pixelSamples[mode] = [];
      buffersByMode[mode] = [];

      for (const frame of frames) {
        seekTimes.push(await seek(session, frame));
        const captureResult = await capture(session, mode);
        times.push(captureResult.ms);
        bytes.push(captureResult.bytes);
        if (mode === "png" || mode === "png-fast") {
          pixelSamples[mode].push({ frame, buffer: captureResult.buffer });
          buffersByMode[mode].push(captureResult.buffer);
        }
      }

      captures[mode] = {
        ...summarize(times),
        meanBytes: bytes.reduce((total, value) => total + value, 0) / bytes.length,
      };
    }

    encodeBuffers = buffersByMode["png-fast"]?.length ? buffersByMode["png-fast"] : (buffersByMode.png ?? []);

    result = {
      project: path.relative(repoRoot, project.root) || ".",
      composition: compositionId,
      metadata: { width, height, fps: compositionFps, durationInFrames },
      samples: frames.length,
      seek: summarize(seekTimes),
      captures,
      pixelCheck: null,
      encode: null,
      fullRender: null,
    };
  } finally {
    await closeSession(session);
    await server.close();
  }

  // Run the FFmpeg-only measurements after closing the benchmark browser so
  // the production render is not competing with a second Chromium session.
  result.pixelCheck = await compareDecodedPixels(pixelSamples.png, pixelSamples["png-fast"]);

  if (options.encode && encodeBuffers.length > 0) {
    result.encode = await measureEncode(encodeBuffers, fps, path.join(tempDir, `${compositionId}-encode.mp4`));
  }

  if (options.full) {
    result.fullRender = await measureFullRender(
      project,
      compositionId,
      resolvedProps.path,
      path.join(tempDir, `${compositionId}-render.mp4`),
      options.concurrency,
    );
  }

  return result;
}

function printHuman(results, options) {
  console.log("Frameyard render benchmark");
  console.log(`capture modes: ${options.capture.join(", ")}; samples: ${options.frames}`);
  if (options.browserArgs.length > 0 || options.removeBrowserArgs.length > 0) {
    console.log(
      `browser args: +[${options.browserArgs.join(", ")}] -[${options.removeBrowserArgs.join(", ")}] (bench-only)`,
    );
  }
  console.log("Timings are machine-dependent; encoded MP4 bytes are not a reproducibility guarantee.");

  for (const result of results) {
    const { width, height, fps, durationInFrames } = result.metadata;
    console.log(`\n${result.composition}: ${width}x${height} @ ${fps} fps, ${durationInFrames} frames`);

    const seek = result.seek;
    console.log(
      `  seek            mean ${formatMilliseconds(seek.mean)} ms  p50 ${formatMilliseconds(seek.p50)}  p90 ${formatMilliseconds(seek.p90)}  (n=${seek.samples})`,
    );

    for (const [mode, capture] of Object.entries(result.captures)) {
      console.log(
        `  capture ${mode.padEnd(9)} mean ${formatMilliseconds(capture.mean)} ms  p50 ${formatMilliseconds(capture.p50)}  p90 ${formatMilliseconds(capture.p90)}  ${formatBytes(capture.meanBytes)}/frame`,
      );
    }

    if (result.captures.png && result.captures["png-fast"]) {
      const speedup = result.captures.png.mean / result.captures["png-fast"].mean;
      console.log(`  capture speedup png-fast vs png: ${speedup.toFixed(2)}x`);
    }

    if (result.pixelCheck) {
      const status = result.pixelCheck.identical === result.pixelCheck.compared ? "identical" : "DIFFERENT";
      console.log(
        `  pixel check     png vs png-fast (decoded): ${status} at ${result.pixelCheck.identical}/${result.pixelCheck.compared} frames`,
      );
    }

    if (result.encode) {
      console.log(
        `  encode          writeFrame mean ${formatMilliseconds(result.encode.writeFrame.mean)} ms  finish ${formatMilliseconds(result.encode.finishMs)} ms  total ${formatMilliseconds(result.encode.totalMs)} ms`,
      );
    }

    if (result.fullRender) {
      console.log(
        `  full render     ${(result.fullRender.wallMs / 1000).toFixed(1)} s  (${result.fullRender.fps.toFixed(1)} fps, ${formatBytes(result.fullRender.bytes)})${result.fullRender.concurrency > 1 ? `, concurrency ${result.fullRender.concurrency}` : ""}`,
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!existsSync(distCli)) {
    throw new Error("dist/cli.js is missing. Run pnpm build first (pnpm bench does this).");
  }

  const projectRoot = options.fixtures
    ? path.join(repoRoot, "bench", "fixtures")
    : path.resolve(options.project ?? path.join(repoRoot, "examples", "demo"));
  const project = await loadProject(projectRoot);
  const available = [...project.compositions.keys()];
  const compositionIds = options.fixtures
    ? options.composition
      ? [options.composition]
      : available
    : [options.composition ?? available[0]];

  for (const compositionId of compositionIds) {
    if (!project.compositions.has(compositionId)) {
      throw new Error(
        `Composition "${compositionId}" is not in video.config.js. Available: ${available.join(", ") || "(none)"}.`,
      );
    }
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "frameyard-bench-"));
  const results = [];

  try {
    for (const compositionId of compositionIds) {
      results.push(await benchComposition({ project, compositionId, options, tempDir }));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: "bench",
          settings: {
            concurrency: options.concurrency,
            browserArgs: options.browserArgs,
            removeBrowserArgs: options.removeBrowserArgs,
            effectiveBrowserArgs: resolveBrowserArgs(options),
          },
          results,
        },
        null,
        2,
      ),
    );
    return;
  }

  printHuman(results, options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: false, command: "bench", error: { code: "BENCH_FAILED", message } }));
  } else {
    console.error(`bench failed: ${message}`);
  }
  process.exitCode = 1;
});
