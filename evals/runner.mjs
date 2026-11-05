#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findTask, TASKS } from "./tasks.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "dist", "cli.js");
const QUICK_REFERENCE = path.join(ROOT, "skills", "frameyard", "references", "quick-reference.md");
const DEFAULT_MODELS = ["LFM3-1.7B-Q8_0", "Qwen3.5-4B-UD-Q4_K_XL", "Qwen3.6-35B-A3B-MTP-UD-IQ2_XXS"];

const SYSTEM_PROMPT = `You are authoring a Frameyard project.
Return only one JSON object with this shape:
{"files":[{"path":"relative/path","content":"full file content"}],"notes":"optional"}
Do not use Markdown fences. Do not write prose outside the JSON.
Write complete file contents, not patches. Paths are relative to the project root.
Do not run shell commands. The harness will run lint, check, and a still.
Frameyard rules:
- A composition is a partial HTML fragment with one top-level <fy-composition>, not a full document.
- Register every new composition or timeline explicitly in video.config.js.
- Animated compositions declare duration-in-frames; static compositions declare neither duration-in-frames nor fps.
- Use data-fy-text for text bindings, CSS @keyframes for animation, and frame-based timing.
- Never use Math.random, Date.now, performance.now, timers, or CSS transitions as animation inputs.
- Timelines use version 1, tracks, and clips; start, sourceIn, and duration are integer frames.
- Image and static-composition clips require an explicit duration; static composition clips use sourceIn: 0.`;

function usage() {
  console.log(`Usage: node evals/runner.mjs [options]

Runs local-model Frameyard authoring tasks against a llama.cpp router.
It never renders; lint, check, one still, and inspect are the gates.

Options:
  --base-url <url>        OpenAI-compatible server (default: http://127.0.0.1:9931)
  --model <id>            Model id; repeatable (default: LFM3, Qwen3.5-4B, Qwen3.6-35B)
  --models <a,b>          Comma-separated model ids
  --only <a,b>            Only these task names
  --repairs <n>           Repair turns after the first answer (default: 2)
  --timeout-ms <n>        Per-model-call timeout (default: 180000)
  --max-tokens <n>        Completion token limit (default: 4096)
  --temperature <n>       Sampling temperature (default: 0)
  --server-pid <pid>      llama-server pid for CPU/RSS sampling
  --api-key <key>         Bearer token for the server
  --lint-only             Stop after lint; skip check, still, and inspect
  --max-rss-mb <n>        Budget for the sampled server RSS (0 disables; default: 0)
  --max-cpu-ms <n>        Budget for sampled server CPU during a task (0 disables; default: 0)
  --max-gpu-percent <n>   Budget for sampled GPU utilization (default: 100)
  --keep                  Keep each temporary project and print its path
  --out <file>            Write the JSON report to a file
  --json                  Print only the JSON report to stdout
  --fail-on-task          Exit 1 when any task fails (errors always exit 1)
  --self-check            Validate task definitions and exit
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:9931",
    models: [],
    only: [],
    repairs: 2,
    timeoutMs: 180_000,
    maxTokens: 4096,
    temperature: 0,
    serverPid: undefined,
    apiKey: undefined,
    lintOnly: false,
    maxRssMb: 0,
    maxCpuMs: 0,
    maxGpuPercent: 100,
    keep: false,
    out: undefined,
    json: false,
    failOnTask: false,
    selfCheck: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${argument}.`);
      }
      return argv[index];
    };
    switch (argument) {
      case "--base-url":
        options.baseUrl = value();
        break;
      case "--model":
        options.models.push(value());
        break;
      case "--models":
        options.models.push(
          ...value()
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "--only":
        options.only.push(
          ...value()
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "--repairs":
        options.repairs = Number(value());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value());
        break;
      case "--max-tokens":
        options.maxTokens = Number(value());
        break;
      case "--temperature":
        options.temperature = Number(value());
        break;
      case "--server-pid":
        options.serverPid = Number(value());
        break;
      case "--api-key":
        options.apiKey = value();
        break;
      case "--lint-only":
        options.lintOnly = true;
        break;
      case "--max-rss-mb":
        options.maxRssMb = Number(value());
        break;
      case "--max-cpu-ms":
        options.maxCpuMs = Number(value());
        break;
      case "--max-gpu-percent":
        options.maxGpuPercent = Number(value());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--out":
        options.out = value();
        break;
      case "--json":
        options.json = true;
        break;
      case "--fail-on-task":
        options.failOnTask = true;
        break;
      case "--self-check":
        options.selfCheck = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.models.length === 0) {
    options.models = [...DEFAULT_MODELS];
  }
  for (const [name, value] of [
    ["--repairs", options.repairs],
    ["--timeout-ms", options.timeoutMs],
    ["--max-tokens", options.maxTokens],
    ["--max-rss-mb", options.maxRssMb],
    ["--max-cpu-ms", options.maxCpuMs],
    ["--max-gpu-percent", options.maxGpuPercent],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number.`);
    }
  }
  if (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2) {
    throw new Error("--temperature must be between 0 and 2.");
  }
  if (options.serverPid !== undefined && (!Number.isInteger(options.serverPid) || options.serverPid <= 0)) {
    throw new Error("--server-pid must be a positive integer.");
  }
  return options;
}

function validateTasks() {
  const errors = [];
  const names = new Set();
  for (const task of TASKS) {
    if (typeof task.name !== "string" || task.name.length === 0) {
      errors.push("A task has no name.");
      continue;
    }
    if (names.has(task.name)) {
      errors.push(`Duplicate task name: ${task.name}`);
    }
    names.add(task.name);
    if (typeof task.brief !== "string" || task.brief.trim().length === 0) {
      errors.push(`${task.name}: missing brief.`);
    }
    if (typeof task.target !== "string" || task.target.length === 0) {
      errors.push(`${task.name}: missing target.`);
    }
    if (task.files === null || typeof task.files !== "object") {
      errors.push(`${task.name}: missing files.`);
      continue;
    }
    if (typeof task.files["video.config.js"] !== "string") {
      errors.push(`${task.name}: seed must contain video.config.js.`);
    } else if (!task.files["video.config.js"].includes("format:")) {
      errors.push(`${task.name}: seed video.config.js must declare a format.`);
    }
    for (const [file, content] of Object.entries(task.files)) {
      if (typeof content !== "string") {
        errors.push(`${task.name}: ${file} is not a string.`);
      }
      if (file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
        errors.push(`${task.name}: unsafe seed path ${file}.`);
      }
    }
  }
  return errors;
}

function safePath(projectRoot, relative) {
  const target = path.resolve(projectRoot, relative);
  if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
    throw new Error(`Path escapes the project root: ${relative}`);
  }
  return target;
}

async function writeFiles(projectRoot, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = safePath(projectRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseFiles(content) {
  let text = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence !== null) {
    text = fence[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Response did not contain a JSON object.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  let files;
  if (Array.isArray(parsed.files)) {
    files = parsed.files;
  } else if (parsed.files !== null && typeof parsed.files === "object") {
    files = Object.entries(parsed.files).map(([filePath, fileContent]) => ({
      path: filePath,
      content: fileContent,
    }));
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    Object.values(parsed).every((value) => typeof value === "string")
  ) {
    files = Object.entries(parsed).map(([filePath, fileContent]) => ({ path: filePath, content: fileContent }));
  } else {
    throw new Error("Response JSON did not contain a files array or map.");
  }

  let totalBytes = 0;
  const normalized = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") {
      throw new Error("Each file entry must be an object.");
    }
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error("Each file entry needs a path.");
    }
    if (typeof file.content !== "string") {
      throw new Error(`File ${file.path} needs string content.`);
    }
    if (file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe file path: ${file.path}`);
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += bytes;
    if (bytes > 256 * 1024 || totalBytes > 1024 * 1024) {
      throw new Error(`Response files are too large (${totalBytes} bytes).`);
    }
    normalized.push({ path: file.path, content: file.content });
  }
  if (normalized.length === 0) {
    throw new Error("Response contained no files.");
  }
  return normalized;
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

async function callModel(options, model, messages) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const body = await response.json();
    const content = messageText(body.choices?.[0]?.message);
    if (content.trim().length === 0) {
      throw new Error("Model returned an empty message.");
    }
    return {
      content,
      usage: body.usage ?? null,
      wallMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCli(args, cwd) {
  const startedAt = performance.now();
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--json"], {
      cwd,
      env: { ...process.env, FRAMEYARD_POLICY: "authoring" },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, wallMs: performance.now() - startedAt };
  } catch (error) {
    const failure = error;
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      wallMs: performance.now() - startedAt,
    };
  }
}

function diagnosticsOf(result) {
  const body = parseJson(result.stdout);
  if (Array.isArray(body?.diagnostics)) {
    return body.diagnostics;
  }
  return [];
}

function warningsOf(diagnostics) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
}

function errorOf(diagnostics) {
  const first = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return first?.message ?? undefined;
}

function summarizeDiagnostics(diagnostics) {
  return diagnostics.slice(0, 20).map((diagnostic) => ({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
  }));
}

function taskPrompt(task, files) {
  const rendered = Object.entries(files)
    .map(([filePath, content]) => `--- ${filePath} ---\n${content}`)
    .join("\n");
  return `Task: ${task.brief}
Target id: ${task.target}

Current project files:
${rendered}

Return the complete files needed for the task. Keep unchanged files only if you need to edit them.
Do not add commentary outside the JSON object.`;
}

function repairPrompt(diagnostics, parseError) {
  if (parseError !== undefined) {
    return `Your previous response was not valid: ${parseError}
Return only one JSON object with a files array. Write complete file contents. Do not use Markdown fences.`;
  }
  return `The project did not pass lint with the requested warnings budget.
Diagnostics:
${JSON.stringify(summarizeDiagnostics(diagnostics), null, 2)}
Return the corrected complete files as one JSON object. Do not use Markdown fences.`;
}

function createSampler(pid) {
  const clockTicks = (() => {
    try {
      return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    } catch {
      return 100;
    }
  })();
  let initial = null;
  let latest = null;
  let peakRss = 0;
  let gpuMax = 0;
  let gpuMemoryMax = 0;
  let samples = 0;
  let timer = null;

  const readProc = () => {
    if (pid === undefined) {
      return null;
    }
    try {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = value.lastIndexOf(")");
      const fields = value
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const user = Number(fields[11] ?? 0);
      const system = Number(fields[12] ?? 0);
      const childUser = Number(fields[13] ?? 0);
      const childSystem = Number(fields[14] ?? 0);
      const rssPages = Number(fields[21] ?? 0);
      return {
        ticks: user + system + childUser + childSystem,
        rssBytes: rssPages * 4096,
      };
    } catch {
      return null;
    }
  };

  const readGpu = () => {
    try {
      const value = execFileSync(
        "nvidia-smi",
        ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
        { encoding: "utf8", timeout: 1000 },
      ).trim();
      const first = value.split(/\r?\n/)[0];
      const [utilization, memory] = first.split(",").map((entry) => Number(entry.trim()));
      gpuMax = Math.max(gpuMax, Number.isFinite(utilization) ? utilization : 0);
      gpuMemoryMax = Math.max(gpuMemoryMax, Number.isFinite(memory) ? memory : 0);
    } catch {
      // No GPU or no nvidia-smi.
    }
  };

  const sample = () => {
    const current = readProc();
    if (current !== null) {
      latest = current;
      peakRss = Math.max(peakRss, current.rssBytes);
      samples += 1;
    }
    readGpu();
  };

  return {
    start() {
      if (pid === undefined) {
        return;
      }
      initial = readProc();
      latest = initial;
      readGpu();
      timer = setInterval(sample, 500);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (pid !== undefined) {
        sample();
      }
      if (initial === null || latest === null) {
        return {
          available: false,
          reason: pid === undefined ? "no server pid" : "could not read /proc",
        };
      }
      return {
        available: true,
        pid,
        cpuMs: Math.round(((latest.ticks - initial.ticks) / clockTicks) * 1000),
        peakRssBytes: peakRss,
        gpuUtilMax: gpuMax,
        gpuMemoryMaxMiB: gpuMemoryMax,
        samples,
      };
    },
  };
}

function detectServerPid() {
  try {
    const output = execFileSync("pgrep", ["-f", "llama-server"], { encoding: "utf8" }).trim();
    const first = output
      .split(/\r?\n/)
      .map((entry) => Number(entry))
      .find((entry) => Number.isInteger(entry) && entry > 0);
    return first;
  } catch {
    return undefined;
  }
}

async function checkServer(options) {
  const base = options.baseUrl.replace(/\/$/, "");
  const headers = options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {};
  let health;
  try {
    health = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`Cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!health.ok) {
    throw new Error(`Health check failed with HTTP ${health.status}.`);
  }
  let models;
  try {
    const response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    models = await response.json();
  } catch (error) {
    throw new Error(`Cannot read /v1/models: ${error instanceof Error ? error.message : String(error)}`);
  }
  const available = new Set((models.data ?? []).map((model) => model.id));
  const missing = options.models.filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(
      `Model(s) not available: ${missing.join(", ")}. Available: ${[...available].join(", ") || "(none)"}.`,
    );
  }
}

function budgetOf(options, resources) {
  if (resources.available !== true) {
    return { checked: false, within: null };
  }
  const rssOk = options.maxRssMb === 0 || resources.peakRssBytes <= options.maxRssMb * 1024 * 1024;
  const cpuOk = options.maxCpuMs === 0 || resources.cpuMs <= options.maxCpuMs;
  const gpuOk = resources.gpuUtilMax <= options.maxGpuPercent;
  return {
    checked: true,
    within: rssOk && cpuOk && gpuOk,
    limits: {
      rssMb: options.maxRssMb,
      cpuMs: options.maxCpuMs,
      gpuPercent: options.maxGpuPercent,
    },
  };
}

async function runTask(task, model, options, quickReference) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "frameyard-eval-"));
  const sampler = createSampler(options.serverPid);
  const startedAt = performance.now();
  let modelMs = 0;
  let commandMs = 0;
  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let appliedFiles = [];
  let lastLint;
  let lastCheck;
  let lastStill;
  let lastInspect;
  let firstLint;
  let lastParseError;
  let lastModelError;

  const messages = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT}\n\nQuick reference:\n${quickReference}`,
    },
    { role: "user", content: taskPrompt(task, task.files) },
  ];

  try {
    await writeFiles(projectRoot, task.files);
    sampler.start();

    for (let attempt = 0; attempt <= options.repairs; attempt += 1) {
      let response;
      try {
        response = await callModel(options, model, messages);
      } catch (error) {
        lastModelError = error instanceof Error ? error.message : String(error);
        break;
      }
      turns += 1;
      modelMs += response.wallMs;
      if (response.usage !== null && typeof response.usage === "object") {
        tokensIn += Number(response.usage.prompt_tokens ?? 0);
        tokensOut += Number(response.usage.completion_tokens ?? 0);
      }

      let files;
      try {
        files = parseFiles(response.content);
        await writeFiles(projectRoot, Object.fromEntries(files.map((file) => [file.path, file.content])));
        appliedFiles = files.map((file) => file.path);
        lastParseError = undefined;
      } catch (error) {
        lastParseError = error instanceof Error ? error.message : String(error);
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: repairPrompt([], lastParseError) });
        continue;
      }

      lastLint = await runCli(["lint", task.target], projectRoot);
      commandMs += lastLint.wallMs;
      if (attempt === 0) {
        firstLint = lastLint;
      }
      const diagnostics = diagnosticsOf(lastLint);
      const warnings = warningsOf(diagnostics);
      const maxWarnings = task.expect?.maxWarnings ?? 0;
      if (lastLint.code === 0 && warnings.length <= maxWarnings) {
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: repairPrompt(diagnostics, undefined) });
    }

    const lintDiagnostics = lastLint === undefined ? [] : diagnosticsOf(lastLint);
    const lintWarnings = warningsOf(lintDiagnostics);
    const maxWarnings = task.expect?.maxWarnings ?? 0;
    const lintPass = lastLint !== undefined && lastLint.code === 0 && lintWarnings.length <= maxWarnings;
    const firstPass =
      firstLint !== undefined && firstLint.code === 0 && warningsOf(diagnosticsOf(firstLint)).length <= maxWarnings;

    let checkPass = null;
    let stillPass = null;
    let inspectPass = null;
    let inspectBody;
    if (lintPass && !options.lintOnly) {
      lastCheck = await runCli(["check", task.target], projectRoot);
      commandMs += lastCheck.wallMs;
      const checkDiagnostics = diagnosticsOf(lastCheck);
      checkPass = lastCheck.code === 0 && warningsOf(checkDiagnostics).length <= maxWarnings;

      if (checkPass) {
        const stillPath = path.join(projectRoot, "eval-still.png");
        lastStill = await runCli(
          ["still", task.target, "--frame", String(task.expect?.stillFrame ?? 0), "--out", stillPath],
          projectRoot,
        );
        commandMs += lastStill.wallMs;
        stillPass = lastStill.code === 0;
        if (stillPass) {
          lastInspect = await runCli(["inspect", stillPath], projectRoot);
          commandMs += lastInspect.wallMs;
          inspectBody = parseJson(lastInspect.stdout);
          inspectPass =
            lastInspect.code === 0 && inspectBody?.blank === false && Number(inspectBody?.content?.pixels ?? 0) > 0;
        }
      }
    }

    const resources = sampler.stop();
    const correct =
      lintPass && (options.lintOnly || (checkPass === true && stillPass === true && inspectPass === true));
    const status = lastModelError !== undefined ? "error" : correct ? "pass" : "fail";
    const diagnostics = summarizeDiagnostics(
      lastCheck !== undefined && lastCheck.code !== 0 ? diagnosticsOf(lastCheck) : lintDiagnostics,
    );

    return {
      model,
      task: task.name,
      status,
      correct,
      firstPass,
      turns,
      repairs: Math.max(0, turns - 1),
      target: task.target,
      files: appliedFiles,
      ...(lastModelError !== undefined ? { error: lastModelError } : {}),
      ...(lastModelError === undefined && lastParseError !== undefined ? { error: lastParseError } : {}),
      ...(lastModelError === undefined &&
      lastParseError === undefined &&
      !lintPass &&
      errorOf(lintDiagnostics) !== undefined
        ? { error: errorOf(lintDiagnostics) }
        : {}),
      lint: {
        pass: lintPass,
        exitCode: lastLint?.code ?? null,
        warnings: lintWarnings.length,
        diagnostics,
      },
      check:
        lastCheck === undefined
          ? null
          : {
              pass: checkPass,
              exitCode: lastCheck.code,
              warnings: warningsOf(diagnosticsOf(lastCheck)).length,
            },
      still:
        lastStill === undefined
          ? null
          : {
              pass: stillPass,
              exitCode: lastStill.code,
              frame: task.expect?.stillFrame ?? 0,
            },
      inspect:
        lastInspect === undefined
          ? null
          : {
              pass: inspectPass,
              exitCode: lastInspect.code,
              blank: inspectBody?.blank ?? null,
              contentPixels: inspectBody?.content?.pixels ?? null,
            },
      tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
      timings: {
        totalMs: Math.round(performance.now() - startedAt),
        modelMs: Math.round(modelMs),
        commandMs: Math.round(commandMs),
      },
      resources,
      budget: budgetOf(options, resources),
      ...(options.keep ? { projectRoot } : {}),
    };
  } catch (error) {
    const resources = sampler.stop();
    return {
      model,
      task: task.name,
      status: "error",
      correct: false,
      firstPass: false,
      turns,
      repairs: Math.max(0, turns - 1),
      target: task.target,
      files: appliedFiles,
      error: error instanceof Error ? error.message : String(error),
      lint: { pass: false, exitCode: null, warnings: 0, diagnostics: [] },
      check: null,
      still: null,
      inspect: null,
      tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
      timings: {
        totalMs: Math.round(performance.now() - startedAt),
        modelMs: Math.round(modelMs),
        commandMs: Math.round(commandMs),
      },
      resources,
      budget: budgetOf(options, resources),
      ...(options.keep ? { projectRoot } : {}),
    };
  } finally {
    if (!options.keep) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}

function summarize(results) {
  const byModel = {};
  for (const result of results) {
    const entry = (byModel[result.model] ??= {
      tasks: 0,
      pass: 0,
      fail: 0,
      error: 0,
      firstPass: 0,
      turns: 0,
      tokens: { input: 0, output: 0, total: 0 },
      wallMs: 0,
      peakRssBytes: 0,
      gpuUtilMax: 0,
      withinBudget: 0,
      budgetChecked: 0,
    });
    entry.tasks += 1;
    entry[result.status] += 1;
    if (result.firstPass) entry.firstPass += 1;
    entry.turns += result.turns;
    entry.tokens.input += result.tokens.input;
    entry.tokens.output += result.tokens.output;
    entry.tokens.total += result.tokens.total;
    entry.wallMs += result.timings.totalMs;
    if (result.resources?.available) {
      entry.peakRssBytes = Math.max(entry.peakRssBytes, result.resources.peakRssBytes ?? 0);
      entry.gpuUtilMax = Math.max(entry.gpuUtilMax, result.resources.gpuUtilMax ?? 0);
    }
    if (result.budget?.checked) {
      entry.budgetChecked += 1;
      if (result.budget.within) entry.withinBudget += 1;
    }
  }
  return byModel;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function printHuman(report) {
  console.log("Frameyard local model eval");
  console.log(`server: ${report.baseUrl}`);
  console.log(`models: ${report.models.join(", ")}`);
  console.log(`tasks: ${report.tasks.join(", ")}`);
  console.log("");
  console.log("model\ttask\tstatus\tfirst\tturns\ttokens\twall\tpeak-rss\tgpu\tbudget");
  for (const result of report.results) {
    const resources = result.resources?.available ? result.resources : null;
    console.log(
      [
        result.model,
        result.task,
        result.status,
        result.firstPass ? "yes" : "no",
        String(result.turns),
        String(result.tokens.total),
        `${(result.timings.totalMs / 1000).toFixed(1)}s`,
        resources ? formatBytes(resources.peakRssBytes) : "-",
        resources ? `${resources.gpuUtilMax}%` : "-",
        result.budget?.checked ? (result.budget.within ? "ok" : "over") : "-",
      ].join("\t"),
    );
    if (result.error !== undefined) {
      console.log(`  error: ${result.error}`);
    }
  }
  console.log("");
  for (const [model, entry] of Object.entries(report.summary.byModel)) {
    console.log(
      `${model}: ${entry.pass}/${entry.tasks} pass, ${entry.firstPass} first-pass, ${entry.turns} turns, ${formatBytes(entry.peakRssBytes)} peak RSS, ${entry.gpuUtilMax}% GPU max`,
    );
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const taskErrors = validateTasks();
  if (taskErrors.length > 0) {
    for (const error of taskErrors) {
      console.error(`task: ${error}`);
    }
    process.exit(1);
  }

  if (options.selfCheck) {
    const report = {
      ok: true,
      tasks: TASKS.map((task) => ({ name: task.name, target: task.target, files: Object.keys(task.files) })),
      quickReference: QUICK_REFERENCE,
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Tasks: ${TASKS.length}`);
      for (const task of report.tasks) {
        console.log(`  ${task.name} -> ${task.target} (${task.files.length} seed files)`);
      }
      console.log(`Quick reference: ${QUICK_REFERENCE}`);
    }
    return;
  }

  try {
    await stat(CLI);
  } catch {
    console.error(`Missing ${CLI}. Run pnpm build first.`);
    process.exit(1);
  }

  let quickReference;
  try {
    quickReference = await readFile(QUICK_REFERENCE, "utf8");
  } catch {
    console.error(`Missing ${QUICK_REFERENCE}.`);
    process.exit(1);
  }

  const selectedTasks = options.only.length === 0 ? TASKS : options.only.map((name) => findTask(name)).filter(Boolean);
  if (selectedTasks.length === 0) {
    console.error(`No tasks matched --only ${options.only.join(", ")}.`);
    process.exit(2);
  }

  if (options.serverPid === undefined) {
    options.serverPid = detectServerPid();
  }

  try {
    await checkServer(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const results = [];
  for (const model of options.models) {
    for (const task of selectedTasks) {
      if (!options.json) {
        process.stderr.write(`Running ${model} / ${task.name}...\n`);
      }
      results.push(await runTask(task, model, options, quickReference));
    }
  }

  const report = {
    ok: results.every((result) => result.status !== "error"),
    baseUrl: options.baseUrl,
    models: options.models,
    tasks: selectedTasks.map((task) => task.name),
    serverPid: options.serverPid ?? null,
    quickReference: path.relative(ROOT, QUICK_REFERENCE).split(path.sep).join("/"),
    results,
    summary: { byModel: summarize(results) },
  };

  if (options.out !== undefined) {
    const outPath = path.resolve(ROOT, options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  const hasError = results.some((result) => result.status === "error");
  const hasFail = results.some((result) => result.status !== "pass");
  process.exitCode = hasError || (options.failOnTask && hasFail) ? 1 : 0;
}

await main();
