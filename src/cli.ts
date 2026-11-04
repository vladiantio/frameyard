#!/usr/bin/env node
import { access, mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainObject } from "./contracts.js";
import { FrameyardError, errorMessage, isFrameyardError, type FrameyardDiagnostic } from "./errors.js";
import { loadProject, resolveProjectRoot, type Project } from "./project.js";
import {
  checkComposition,
  captureStills,
  MAX_RENDER_CONCURRENCY,
  renderComposition,
  validateRenderConcurrency,
  type ProgressEvent,
  type StillResult,
} from "./renderer/index.js";
import {
  MAX_TIMELINE_WORKERS,
  captureTimelineStills,
  checkTimeline,
  renderTimeline,
  type TimelineStillResult,
} from "./renderer/timeline.js";
import {
  assertContainerCodec,
  CONTAINER_EXTENSION,
  defaultCodecForContainer,
  encoderNameFor,
  type VideoCodec,
  type VideoContainer,
  type VideoEncoderChoice,
} from "./renderer/ffmpeg.js";
import { startPreviewServer } from "./server/server.js";
import { scaffoldFiles, SCAFFOLD_NEXT } from "./scaffold.js";
import { VERSION } from "./version.js";
import { transcribeAudio, type SubtitleFormat } from "./assets/transcribe.js";
import { synthesizeSpeech, type SpeechEngine } from "./assets/tts.js";
import { isSupertonicLanguage, parseSupertonicSpeaker, SUPERTONIC_LANGUAGES } from "./assets/tts-supertonic.js";
import { resolveManifestPath } from "./assets/provenance.js";
import { runDoctor } from "./doctor.js";

const COMMANDS = new Set(["init", "dev", "check", "still", "render", "tts", "transcribe", "doctor", "help"]);
const VALUE_FLAGS = new Set([
  "project",
  "props",
  "out",
  "frame",
  "port",
  "concurrency",
  "workers",
  "scratch",
  "encoder",
  "codec",
  "container",
  "text-file",
  "speaker",
  "engine",
  "model-dir",
  "talker-model",
  "codec-model",
  "style",
  "language",
  "device",
  "executable",
  "model",
  "export",
  "manifest",
  "qwen-tts",
  "sherpa-onnx-tts",
  "whisper-cli",
]);
const BOOLEAN_FLAGS = new Set(["json", "overwrite", "force", "words", "help", "version"]);
const MAX_STILL_FRAMES = 32;

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function usage(message = "Invalid command line."): never {
  throw new FrameyardError("USAGE", message);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let command = "";
  let raw = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (raw) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      raw = true;
      continue;
    }
    if (argument === "-h") {
      flags.set("help", true);
      continue;
    }
    if (argument === "-v") {
      flags.set("version", true);
      continue;
    }

    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
      const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);

      if (VALUE_FLAGS.has(name)) {
        let value = inlineValue;
        if (value === undefined) {
          index += 1;
          value = argv[index];
        }
        if (value === undefined || value === "") {
          usage(`Option --${name} requires a value.`);
        }
        flags.set(name, value);
        continue;
      }

      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          usage(`Option --${name} does not take a value.`);
        }
        flags.set(name, true);
        continue;
      }

      usage(`Unknown option --${name}.`);
    }

    if (argument.startsWith("-") && argument !== "-") {
      usage(`Unknown option ${argument}.`);
    }

    if (!command) {
      command = argument;
    } else {
      positionals.push(argument);
    }
  }

  return { command, positionals, flags };
}

function allowedFlags(command: string): Set<string> {
  const common = new Set(["project", "json", "help"]);
  switch (command) {
    case "init":
      return new Set(["json", "help"]);
    case "dev":
      return new Set(["project", "port", "help"]);
    case "check":
      return new Set([...common, "props"]);
    case "still":
      return new Set([...common, "props", "out", "frame", "overwrite"]);
    case "render":
      return new Set([
        ...common,
        "props",
        "out",
        "overwrite",
        "concurrency",
        "workers",
        "scratch",
        "encoder",
        "codec",
        "container",
      ]);
    case "tts":
      return new Set([
        ...common,
        "text-file",
        "speaker",
        "engine",
        "model-dir",
        "talker-model",
        "codec-model",
        "out",
        "style",
        "language",
        "device",
        "executable",
        "manifest",
        "force",
      ]);
    case "transcribe":
      return new Set([...common, "out", "model", "words", "export", "language", "executable", "manifest", "force"]);
    case "doctor":
      return new Set([
        ...common,
        "manifest",
        "qwen-tts",
        "sherpa-onnx-tts",
        "whisper-cli",
        "talker-model",
        "codec-model",
        "model-dir",
        "model",
      ]);
    case "help":
      return new Set(["help"]);
    default:
      return new Set();
  }
}

function validateArgs(parsed: ParsedArgs): void {
  if (parsed.flags.has("version")) {
    return;
  }
  if (!parsed.command) {
    return;
  }
  if (!COMMANDS.has(parsed.command)) {
    usage(`Unknown command "${parsed.command}".`);
  }

  for (const flag of parsed.flags.keys()) {
    if (!allowedFlags(parsed.command).has(flag)) {
      usage(`Option --${flag} is not valid for "${parsed.command}".`);
    }
  }

  if (["dev", "help", "doctor", "tts"].includes(parsed.command)) {
    if (parsed.positionals.length > 0) {
      usage(`"${parsed.command}" does not take a positional argument.`);
    }
  } else if (parsed.command === "init") {
    if (parsed.positionals.length > 1) {
      usage(`"${parsed.command}" accepts at most 1 positional argument.`);
    }
  } else if (parsed.positionals.length !== 1) {
    usage(
      `"${parsed.command}" requires a ${
        parsed.command === "transcribe"
          ? "source path"
          : parsed.command === "render"
            ? "composition or timeline id"
            : "composition id"
      }.`,
    );
  }

  if (parsed.command === "still" && !parsed.flags.has("frame")) {
    usage('"still" requires --frame <spec>.');
  }
  if (parsed.command === "render" && parsed.flags.has("concurrency")) {
    validateRenderConcurrency(Number(parsed.flags.get("concurrency")));
  }
  if (parsed.command === "tts") {
    const requestedEngine = parsed.flags.get("engine");
    let engine: SpeechEngine = "qwen";
    if (requestedEngine !== undefined) {
      if (typeof requestedEngine !== "string" || (requestedEngine !== "qwen" && requestedEngine !== "supertonic")) {
        usage('--engine must be "qwen" or "supertonic".');
      }
      engine = requestedEngine;
    }

    if (engine === "supertonic") {
      for (const required of ["speaker", "model-dir", "language", "out"]) {
        if (!parsed.flags.has(required)) {
          usage(`"tts" requires --${required} with --engine supertonic.`);
        }
      }
      for (const forbidden of ["talker-model", "codec-model", "style", "device"]) {
        if (parsed.flags.has(forbidden)) {
          usage(`--${forbidden} is not valid with --engine supertonic.`);
        }
      }
      const speaker = parsed.flags.get("speaker");
      if (typeof speaker === "string") {
        try {
          parseSupertonicSpeaker(speaker);
        } catch (error) {
          usage(error instanceof Error ? error.message : String(error));
        }
      }
      const language = parsed.flags.get("language");
      if (typeof language === "string" && !isSupertonicLanguage(language)) {
        usage(`--language must be one of: ${SUPERTONIC_LANGUAGES.join(", ")}.`);
      }
    } else {
      for (const required of ["speaker", "talker-model", "codec-model", "out"]) {
        if (!parsed.flags.has(required)) {
          usage(`"tts" requires --${required}.`);
        }
      }
      if (parsed.flags.has("model-dir")) {
        usage("--model-dir is only valid with --engine supertonic.");
      }
    }
  }
  if (parsed.command === "transcribe") {
    for (const required of ["out", "model"]) {
      if (!parsed.flags.has(required)) {
        usage(`"transcribe" requires --${required}.`);
      }
    }
  }
}

function inferCommand(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      return "";
    }
    if (argument.startsWith("--")) {
      const name = argument.slice(2).split("=")[0] as string;
      if (VALUE_FLAGS.has(name) && !argument.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return argument;
  }
  return "";
}

function printHelp(): void {
  process.stdout.write(`Frameyard ${VERSION}

Local-first, deterministic video compositions authored with HTML, CSS, and JavaScript.

Usage:
  frameyard init [directory]
  frameyard dev [--port <port>] [--project <dir>]
  frameyard check <composition-id> [--props <file>] [--project <dir>] [--json]
  frameyard still <composition-or-timeline-id> --frame <spec> [--out <file-or-dir>] [--props <file>] [--project <dir>] [--json]
  frameyard render <composition-or-timeline-id> [--out <file>] [--props <file>] [--project <dir>] [--concurrency <n>] [--workers <n>] [--encoder <name>] [--codec <name>] [--container <name>] [--scratch <dir>] [--overwrite] [--json]
  frameyard tts [--engine qwen] --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--json]
  frameyard tts --engine supertonic --speaker <sid> --model-dir <dir> --language <code> --out <file.wav> [--text-file <file>] [--executable <path>] [--manifest <file>] [--force] [--json]
  frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--json]
  frameyard doctor [--qwen-tts <path>] [--sherpa-onnx-tts <path>] [--whisper-cli <path>] [--talker-model <gguf>] [--codec-model <gguf>] [--model-dir <dir>] [--model <gguf>] [--manifest <file>] [--project <dir>] [--json]

Options:
  --project <dir>        Use a project other than the current directory.
  --props <file>         Composition props, or a { "<clip-id>": {...} } override map for a timeline.
  --out <path>           Output path for still, render, tts, or transcribe. For still, one frame uses a .png file and multiple frames use a directory. Render defaults to out/<id>.mp4 for video and out/<id>.png for a static composition.
  --frame <spec>         Still frames: n, n-m, or a comma-separated list (maximum 32 unique frames).
  --concurrency <n>      Parallel browser sessions for animated composition render, 1-${MAX_RENDER_CONCURRENCY} (default: 1).
  --workers <n>          Parallel segment workers for timeline render, 1-${MAX_TIMELINE_WORKERS} (default: 8).
  --encoder <name>       Encoder: auto, software, nvenc, or qsv (default: auto).
  --codec <name>         Delivery codec for render: h264, hevc, or vp9 (default: h264; vp9 for webm).
  --container <name>     Delivery container: mp4, mov, mkv, or webm (default: mp4).
  --scratch <dir>        Scratch directory for timeline intermediates (default: system temp).
  --overwrite            Replace an existing still or render output.
  --force                Replace existing generated assets and manifest entries.
  --text-file <file>     Text to synthesize. Reads stdin when omitted.
  --speaker <value>      Named speaker for qwen, or the numeric speaker id for Supertonic.
  --engine <name>        Speech engine: qwen or supertonic (default: qwen).
  --model-dir <dir>      Supertonic model directory from the sherpa-onnx archive.
  --talker-model <gguf>  Talker GGUF model path for qwen.
  --codec-model <gguf>   Codec GGUF model path for qwen.
  --style <text>         Optional style instruction for qwen speech synthesis.
  --language <lang>      Spoken language. Supertonic requires one of its 31 upstream language codes.
  --device <name>        Compute device for qwen-tts, such as CPU or CUDA0.
  --model <gguf>         Whisper GGML model path.
  --words                Request measured word timings during transcription.
  --export srt,vtt       Derived subtitle exports next to the transcript.
  --executable <path>    Explicit qwen-tts, sherpa-onnx-offline-tts, or whisper-cli executable.
  --manifest <file>      Provenance manifest path (default: frameyard.assets.json).
  --qwen-tts <path>      qwen-tts executable to inspect with doctor.
  --sherpa-onnx-tts <path>  sherpa-onnx-offline-tts executable to inspect with doctor.
  --whisper-cli <path>   whisper-cli executable to inspect with doctor.
  --json                 Print a structured result to stdout.
  --help, -h             Show this help.
  --version, -v          Print the version.
`);
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "init":
      process.stdout.write("Usage: frameyard init [directory]\nScaffold a minimal Frameyard project.\n");
      return;
    case "dev":
      process.stdout.write(
        "Usage: frameyard dev [--port <port>] [--project <dir>]\nStart the browser preview server.\n",
      );
      return;
    case "check":
      process.stdout.write(
        "Usage: frameyard check <composition-id> [--props <file>] [--project <dir>] [--json]\nValidate props, assets, audio, and every frame without encoding.\n",
      );
      return;
    case "still":
      process.stdout.write(
        "Usage: frameyard still <composition-or-timeline-id> --frame <spec> [--out <path>] [--props <file>] [--project <dir>] [--overwrite] [--json]\nCapture one or more frames through the production rendering path. <spec> is a frame number, an inclusive range like 2-12, or a comma-separated list, with at most 32 unique frames per invocation. With one frame, --out is a .png file; with multiple frames, --out is a directory. A static composition exposes only frame 0.\n",
      );
      return;
    case "render":
      process.stdout.write(
        `Usage: frameyard render <composition-or-timeline-id> [--out <file>] [--props <file>] [--project <dir>] [--concurrency <n>] [--workers <n>] [--encoder <name>] [--codec <name>] [--container <name>] [--scratch <dir>] [--overwrite] [--json]\nRender an MP4, MOV, MKV, or WebM with H.264, HEVC, or VP9 video and AAC or Opus audio, or a PNG for a static composition. The default output is out/<id>.<extension> for video and out/<id>.png for a static composition. Animated composition concurrency is 1-${MAX_RENDER_CONCURRENCY}; timeline workers are 1-${MAX_TIMELINE_WORKERS}. Encoder choices are auto, software, nvenc, and qsv; the default auto probes NVENC, then Quick Sync, then the codec's software encoder. WebM and VP9 use Opus audio, and HEVC in MP4/MOV keeps the hvc1 sample entry. A static composition rejects --concurrency, --container, --codec, and --encoder.\n`,
      );
      return;
    case "tts":
      process.stdout.write(
        "Usage: frameyard tts [--engine qwen] --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--json]\n       frameyard tts --engine supertonic --speaker <sid> --model-dir <dir> --language <code> --out <file.wav> [--text-file <file>] [--executable <path>] [--manifest <file>] [--force] [--json]\nProduce one frozen 24 kHz mono WAV with local qwentts.cpp CustomVoice or sherpa-onnx Supertonic 3 synthesis. Supertonic language codes: ar, bg, cs, da, de, el, en, es, et, fi, fr, hi, hr, hu, id, it, ja, ko, lt, lv, nl, pl, pt, ro, ru, sk, sl, sv, tr, uk, vi.\n",
      );
      return;
    case "transcribe":
      process.stdout.write(
        "Usage: frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--json]\nProduce a canonical Frameyard transcript, optionally with word timings and subtitle exports.\n",
      );
      return;
    case "doctor":
      process.stdout.write(
        "Usage: frameyard doctor [--qwen-tts <path>] [--sherpa-onnx-tts <path>] [--whisper-cli <path>] [--talker-model <gguf>] [--codec-model <gguf>] [--model-dir <dir>] [--model <gguf>] [--manifest <file>] [--project <dir>] [--json]\nInspect core requirements, optional integrations, model readability, and provenance integrity without changing the environment.\n",
      );
      return;
    default:
      printHelp();
  }
}

async function projectFromFlag(flags: Map<string, string | true>): Promise<Project> {
  const requested = flags.get("project");
  const root =
    typeof requested === "string" ? path.resolve(process.cwd(), requested) : await resolveProjectRoot(process.cwd());
  return loadProject(root);
}

/** Resolves the directory that anchors the project-local provenance manifest. */
async function assetRootFromFlag(flags: Map<string, string | true>): Promise<string> {
  const requested = flags.get("project");
  if (typeof requested === "string") {
    const root = path.resolve(process.cwd(), requested);
    let info;
    try {
      info = await stat(root);
    } catch {
      throw new FrameyardError("CONFIG_NOT_FOUND", `Project directory does not exist: ${root}`);
    }
    if (!info.isDirectory()) {
      throw new FrameyardError("CONFIG_NOT_FOUND", `Project directory is not a directory: ${root}`);
    }
    return root;
  }

  try {
    return await resolveProjectRoot(process.cwd());
  } catch (error) {
    if (isFrameyardError(error) && error.code === "CONFIG_NOT_FOUND") {
      return process.cwd();
    }
    throw error;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

const ENCODER_CHOICES = new Set<VideoEncoderChoice>(["auto", "software", "nvenc", "qsv"]);
const CODEC_CHOICES = new Set<VideoCodec>(["h264", "hevc", "vp9"]);
const CONTAINER_CHOICES = new Set<VideoContainer>(["mp4", "mov", "mkv", "webm"]);

function encoderChoice(flags: Map<string, string | true>): VideoEncoderChoice | undefined {
  const value = flagString(flags, "encoder");
  if (value === undefined) {
    return undefined;
  }
  if (!ENCODER_CHOICES.has(value as VideoEncoderChoice)) {
    usage(`--encoder must be auto, software, nvenc, or qsv; received "${value}".`);
  }
  return value as VideoEncoderChoice;
}

function codecChoice(flags: Map<string, string | true>): VideoCodec | undefined {
  const value = flagString(flags, "codec");
  if (value === undefined) {
    return undefined;
  }
  if (!CODEC_CHOICES.has(value as VideoCodec)) {
    usage(`--codec must be h264, hevc, or vp9; received "${value}".`);
  }
  return value as VideoCodec;
}

function containerChoice(flags: Map<string, string | true>): VideoContainer | undefined {
  const value = flagString(flags, "container");
  if (value === undefined) {
    return undefined;
  }
  if (!CONTAINER_CHOICES.has(value as VideoContainer)) {
    usage(`--container must be mp4, mov, mkv, or webm; received "${value}".`);
  }
  return value as VideoContainer;
}

function parseSubtitleFormats(value: string | true | undefined): SubtitleFormat[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string") {
    usage("--export requires a comma-separated list of srt and vtt.");
  }

  const formats: SubtitleFormat[] = [];
  for (const raw of value.split(",")) {
    const format = raw.trim().toLowerCase();
    if (format.length === 0) {
      continue;
    }
    if (format !== "srt" && format !== "vtt") {
      usage(`Unsupported subtitle export "${raw}". Use srt or vtt.`);
    }
    if (!formats.includes(format)) {
      formats.push(format);
    }
  }
  if (formats.length === 0) {
    usage("--export requires at least one of srt or vtt.");
  }
  return formats;
}

async function readPropsFile(flags: Map<string, string | true>): Promise<unknown> {
  const value = flags.get("props");
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    usage("--props requires a file path.");
  }

  const propsPath = path.resolve(process.cwd(), value);
  let text: string;
  try {
    text = await readFile(propsPath, "utf8");
  } catch (error) {
    throw new FrameyardError("PROPS_INVALID", `Could not read props file ${propsPath}.`, { cause: error });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FrameyardError(
      "PROPS_INVALID",
      `Props file ${propsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function progressPrinter(label: string): (event: ProgressEvent) => void {
  let nextPercent = 0;
  return (event) => {
    const percent = event.total === 0 ? 100 : Math.floor((event.frame / event.total) * 100);
    if (event.frame === event.total || percent >= nextPercent) {
      process.stderr.write(
        `${label} ${event.frame}/${event.total} (${percent}%) ${(event.elapsedMs / 1000).toFixed(1)}s\n`,
      );
      nextPercent = percent + 10;
    }
  };
}

function formatDuration(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function printDiagnostics(diagnostics: readonly FrameyardDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const details = diagnostic.details as { path?: string; line?: number; column?: number } | undefined;
    const location =
      details?.line !== undefined ? ` (${details.path ?? "composition"}:${details.line}:${details.column ?? 1})` : "";
    process.stderr.write(`${diagnostic.severity}: [${diagnostic.code}] ${diagnostic.message}${location}\n`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInit(parsed: ParsedArgs): Promise<number> {
  const target = path.resolve(process.cwd(), parsed.positionals[0] ?? ".");
  const json = parsed.flags.has("json") === true;

  const files = scaffoldFiles(path.basename(target) || "frameyard-project");

  for (const relativePath of Object.keys(files)) {
    try {
      await access(path.join(target, relativePath));
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Refusing to overwrite ${path.join(target, relativePath)}. Choose an empty directory.`,
      );
    } catch (error) {
      if (isFrameyardError(error)) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await mkdir(target, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(target, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { flag: "wx" });
  }

  const result = {
    ok: true,
    command: "init",
    project: target,
    files: Object.keys(files),
    next: [...SCAFFOLD_NEXT],
  };

  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`Created Frameyard project at ${target}\n`);
    for (const file of Object.keys(files)) {
      process.stdout.write(`  ${file}\n`);
    }
    process.stdout.write("Next: " + SCAFFOLD_NEXT.slice(0, 2).join(" && ") + "\n");
  }
  return 0;
}

async function runDev(parsed: ParsedArgs): Promise<number> {
  const portValue = parsed.flags.get("port");
  const port = typeof portValue === "string" ? Number(portValue) : 5173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    usage("--port must be an integer between 0 and 65535.");
  }

  const project = await projectFromFlag(parsed.flags);
  const server = await startPreviewServer({ projectRoot: project.root, port });

  process.stdout.write(`Frameyard preview: ${server.url}\n`);
  process.stdout.write(`Project: ${project.root}\n`);
  process.stdout.write(`Compositions: ${[...project.compositions.keys()].join(", ") || "(none)"}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

  await server.close();
  return 0;
}

async function runCheck(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  const props = await readPropsFile(parsed.flags);
  const targetId = parsed.positionals[0] as string;
  const json = parsed.flags.has("json") === true;

  if (project.timelines.has(targetId)) {
    if (props !== undefined && !isPlainObject(props)) {
      usage("Timeline --props must be a JSON object keyed by composition clip id.");
    }
    const result = await checkTimeline({
      project,
      timelineId: targetId,
      ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
      signal,
      onProgress: progressPrinter("Checking"),
    });

    printDiagnostics(result.diagnostics);
    if (json) {
      printJson({ ok: true, command: "check", ...result });
    } else {
      process.stdout.write(
        `✓ timeline ${targetId}: ${result.framesChecked} frames, ${result.format.width}×${result.format.height} @ ${result.format.fps} fps (${formatDuration(result.durationInFrames / result.format.fps)}), ${result.tracks} track${result.tracks === 1 ? "" : "s"}, ${result.clips} clip${result.clips === 1 ? "" : "s"}, ${result.transitions} transition${result.transitions === 1 ? "" : "s"}\n`,
      );
      process.stdout.write(`  audio: ${result.audio.clips} clip${result.audio.clips === 1 ? "" : "s"}\n`);
      if (result.transcripts.clips > 0) {
        process.stdout.write(
          `  transcripts: ${result.transcripts.clips} asset${result.transcripts.clips === 1 ? "" : "s"}\n`,
        );
      }
    }
    return 0;
  }

  const compositionId = targetId;
  const result = await checkComposition({
    project,
    compositionId,
    props,
    signal,
    onProgress: progressPrinter("Checking"),
  });

  if (json) {
    printJson({ ok: true, command: "check", ...result });
  } else if (result.kind === "static") {
    process.stdout.write(`✓ ${compositionId}: static ${result.metadata.width}×${result.metadata.height}\n`);
  } else {
    const meta = result.metadata;
    process.stdout.write(
      `✓ ${compositionId}: ${result.framesChecked} frames, ${meta.width}×${meta.height} @ ${meta.fps} fps (${formatDuration(meta.durationInFrames / meta.fps)})\n`,
    );
    process.stdout.write(`  audio: ${result.audio.clips} clip${result.audio.clips === 1 ? "" : "s"}\n`);
    for (const clip of result.audio.details) {
      process.stdout.write(
        `    ${clip.src}: ${clip.startSeconds.toFixed(2)}s–${clip.endSeconds.toFixed(2)}s (source ${clip.sourceDurationSeconds.toFixed(2)}s, volume ${clip.volume})\n`,
      );
    }
    if (result.transcripts.clips > 0) {
      process.stdout.write(
        `  transcripts: ${result.transcripts.clips} asset${result.transcripts.clips === 1 ? "" : "s"}\n`,
      );
      for (const transcript of result.transcripts.details) {
        process.stdout.write(
          `    ${transcript.src}: ${transcript.segments} segment${transcript.segments === 1 ? "" : "s"}${transcript.words === undefined ? "" : `, ${transcript.words} word${transcript.words === 1 ? "" : "s"}`}${transcript.language === undefined ? "" : `, ${transcript.language}`}, ${formatDuration(transcript.durationMs / 1000)}\n`,
        );
      }
    }
  }
  printDiagnostics(result.diagnostics);
  return 0;
}

function frameSpecUsage(message: string, details: Record<string, unknown>): never {
  throw new FrameyardError("USAGE", message, { details });
}

/** Expands a still frame spec into unique frames, preserving input order. */
function parseFrameSpec(value: string): number[] {
  const frames: number[] = [];
  const seen = new Set<number>();

  for (const rawSegment of value.split(",")) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      frameSpecUsage(`--frame contains an empty entry: "${value}".`, { requested: value });
    }
    if (/\s/.test(segment)) {
      frameSpecUsage(
        `--frame entries must not contain spaces; write ranges like 2-12 and separate frames with commas.`,
        {
          requested: value,
          segment,
        },
      );
    }

    const match = /^(\d+)(?:-(\d+))?$/.exec(segment);
    if (!match) {
      frameSpecUsage(`--frame entries must be a frame number or an inclusive range like 2-12; received "${segment}".`, {
        requested: value,
        segment,
      });
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
      frameSpecUsage(`--frame entries must use non-negative safe integers: "${segment}".`, {
        requested: value,
        segment,
      });
    }
    if (end < start) {
      frameSpecUsage(`--frame range "${segment}" is descending; ranges must be ascending.`, {
        requested: value,
        range: segment,
      });
    }

    const count = end - start + 1;
    if (count > MAX_STILL_FRAMES) {
      frameSpecUsage(
        `--frame range "${segment}" expands to ${count} frames; still captures at most ${MAX_STILL_FRAMES} frames per invocation.`,
        { requested: value, range: segment, count, cap: MAX_STILL_FRAMES },
      );
    }

    for (let frame = start; frame <= end; frame += 1) {
      if (seen.has(frame)) {
        continue;
      }
      seen.add(frame);
      frames.push(frame);
    }
  }

  if (frames.length > MAX_STILL_FRAMES) {
    frameSpecUsage(
      `still captures at most ${MAX_STILL_FRAMES} unique frames per invocation; the requested spec expands to ${frames.length}.`,
      { requested: value, count: frames.length, cap: MAX_STILL_FRAMES },
    );
  }

  return frames;
}

interface StillOutputPlan {
  outPaths: string[];
  outDir?: string;
  createdOutDir: boolean;
}

async function resolveStillOutputs(options: {
  targetId: string;
  frames: number[];
  outValue: string | true | undefined;
  cwd: string;
}): Promise<StillOutputPlan> {
  const explicit = typeof options.outValue === "string" ? options.outValue : undefined;

  if (options.frames.length === 1) {
    const frame = options.frames[0] as number;
    const outPath = path.resolve(options.cwd, explicit ?? `still-${options.targetId}-${frame}.png`);
    return { outPaths: [outPath], createdOutDir: false };
  }

  let outDir: string;
  let createdOutDir = false;
  if (explicit === undefined) {
    outDir = options.cwd;
  } else {
    outDir = path.resolve(options.cwd, explicit);
    if (path.extname(outDir).toLowerCase() === ".png") {
      throw new FrameyardError(
        "USAGE",
        `With multiple frames, --out must be a directory, not a .png file: ${explicit}`,
      );
    }

    let existing: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      existing = await stat(outDir);
    } catch {
      existing = undefined;
    }
    if (existing?.isFile()) {
      throw new FrameyardError("USAGE", `With multiple frames, --out must be a directory: ${outDir}`);
    }
    if (existing === undefined) {
      try {
        await mkdir(outDir, { recursive: true });
      } catch (error) {
        throw new FrameyardError(
          "OUTPUT_FAILED",
          `Could not create output directory ${outDir}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      createdOutDir = true;
    }
  }

  const outPaths = options.frames.map((frame) => path.join(outDir, `still-${options.targetId}-${frame}.png`));
  return { outPaths, outDir, createdOutDir };
}

async function removeDirIfEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch {
    // Keep the directory when it is not empty or was already removed.
  }
}

function printStillResult(
  result: StillResult | TimelineStillResult,
  targetId: string,
  timeline: boolean,
  json: boolean,
): void {
  printDiagnostics(result.diagnostics);
  if (json) {
    printJson({ ok: true, command: "still", ...result });
    return;
  }

  const target = timeline ? `timeline ${targetId}` : targetId;
  for (const frame of result.frames) {
    process.stdout.write(
      `Wrote frame ${frame.frame} of ${target} to ${frame.path} (${result.width}×${result.height})\n`,
    );
  }
  if (result.frames.length > 1) {
    const directory = path.dirname(result.frames[0]?.path ?? "");
    process.stdout.write(
      `Wrote ${result.frames.length} frames of ${target} to ${directory} (${result.width}×${result.height})\n`,
    );
  }
}

async function runStill(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  const props = await readPropsFile(parsed.flags);
  const targetId = parsed.positionals[0] as string;
  const frameValue = parsed.flags.get("frame");
  if (typeof frameValue !== "string") {
    usage('"still" requires --frame <spec>.');
  }

  const frames = parseFrameSpec(frameValue);
  const outputPlan = await resolveStillOutputs({
    targetId,
    frames,
    outValue: parsed.flags.get("out"),
    cwd: process.cwd(),
  });
  const overwrite = parsed.flags.has("overwrite") === true;
  const json = parsed.flags.has("json") === true;

  try {
    if (project.timelines.has(targetId)) {
      if (props !== undefined && !isPlainObject(props)) {
        usage("Timeline --props must be a JSON object keyed by composition clip id.");
      }
      const result = await captureTimelineStills({
        project,
        timelineId: targetId,
        frames,
        outPaths: outputPlan.outPaths,
        ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
        overwrite,
        signal,
      });
      printStillResult(result, targetId, true, json);
      return 0;
    }

    const result = await captureStills({
      project,
      compositionId: targetId,
      props,
      frames,
      outPaths: outputPlan.outPaths,
      overwrite,
      signal,
    });
    printStillResult(result, targetId, false, json);
    return 0;
  } catch (error) {
    if (outputPlan.createdOutDir && outputPlan.outDir !== undefined) {
      await removeDirIfEmpty(outputPlan.outDir);
    }
    throw error;
  }
}

async function runRender(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  const props = await readPropsFile(parsed.flags);
  const encoder = encoderChoice(parsed.flags);
  const containerValue = containerChoice(parsed.flags);
  const container = containerValue ?? "mp4";
  // WebM is a VP9/Opus container; every other container defaults to H.264.
  const codecValue = codecChoice(parsed.flags);
  const codec = codecValue ?? defaultCodecForContainer(container);
  assertContainerCodec(container, codec);
  if (encoder !== undefined && encoder !== "auto") {
    // Rejects codec/vendor mismatches such as --codec hevc --encoder libx264.
    encoderNameFor(codec, encoder);
  }
  const targetId = parsed.positionals[0] as string;
  const outValue = flagString(parsed.flags, "out");
  const explicitOutPath = outValue === undefined ? undefined : path.resolve(process.cwd(), outValue);
  const timelineOutPath =
    explicitOutPath ?? path.join(project.root, "out", `${targetId}.${CONTAINER_EXTENSION[container]}`);
  const json = parsed.flags.has("json") === true;

  if (project.timelines.has(targetId)) {
    if (parsed.flags.has("concurrency")) {
      usage("--concurrency is only valid for composition renders; use --workers for timelines.");
    }
    const workersValue = flagString(parsed.flags, "workers");
    const workers = workersValue === undefined ? undefined : Number(workersValue);
    if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) {
      usage("--workers must be a positive integer.");
    }
    if (workers !== undefined && workers > MAX_TIMELINE_WORKERS) {
      usage(`--workers must be at most ${MAX_TIMELINE_WORKERS}.`);
    }
    if (props !== undefined && !isPlainObject(props)) {
      usage("Timeline --props must be a JSON object keyed by composition clip id.");
    }
    const scratchValue = flagString(parsed.flags, "scratch");
    const scratchDir = scratchValue === undefined ? undefined : path.resolve(process.cwd(), scratchValue);

    const result = await renderTimeline({
      project,
      timelineId: targetId,
      outPath: timelineOutPath,
      ...(workers !== undefined ? { workers } : {}),
      ...(scratchDir !== undefined ? { scratchDir } : {}),
      ...(encoder !== undefined ? { encoder } : {}),
      codec,
      container,
      ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
      overwrite: parsed.flags.has("overwrite") === true,
      signal,
      onProgress: progressPrinter("Rendering"),
    });

    printDiagnostics(result.diagnostics);
    if (json) {
      printJson({ ok: true, command: "render", ...result });
    } else {
      process.stdout.write(
        `Rendered timeline ${targetId} to ${result.path} (${result.framesRendered} frames, ${formatDuration(result.durationSeconds)}, ${result.audio.clips} audio clip${result.audio.clips === 1 ? "" : "s"}, ${result.workers} workers, ${result.encoder} encoder)\n`,
      );
    }
    return 0;
  }

  if (parsed.flags.has("workers") || parsed.flags.has("scratch")) {
    usage("--workers and --scratch are only valid for timeline renders.");
  }

  const compositionId = targetId;
  const concurrencyValue = parsed.flags.get("concurrency");
  const concurrency =
    typeof concurrencyValue === "string" ? validateRenderConcurrency(Number(concurrencyValue)) : undefined;

  const result = await renderComposition({
    project,
    compositionId,
    props,
    ...(explicitOutPath !== undefined ? { outPath: explicitOutPath } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(encoder !== undefined ? { encoder } : {}),
    ...(codecValue !== undefined ? { codec: codecValue } : {}),
    ...(containerValue !== undefined ? { container: containerValue } : {}),
    overwrite: parsed.flags.has("overwrite") === true,
    signal,
    onProgress: progressPrinter("Rendering"),
  });

  printDiagnostics(result.diagnostics);
  if (json) {
    printJson({ ok: true, command: "render", ...result });
  } else if (result.kind === "image") {
    process.stdout.write(
      `Rendered ${compositionId} to ${result.path} (${result.width}×${result.height}, ${result.bytes} bytes)\n`,
    );
  } else {
    process.stdout.write(
      `Rendered ${compositionId} to ${result.path} (${result.framesRendered} frames, ${formatDuration(result.durationSeconds)}, ${result.audio.clips} audio clip${result.audio.clips === 1 ? "" : "s"}, ${result.encoder} encoder)\n`,
    );
  }
  return 0;
}

async function runTts(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const projectRoot = await assetRootFromFlag(parsed.flags);
  const json = parsed.flags.has("json") === true;
  const engine = (flagString(parsed.flags, "engine") ?? "qwen") as SpeechEngine;
  const speaker = flagString(parsed.flags, "speaker");
  const outValue = flagString(parsed.flags, "out");
  if (!speaker || !outValue) {
    usage('"tts" requires --speaker and --out.');
  }

  const textFile = flagString(parsed.flags, "text-file");
  let text: string;
  if (textFile !== undefined) {
    const textPath = path.resolve(process.cwd(), textFile);
    try {
      text = await readFile(textPath, "utf8");
    } catch (error) {
      throw new FrameyardError("ASSET_NOT_FOUND", `Could not read text file ${textPath}.`, { cause: error });
    }
  } else {
    if (process.stdin.isTTY) {
      usage("Provide --text-file or pipe text to stdin.");
    }
    text = await readStdin();
  }

  const result =
    engine === "supertonic"
      ? await synthesizeSpeech({
          engine: "supertonic",
          projectRoot,
          text,
          speaker,
          modelDir: path.resolve(process.cwd(), flagString(parsed.flags, "model-dir") as string),
          language: flagString(parsed.flags, "language") as string,
          outPath: path.resolve(process.cwd(), outValue),
          ...(flagString(parsed.flags, "executable") !== undefined
            ? { executable: flagString(parsed.flags, "executable") as string }
            : {}),
          ...(flagString(parsed.flags, "manifest") !== undefined
            ? { manifestPath: flagString(parsed.flags, "manifest") as string }
            : {}),
          force: parsed.flags.has("force") === true,
          signal,
        })
      : await synthesizeSpeech({
          engine: "qwen",
          projectRoot,
          text,
          speaker,
          talkerModelPath: path.resolve(process.cwd(), flagString(parsed.flags, "talker-model") as string),
          codecModelPath: path.resolve(process.cwd(), flagString(parsed.flags, "codec-model") as string),
          outPath: path.resolve(process.cwd(), outValue),
          ...(flagString(parsed.flags, "style") !== undefined
            ? { style: flagString(parsed.flags, "style") as string }
            : {}),
          ...(flagString(parsed.flags, "language") !== undefined
            ? { language: flagString(parsed.flags, "language") as string }
            : {}),
          ...(flagString(parsed.flags, "device") !== undefined
            ? { device: flagString(parsed.flags, "device") as string }
            : {}),
          ...(flagString(parsed.flags, "executable") !== undefined
            ? { executable: flagString(parsed.flags, "executable") as string }
            : {}),
          ...(flagString(parsed.flags, "manifest") !== undefined
            ? { manifestPath: flagString(parsed.flags, "manifest") as string }
            : {}),
          force: parsed.flags.has("force") === true,
          signal,
        });

  if (json) {
    printJson({ ok: true, command: "tts", ...result });
  } else {
    process.stdout.write(
      `Wrote 24 kHz mono WAV to ${result.path} (${(result.bytes / (1024 * 1024)).toFixed(2)} MB, ${result.engine})\n`,
    );
    process.stdout.write(`Updated provenance manifest ${result.manifest}\n`);
  }
  return 0;
}

async function runTranscribe(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const projectRoot = await assetRootFromFlag(parsed.flags);
  const json = parsed.flags.has("json") === true;
  const outValue = flagString(parsed.flags, "out");
  const modelValue = flagString(parsed.flags, "model");
  if (!outValue || !modelValue) {
    usage('"transcribe" requires --out and --model.');
  }

  const result = await transcribeAudio({
    projectRoot,
    sourcePath: path.resolve(process.cwd(), parsed.positionals[0] as string),
    outPath: path.resolve(process.cwd(), outValue),
    modelPath: path.resolve(process.cwd(), modelValue),
    words: parsed.flags.has("words") === true,
    exports: parseSubtitleFormats(parsed.flags.get("export")),
    ...(flagString(parsed.flags, "language") !== undefined
      ? { language: flagString(parsed.flags, "language") as string }
      : {}),
    ...(flagString(parsed.flags, "executable") !== undefined
      ? { executable: flagString(parsed.flags, "executable") as string }
      : {}),
    ...(flagString(parsed.flags, "manifest") !== undefined
      ? { manifestPath: flagString(parsed.flags, "manifest") as string }
      : {}),
    force: parsed.flags.has("force") === true,
    signal,
  });

  if (json) {
    printJson({ ok: true, command: "transcribe", ...result });
  } else {
    process.stdout.write(
      `Transcribed ${result.source.path} -> ${result.path} (${result.segments} segment${result.segments === 1 ? "" : "s"}, ${result.words} word${result.words === 1 ? "" : "s"}${result.language === undefined ? "" : `, ${result.language}`})\n`,
    );
    for (const exported of result.exports) {
      process.stdout.write(`  ${exported.format}: ${exported.path}\n`);
    }
    process.stdout.write(`Updated provenance manifest ${result.manifest}\n`);
  }
  return 0;
}

async function runDoctorCommand(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const projectRoot = await assetRootFromFlag(parsed.flags);
  const manifestPath = resolveManifestPath(projectRoot, flagString(parsed.flags, "manifest"));
  const json = parsed.flags.has("json") === true;
  const result = await runDoctor({
    projectRoot,
    manifestPath,
    ...(flagString(parsed.flags, "qwen-tts") !== undefined
      ? { qwenTts: flagString(parsed.flags, "qwen-tts") as string }
      : {}),
    ...(flagString(parsed.flags, "sherpa-onnx-tts") !== undefined
      ? { sherpaOnnxTts: flagString(parsed.flags, "sherpa-onnx-tts") as string }
      : {}),
    ...(flagString(parsed.flags, "whisper-cli") !== undefined
      ? { whisperCli: flagString(parsed.flags, "whisper-cli") as string }
      : {}),
    ...(flagString(parsed.flags, "talker-model") !== undefined
      ? { talkerModel: flagString(parsed.flags, "talker-model") as string }
      : {}),
    ...(flagString(parsed.flags, "codec-model") !== undefined
      ? { codecModel: flagString(parsed.flags, "codec-model") as string }
      : {}),
    ...(flagString(parsed.flags, "model-dir") !== undefined
      ? { supertonicModelDir: flagString(parsed.flags, "model-dir") as string }
      : {}),
    ...(flagString(parsed.flags, "model") !== undefined
      ? { whisperModel: flagString(parsed.flags, "model") as string }
      : {}),
    signal,
  });

  if (json) {
    printJson({ ok: true, command: "doctor", ...result });
  } else {
    for (const check of result.checks) {
      const mark = check.status === "ok" ? "✓" : "✗";
      const suffix = check.required ? "" : " (optional)";
      process.stdout.write(`${mark} ${check.name}${suffix}: ${check.detail}\n`);
    }
    for (const integration of [
      result.integrations.tts,
      result.integrations.transcribe,
      result.integrations.sherpaOnnxTts,
    ]) {
      const mark =
        integration.status === "ok" ? "✓" : integration.status === "missing" && !integration.requested ? "○" : "✗";
      const detail = integration.detail ? ` — ${integration.detail}` : "";
      const version = integration.version ? ` ${integration.version}` : "";
      process.stdout.write(
        `${mark} ${integration.name}: ${integration.status}${integration.executable ? ` (${integration.executable})` : ""}${version}${detail}\n`,
      );
    }
    for (const model of result.models) {
      const mark = model.status === "ok" ? "✓" : "✗";
      const detail = model.detail ? ` — ${model.detail}` : "";
      process.stdout.write(`${mark} model ${model.role}: ${model.path}${detail}\n`);
    }
    process.stdout.write(`\ndoctor: ${result.healthy ? "healthy" : "problems found"}\n`);
  }
  return result.healthy ? 0 : 1;
}

function reportFailure(error: unknown, command: string, jsonRequested: boolean, signal?: AbortSignal): number {
  const aborted = signal?.aborted === true;
  const code = aborted ? "CANCELLED" : isFrameyardError(error) ? error.code : "INTERNAL";
  const message = aborted ? "Operation cancelled." : error instanceof Error ? error.message : String(error);

  const details = isFrameyardError(error) ? error.details : undefined;
  const diagnostics = isFrameyardError(error) ? error.diagnostics : undefined;
  if (jsonRequested) {
    printJson({
      ok: false,
      command: command || null,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    });
  }
  process.stderr.write(`${aborted ? "Cancelled" : `error [${code}]`}${aborted ? "" : `: ${message}`}\n`);
  if (diagnostics !== undefined) {
    printDiagnostics(diagnostics);
  }

  if (!aborted && !isFrameyardError(error) && process.env.FRAMEYARD_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ""}\n`);
  }

  if (aborted) {
    return 130;
  }
  return code === "USAGE" ? 2 : 1;
}

async function main(argv: string[]): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return reportFailure(error, inferCommand(argv), jsonRequested);
  }
  try {
    validateArgs(parsed);
  } catch (error) {
    return reportFailure(error, parsed.command, jsonRequested);
  }

  if (parsed.flags.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command === "help") {
    printHelp();
    return 0;
  }
  if (parsed.flags.has("help")) {
    printCommandHelp(parsed.command);
    return 0;
  }
  if (!parsed.command) {
    printHelp();
    return 0;
  }

  if (parsed.command === "init") {
    try {
      return await runInit(parsed);
    } catch (error) {
      return reportFailure(error, "init", parsed.flags.has("json") === true);
    }
  }

  if (parsed.command === "dev") {
    try {
      return await runDev(parsed);
    } catch (error) {
      return reportFailure(error, "dev", false);
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write("\nCancelling...\n");
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  try {
    switch (parsed.command) {
      case "check":
        return await runCheck(parsed, controller.signal);
      case "still":
        return await runStill(parsed, controller.signal);
      case "render":
        return await runRender(parsed, controller.signal);
      case "tts":
        return await runTts(parsed, controller.signal);
      case "transcribe":
        return await runTranscribe(parsed, controller.signal);
      case "doctor":
        return await runDoctorCommand(parsed, controller.signal);
      default:
        usage(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    return reportFailure(error, parsed.command, parsed.flags.has("json") === true, controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
