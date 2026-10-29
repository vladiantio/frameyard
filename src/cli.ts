#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FrameyardError, isFrameyardError } from "./errors.js";
import { loadProject, resolveProjectRoot, type Project } from "./project.js";
import { checkComposition, captureStill, renderComposition, type ProgressEvent } from "./renderer/index.js";
import { startPreviewServer } from "./server/server.js";
import { VERSION } from "./version.js";
import { transcribeAudio, type SubtitleFormat } from "./assets/transcribe.js";
import { synthesizeSpeech } from "./assets/tts.js";
import { resolveManifestPath } from "./assets/provenance.js";
import { runDoctor } from "./doctor.js";

const COMMANDS = new Set(["init", "dev", "check", "still", "render", "tts", "transcribe", "doctor", "help"]);
const VALUE_FLAGS = new Set([
  "project",
  "props",
  "out",
  "frame",
  "port",
  "text-file",
  "speaker",
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
  "whisper-cli",
]);
const BOOLEAN_FLAGS = new Set(["json", "overwrite", "force", "words", "help", "version"]);


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
      return new Set([...common, "props", "out", "overwrite"]);
    case "tts":
      return new Set([
        ...common,
        "text-file",
        "speaker",
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
      return new Set([
        ...common,
        "out",
        "model",
        "words",
        "export",
        "language",
        "executable",
        "manifest",
        "force",
      ]);
    case "doctor":
      return new Set([...common, "manifest", "qwen-tts", "whisper-cli", "talker-model", "codec-model", "model"]);
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
    usage(`"${parsed.command}" requires a ${parsed.command === "transcribe" ? "source path" : "composition id"}.`);
  }

  if (parsed.command === "still" && !parsed.flags.has("frame")) {
    usage('"still" requires --frame <n>.');
  }
  if (parsed.command === "render" && !parsed.flags.has("out")) {
    usage('"render" requires --out <video.mp4>.');
  }
  if (parsed.command === "tts") {
    for (const required of ["speaker", "talker-model", "codec-model", "out"]) {
      if (!parsed.flags.has(required)) {
        usage(`"tts" requires --${required}.`);
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
  frameyard still <composition-id> --frame <n> [--out <file.png>] [--props <file>] [--project <dir>] [--json]
  frameyard render <composition-id> --out <video.mp4> [--props <file>] [--project <dir>] [--overwrite] [--json]
  frameyard tts --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--json]
  frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--json]
  frameyard doctor [--qwen-tts <path>] [--whisper-cli <path>] [--talker-model <gguf>] [--codec-model <gguf>] [--model <gguf>] [--manifest <file>] [--project <dir>] [--json]

Options:
  --project <dir>        Use a project other than the current directory.
  --props <file>         JSON props merged over composition defaults.
  --out <file>           Output path for still, render, tts, or transcribe.
  --frame <n>            Frame to capture for still.
  --overwrite            Replace an existing still or render output.
  --force                Replace existing generated assets and manifest entries.
  --text-file <file>     Text to synthesize. Reads stdin when omitted.
  --speaker <name>       Named speaker for CustomVoice speech synthesis.
  --talker-model <gguf>  Talker GGUF model path.
  --codec-model <gguf>   Codec GGUF model path.
  --style <text>         Optional style instruction for speech synthesis.
  --language <lang>      Spoken language, when known.
  --device <name>        Compute device for qwen-tts, such as CPU or CUDA0.
  --model <gguf>         Whisper GGML model path.
  --words                Request measured word timings during transcription.
  --export srt,vtt       Derived subtitle exports next to the transcript.
  --executable <path>    Explicit qwen-tts or whisper-cli executable.
  --manifest <file>      Provenance manifest path (default: frameyard.assets.json).
  --qwen-tts <path>      qwen-tts executable to inspect with doctor.
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
      process.stdout.write("Usage: frameyard dev [--port <port>] [--project <dir>]\nStart the browser preview server.\n");
      return;
    case "check":
      process.stdout.write(
        "Usage: frameyard check <composition-id> [--props <file>] [--project <dir>] [--json]\nValidate props, assets, audio, and every frame without encoding.\n",
      );
      return;
    case "still":
      process.stdout.write(
        "Usage: frameyard still <composition-id> --frame <n> [--out <file.png>] [--props <file>] [--project <dir>] [--json]\nCapture one frame through the production rendering path.\n",
      );
      return;
    case "render":
      process.stdout.write(
        "Usage: frameyard render <composition-id> --out <video.mp4> [--props <file>] [--project <dir>] [--overwrite] [--json]\nRender a complete MP4 with H.264 video and AAC audio.\n",
      );
      return;
    case "tts":
      process.stdout.write(
        "Usage: frameyard tts --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--json]\nProduce one frozen 24 kHz mono WAV with local qwentts.cpp CustomVoice synthesis.\n",
      );
      return;
    case "transcribe":
      process.stdout.write(
        "Usage: frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--json]\nProduce a canonical Frameyard transcript, optionally with word timings and subtitle exports.\n",
      );
      return;
    case "doctor":
      process.stdout.write(
        "Usage: frameyard doctor [--qwen-tts <path>] [--whisper-cli <path>] [--talker-model <gguf>] [--codec-model <gguf>] [--model <gguf>] [--manifest <file>] [--project <dir>] [--json]\nInspect core requirements, optional integrations, model readability, and provenance integrity without changing the environment.\n",
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

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInit(parsed: ParsedArgs): Promise<number> {
  const target = path.resolve(process.cwd(), parsed.positionals[0] ?? ".");
  const json = parsed.flags.has("json") === true;

  const files: Record<string, string> = {
    "video.config.js": `export default {\n  compositions: {\n    hello: "./compositions/hello.js",\n  },\n};\n`,
    "props/hello.json": `${JSON.stringify({ title: "Hello, Frameyard", accent: "#b8f36b" }, null, 2)}\n`,
    "README.md": `# My Frameyard project

Start the preview:

\`\`\`sh
npx frameyard dev
\`\`\`

Validate and render:

\`\`\`sh
npx frameyard doctor
npx frameyard check hello
npx frameyard render hello --props props/hello.json --out hello.mp4
\`\`\`
`,
    "compositions/hello.js": `import { defineComposition } from "frameyard";

let title;
let sweep;
let glow;

export default defineComposition({
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 150,
  defaultProps: { title: "Hello, Frameyard", accent: "#b8f36b" },
  validateProps(props) {
    const errors = [];
    if (typeof props.title !== "string") errors.push("title must be a string");
    if (typeof props.accent !== "string") errors.push("accent must be a string");
    return errors;
  },
  mount({ container, props }) {
    container.style.setProperty("--accent", props.accent);
    container.innerHTML =
      '<style>' +
      '#hello { position: relative; width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden; background: #0b0d10; color: #e8edf3; font-family: Inter, system-ui, sans-serif; }' +
      '#hello h1 { position: relative; margin: 0; font-size: 96px; letter-spacing: -0.04em; }' +
      '#hello p { position: relative; margin: 18px 0 0; color: #8a97a6; font-size: 26px; }' +
      '#glow { position: absolute; width: 520px; height: 520px; border-radius: 50%; background: var(--accent); filter: blur(120px); opacity: 0.16; }' +
      '#sweep { position: absolute; left: 0; bottom: 0; width: 0%; height: 4px; background: var(--accent); }' +
      '</style>' +
      '<div id="hello"><div id="glow"></div><div style="position: relative; text-align: center"><h1 id="title"></h1><p>Deterministic video, authored on the web.</p></div><div id="sweep"></div></div>';
    title = container.querySelector("#title");
    sweep = container.querySelector("#sweep");
    glow = container.querySelector("#glow");
  },
  update({ frame, props }) {
    title.textContent = props.title;
    const intro = Math.min(1, frame / 24);
    title.style.opacity = String(intro);
    title.style.transform = "translateY(" + (1 - intro) * 28 + "px)";
    glow.style.transform =
      "translate(" + Math.sin(frame / 26) * 120 + "px," + Math.cos(frame / 34) * 80 + "px)";
    sweep.style.width = (frame / 149) * 100 + "%";
  },
  dispose() {
    title = undefined;
    sweep = undefined;
    glow = undefined;
  },
});
`,
  };

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
    next: [
      "npx frameyard doctor",
      "npx frameyard dev",
      "npx frameyard check hello",
      "npx frameyard render hello --out hello.mp4",
    ],
  };

  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`Created Frameyard project at ${target}\n`);
    for (const file of Object.keys(files)) {
      process.stdout.write(`  ${file}\n`);
    }
    process.stdout.write("Next: npx frameyard doctor && npx frameyard dev\n");
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
  const compositionId = parsed.positionals[0] as string;
  const json = parsed.flags.has("json") === true;

  const result = await checkComposition({
    project,
    compositionId,
    props,
    signal,
    onProgress: progressPrinter("Checking"),
  });

  if (json) {
    printJson({ ok: true, command: "check", ...result });
  } else {
    const meta = result.metadata;
    process.stdout.write(
      `✓ ${compositionId}: ${result.framesChecked} frames, ${meta.width}×${meta.height} @ ${meta.fps} fps (${formatDuration(meta.durationInFrames / meta.fps)})\n`,
    );
    process.stdout.write(
      `  audio: ${result.audio.clips} clip${result.audio.clips === 1 ? "" : "s"}, ${result.audio.warnings.length} warning${result.audio.warnings.length === 1 ? "" : "s"}\n`,
    );
    for (const clip of result.audio.details) {
      process.stdout.write(
        `    ${clip.src}: ${clip.startSeconds.toFixed(2)}s–${clip.endSeconds.toFixed(2)}s (source ${clip.sourceDurationSeconds.toFixed(2)}s, volume ${clip.volume})\n`,
      );
    }
    if (result.transcripts.clips > 0) {
      process.stdout.write(
        `  transcripts: ${result.transcripts.clips} asset${result.transcripts.clips === 1 ? "" : "s"}, ${result.transcripts.warnings.length} warning${result.transcripts.warnings.length === 1 ? "" : "s"}\n`,
      );
      for (const transcript of result.transcripts.details) {
        process.stdout.write(
          `    ${transcript.src}: ${transcript.segments} segment${transcript.segments === 1 ? "" : "s"}${transcript.words === undefined ? "" : `, ${transcript.words} word${transcript.words === 1 ? "" : "s"}`}${transcript.language === undefined ? "" : `, ${transcript.language}`}, ${formatDuration(transcript.durationMs / 1000)}\n`,
        );
      }
    }
  }
  printWarnings(result.audio.warnings);
  printWarnings(result.transcripts.warnings);
  return 0;
}

async function runStill(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  const props = await readPropsFile(parsed.flags);
  const compositionId = parsed.positionals[0] as string;
  const frame = Number(parsed.flags.get("frame"));
  if (!Number.isInteger(frame) || frame < 0) {
    usage("--frame must be a non-negative integer.");
  }

  const outValue = parsed.flags.get("out");
  const outPath = path.resolve(
    process.cwd(),
    typeof outValue === "string" ? outValue : `still-${compositionId}-${frame}.png`,
  );
  const json = parsed.flags.has("json") === true;

  const result = await captureStill({
    project,
    compositionId,
    props,
    frame,
    outPath,
    overwrite: parsed.flags.has("overwrite") === true,
    signal,
  });

  if (json) {
    printJson({ ok: true, command: "still", ...result });
  } else {
    process.stdout.write(
      `Wrote frame ${result.frame} of ${compositionId} to ${result.path} (${result.width}×${result.height})\n`,
    );
  }
  return 0;
}

async function runRender(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  const props = await readPropsFile(parsed.flags);
  const compositionId = parsed.positionals[0] as string;
  const outValue = parsed.flags.get("out");
  if (typeof outValue !== "string") {
    usage("--out requires a file path.");
  }
  const outPath = path.resolve(process.cwd(), outValue);
  const json = parsed.flags.has("json") === true;

  const result = await renderComposition({
    project,
    compositionId,
    props,
    outPath,
    overwrite: parsed.flags.has("overwrite") === true,
    signal,
    onProgress: progressPrinter("Rendering"),
  });

  printWarnings(result.audio.warnings);
  printWarnings(result.transcripts.warnings);
  if (json) {
    printJson({ ok: true, command: "render", ...result });
  } else {
    process.stdout.write(
      `Rendered ${compositionId} to ${result.path} (${result.framesRendered} frames, ${formatDuration(result.durationSeconds)}, ${result.audio.clips} audio clip${result.audio.clips === 1 ? "" : "s"})\n`,
    );
  }
  return 0;
}

async function runTts(parsed: ParsedArgs, signal: AbortSignal): Promise<number> {
  const projectRoot = await assetRootFromFlag(parsed.flags);
  const json = parsed.flags.has("json") === true;
  const speaker = flagString(parsed.flags, "speaker");
  const talkerModel = flagString(parsed.flags, "talker-model");
  const codecModel = flagString(parsed.flags, "codec-model");
  const outValue = flagString(parsed.flags, "out");
  if (!speaker || !talkerModel || !codecModel || !outValue) {
    usage('"tts" requires --speaker, --talker-model, --codec-model, and --out.');
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

  const result = await synthesizeSpeech({
    projectRoot,
    text,
    speaker,
    talkerModelPath: path.resolve(process.cwd(), talkerModel),
    codecModelPath: path.resolve(process.cwd(), codecModel),
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
      `Wrote 24 kHz mono WAV to ${result.path} (${(result.bytes / (1024 * 1024)).toFixed(2)} MB)\n`,
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
    ...(flagString(parsed.flags, "whisper-cli") !== undefined
      ? { whisperCli: flagString(parsed.flags, "whisper-cli") as string }
      : {}),
    ...(flagString(parsed.flags, "talker-model") !== undefined
      ? { talkerModel: flagString(parsed.flags, "talker-model") as string }
      : {}),
    ...(flagString(parsed.flags, "codec-model") !== undefined
      ? { codecModel: flagString(parsed.flags, "codec-model") as string }
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
    for (const integration of [result.integrations.tts, result.integrations.transcribe]) {
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
  const message = aborted
    ? "Operation cancelled."
    : error instanceof Error
      ? error.message
      : String(error);

  if (jsonRequested) {
    printJson({ ok: false, command: command || null, error: { code, message } });
  }
  process.stderr.write(`${aborted ? "Cancelled" : `error [${code}]`}${aborted ? "" : `: ${message}`}\n`);

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
