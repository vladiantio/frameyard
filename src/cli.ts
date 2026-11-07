#!/usr/bin/env node
import { access, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isPlainObject } from "./contracts.js";
import { diagnosticFix } from "./diagnostic-fixes.js";
import { FrameyardError, errorMessage, isFrameyardError, type FrameyardDiagnostic } from "./errors.js";
import { explainDiagnosticCode, listDiagnosticExplanations } from "./explain.js";
import { loadProject, resolveProjectRoot, type Project } from "./project.js";
import {
  assertOperationAllowed,
  assertOverwriteAllowed,
  assertPolicyTier,
  assertProfileLimit,
  assertStillFrameLimit,
  describePolicy,
  loadResourcePolicy,
  lowerProcessPriority,
  MAX_STILL_FRAMES,
  policyDetails,
  resolveProfile,
  SHARED_CPU_MAX_CONCURRENCY,
  SHARED_CPU_MAX_WORKERS,
  shouldLowerPriority,
  type LoadedResourcePolicy,
} from "./policy.js";
import { lintComposition, lintResolvedTimeline, lintTimeline } from "./lint.js";
import { buildProjectContext } from "./context.js";
import { analyzeRgba, compareRgba, decodeRgba, probeImage } from "./inspect.js";
import { findTemplate, listTemplates, templateRegistration, type TemplateKind } from "./templates.js";
import { findRecipe, listRecipes, recipeInstallPlan, recipeRegistration } from "./recipes.js";
import { planTimelineRender } from "./timeline/plan.js";
import { resolveProjectTimeline, type ResolvedTimeline } from "./timeline/resolve.js";
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
import { validateRenderScale } from "./renderer/scale.js";
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
import { localModelScaffoldFiles, scaffoldFiles, SCAFFOLD_NEXT } from "./scaffold.js";
import { VERSION } from "./version.js";
import { transcribeAudio, type SubtitleFormat } from "./assets/transcribe.js";
import { synthesizeSpeech, type SpeechEngine } from "./assets/tts.js";
import {
  isSupertonicLanguage,
  parseSupertonicSpeaker,
  resolveSupertonicModelFiles,
  SUPERTONIC_LANGUAGES,
} from "./assets/tts-supertonic.js";
import { resolveManifestPath } from "./assets/provenance.js";
import { runDoctor } from "./doctor.js";
import { addLocalFont, removeFont } from "./fonts/add.js";
import { addFontsource, addUrlFont, searchFontsource } from "./fonts/fontsource.js";
import { fontManifestPath, readFontManifest } from "./fonts/manifest.js";
import { parseFontStyle, parseFontWeight } from "./fonts/options.js";
import { summarizeFont } from "./fonts/summary.js";
import { assertFontIntegrity, fontStatuses, verifyFontManifest } from "./fonts/verify.js";
import { emptyFontManifest } from "./fonts/types.js";
import type { FontManifest } from "./fonts/types.js";
import type { FontSummary } from "./fonts/summary.js";

const COMMANDS = new Set([
  "init",
  "dev",
  "context",
  "lint",
  "check",
  "still",
  "inspect",
  "compare",
  "render",
  "tts",
  "transcribe",
  "add",
  "font",
  "doctor",
  "explain",
  "help",
]);
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
  "frames",
  "scale",
  "sequence",
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
  "profile",
  "template",
  "file",
  "family",
  "id",
  "weight",
  "subset",
  "unicode-range",
  "license",
  "license-file",
  "category",
  "limit",
  "url",
  "sha256",
]);
const BOOLEAN_FLAGS = new Set([
  "json",
  "overwrite",
  "force",
  "words",
  "dry-run",
  "low-priority",
  "list",
  "local-models",
  "keep-files",
  "static",
  "variable",
  "help",
  "version",
]);

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
  const resource = ["profile", "low-priority"];
  switch (command) {
    case "init":
      return new Set(["json", "local-models", "help"]);
    case "dev":
      return new Set(["project", "port", "help"]);
    case "context":
      return new Set(common);
    case "lint":
      return new Set([...common, "props"]);
    case "inspect":
      return new Set(["json", "help"]);
    case "compare":
      return new Set(["json", "help"]);
    case "add":
      return new Set([...common, "template", "list", "id"]);
    case "font":
      return new Set([
        ...common,
        "file",
        "family",
        "id",
        "weight",
        "style",
        "subset",
        "unicode-range",
        "license",
        "license-file",
        "category",
        "limit",
        "url",
        "sha256",
        "static",
        "variable",
        "force",
        "keep-files",
      ]);
    case "check":
      return new Set([...common, "props", ...resource]);
    case "still":
      return new Set([...common, "props", "out", "frame", "overwrite", ...resource]);
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
        "frames",
        "scale",
        "sequence",
        "dry-run",
        ...resource,
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
        "dry-run",
        ...resource,
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
        "dry-run",
        ...resource,
      ]);
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
    case "explain":
      return new Set(["json", "help", "list"]);
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

  if (["dev", "help", "doctor", "tts", "context"].includes(parsed.command)) {
    if (parsed.positionals.length > 0) {
      usage(`"${parsed.command}" does not take a positional argument.`);
    }
  } else if (parsed.command === "init") {
    if (parsed.positionals.length > 1) {
      usage(`"${parsed.command}" accepts at most 1 positional argument.`);
    }
  } else if (parsed.command === "inspect") {
    if (parsed.positionals.length !== 1) {
      usage('"inspect" requires an image path.');
    }
  } else if (parsed.command === "compare") {
    if (parsed.positionals.length !== 2) {
      usage('"compare" requires two image paths.');
    }
  } else if (parsed.command === "add") {
    if (parsed.flags.has("list")) {
      if (parsed.positionals.length > 0) {
        usage('"add --list" does not take positional arguments.');
      }
      if (parsed.flags.has("template")) {
        usage("--template is only valid when adding an entry.");
      }
    } else if (parsed.positionals[0] === "local-models") {
      if (parsed.positionals.length !== 1) {
        usage('"add local-models" does not take an id.');
      }
      if (parsed.flags.has("template")) {
        usage('--template is not valid for "add local-models".');
      }
    } else if (parsed.positionals[0] === "recipe") {
      if (parsed.positionals.length !== 2) {
        usage('"add recipe" requires <recipe-id> and --id <project-id>.');
      }
      if (parsed.flags.has("template")) {
        usage('--template is not valid for "add recipe".');
      }
      const recipeId = parsed.positionals[1] as string;
      if (findRecipe(recipeId) === undefined) {
        usage(
          `Unknown recipe "${recipeId}". Available: ${listRecipes()
            .map((entry) => entry.id)
            .join(", ")}.`,
        );
      }
      const projectId = parsed.flags.get("id");
      if (typeof projectId !== "string") {
        usage('"add recipe" requires --id <project-id>.');
      }
    } else {
      if (parsed.positionals.length !== 2) {
        usage(
          '"add" requires <composition|timeline> <id> and --template <name>, "add recipe" <recipe-id> --id <project-id>, or "add local-models".',
        );
      }
      const kind = parsed.positionals[0];
      if (kind !== "composition" && kind !== "timeline") {
        usage('"add" kind must be "composition", "timeline", "recipe", or "local-models".');
      }
      if (parsed.flags.has("id")) {
        usage('--id is only valid for "add recipe".');
      }
      const templateName = parsed.flags.get("template");
      if (typeof templateName !== "string") {
        usage('"add" requires --template <name>.');
      }
      const template = findTemplate(templateName);
      if (!template) {
        usage(
          `Unknown template "${templateName}". Available: ${listTemplates()
            .map((entry) => entry.name)
            .join(", ")}.`,
        );
      }
      if (template.kind !== kind) {
        usage(`Template "${templateName}" is a ${template.kind} template, not ${kind}.`);
      }
    }
  } else if (parsed.command === "explain") {
    if (parsed.flags.has("list")) {
      if (parsed.positionals.length > 0) {
        usage('"explain --list" does not take a code.');
      }
    } else if (parsed.positionals.length !== 1) {
      usage('"explain" requires <code> or --list.');
    }
  } else if (parsed.command === "font") {
    const action = parsed.positionals[0];
    if (action === "search") {
      if (parsed.positionals.length > 2) {
        usage('"font search" accepts at most one query.');
      }
      const query = parsed.positionals[1] ?? "";
      const hasFilter =
        parsed.flags.has("category") ||
        parsed.flags.has("subset") ||
        parsed.flags.has("style") ||
        parsed.flags.has("variable");
      if (query.length === 0 && !hasFilter) {
        usage('"font search" requires a query or a --category, --subset, --style, or --variable filter.');
      }
      for (const flag of [
        "file",
        "family",
        "id",
        "weight",
        "url",
        "license",
        "license-file",
        "sha256",
        "force",
        "keep-files",
        "static",
      ]) {
        if (parsed.flags.has(flag)) {
          usage(`--${flag} is not valid for "font search".`);
        }
      }
      const limit = parsed.flags.get("limit");
      if (
        limit !== undefined &&
        (typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
      ) {
        usage("--limit must be an integer between 1 and 100.");
      }
    } else if (action === "add") {
      const file = typeof parsed.flags.get("file") === "string";
      const url = typeof parsed.flags.get("url") === "string";
      if (file && url) {
        usage('"font add" accepts only one source: --file, --url, or a Fontsource id.');
      }
      if (parsed.flags.has("category") || parsed.flags.has("limit") || parsed.flags.has("variable")) {
        usage('--category, --limit, and --variable are only valid for "font search".');
      }
      if (parsed.flags.has("keep-files")) {
        usage('--keep-files is only valid for "font remove".');
      }
      if (parsed.flags.has("static") && file) {
        usage("--static is only valid for a Fontsource id.");
      }
      if (parsed.flags.has("static") && url) {
        usage("--static is only valid for a Fontsource id.");
      }
      if (file) {
        if (parsed.positionals.length !== 1) {
          usage('"font add --file" does not take an id; use --id to override the derived font id.');
        }
        if (typeof parsed.flags.get("family") !== "string") {
          usage('"font add --file" requires --family <name>.');
        }
        if (parsed.flags.has("sha256")) {
          usage("--sha256 is only valid with --url.");
        }
      } else if (url) {
        if (parsed.positionals.length !== 1) {
          usage('"font add --url" does not take an id; use --id to override the derived font id.');
        }
        if (typeof parsed.flags.get("family") !== "string") {
          usage('"font add --url" requires --family <name>.');
        }
      } else {
        if (parsed.positionals.length !== 2) {
          usage('"font add" requires a Fontsource id, or --file/--url with --family.');
        }
        if (parsed.flags.has("id")) {
          usage("The Fontsource id is positional; --id is only valid with --file or --url.");
        }
        if (parsed.flags.has("license") || parsed.flags.has("license-file")) {
          usage("Fontsource supplies the license; --license/--license-file are only valid with --file or --url.");
        }
        if (parsed.flags.has("sha256")) {
          usage("--sha256 is only valid with --url.");
        }
        if (parsed.flags.has("unicode-range")) {
          usage("--unicode-range is only valid with --file or --url.");
        }
      }
    } else if (action === "list" || action === "verify") {
      if (parsed.positionals.length !== 1) {
        usage(`"font ${action}" does not take positional arguments.`);
      }
      for (const flag of [
        "file",
        "family",
        "id",
        "weight",
        "style",
        "subset",
        "unicode-range",
        "license",
        "license-file",
        "category",
        "limit",
        "url",
        "sha256",
        "static",
        "variable",
        "force",
        "keep-files",
      ]) {
        if (parsed.flags.has(flag)) {
          usage(`--${flag} is not valid for "font ${action}".`);
        }
      }
    } else if (action === "remove") {
      if (parsed.positionals.length !== 2) {
        usage('"font remove" requires a font id.');
      }
      for (const flag of [
        "file",
        "family",
        "id",
        "weight",
        "style",
        "subset",
        "unicode-range",
        "license",
        "license-file",
        "category",
        "limit",
        "url",
        "sha256",
        "static",
        "variable",
        "force",
      ]) {
        if (parsed.flags.has(flag)) {
          usage(`--${flag} is not valid for "font remove".`);
        }
      }
    } else {
      usage('"font" requires one of: search, add, list, verify, remove.');
    }
  } else if (parsed.positionals.length !== 1) {
    usage(
      `"${parsed.command}" requires a ${
        parsed.command === "transcribe"
          ? "source path"
          : parsed.command === "render" || parsed.command === "lint"
            ? "composition or timeline id"
            : "composition id"
      }.`,
    );
  }

  const profile = parsed.flags.get("profile");
  if (profile !== undefined && profile !== "shared-cpu") {
    usage('--profile must be "shared-cpu".');
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
  frameyard init [directory] [--local-models]
  frameyard dev [--port <port>] [--project <dir>]
  frameyard context [--project <dir>] [--json]
  frameyard lint <composition-or-timeline-id> [--props <file>] [--project <dir>] [--json]
  frameyard check <composition-id> [--props <file>] [--project <dir>] [--profile <name>] [--low-priority] [--json]
  frameyard still <composition-or-timeline-id> --frame <spec> [--out <file-or-dir>] [--props <file>] [--project <dir>] [--profile <name>] [--low-priority] [--json]
  frameyard inspect <image> [--json]
  frameyard compare <first-image> <second-image> [--json]
  frameyard render <composition-or-timeline-id> [--out <file>] [--frames <spec>] [--scale <factor>] [--sequence <dir>] [--props <file>] [--project <dir>] [--concurrency <n>] [--workers <n>] [--encoder <name>] [--codec <name>] [--container <name>] [--scratch <dir>] [--overwrite] [--dry-run] [--profile <name>] [--low-priority] [--json]
  frameyard tts [--engine qwen] --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]
  frameyard tts --engine supertonic --speaker <sid> --model-dir <dir> --language <code> --out <file.wav> [--text-file <file>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]
  frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]
  frameyard add --list [--json]
  frameyard add local-models [--project <dir>] [--json]
  frameyard add <composition|timeline> <id> --template <name> [--project <dir>] [--json]
  frameyard add recipe <recipe-id> --id <project-id> [--project <dir>] [--json]
  frameyard explain <code> [--json]
  frameyard explain --list [--json]
  frameyard font search [query] [--category <category>] [--subset <subset>] [--style <normal|italic>] [--variable] [--limit <n>] [--json]
  frameyard font add <fontsource-id> [--family <alias>] [--subset <subset>] [--style <normal|italic>] [--weight <n>] [--static] [--force] [--project <dir>] [--json]
  frameyard font add --file <path> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--subset <name>] [--license <id>] [--license-file <path>] [--force] [--project <dir>] [--json]
  frameyard font add --url <https-url> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--license <id>] [--license-file <path>] [--sha256 <hash>] [--force] [--project <dir>] [--json]
  frameyard font list|verify [--project <dir>] [--json]
  frameyard font remove <id> [--keep-files] [--project <dir>] [--json]
  frameyard doctor [--qwen-tts <path>] [--sherpa-onnx-tts <path>] [--whisper-cli <path>] [--talker-model <gguf>] [--codec-model <gguf>] [--model-dir <dir>] [--model <gguf>] [--manifest <file>] [--project <dir>] [--json]

Options:
  --project <dir>        Use a project other than the current directory.
  --props <file>         Composition props, or a { "<clip-id>": {...} } override map for a timeline.
  --out <path>           Output path for still, render, tts, or transcribe. For still, one frame uses a .png file and multiple frames use a directory. Render defaults to out/<id>.mp4 for video and out/<id>.png for a static composition.
  --frame <spec>         Still frames: n, n-m, or a comma-separated list (maximum 32 unique frames).
  --frames <spec>        Render frames: n, n-m, or a comma-separated list; video requires a contiguous range.
  --scale <factor>       Encode-time video scale from 0.25 to 1. Scales during encode; output stays even-sized.
  --sequence <dir>       Write PNG frames instead of video. Requires --frames; full-size only.
  --concurrency <n>      Parallel browser sessions for animated composition render, 1-${MAX_RENDER_CONCURRENCY} (default: 1).
  --workers <n>          Parallel segment workers for timeline render, 1-${MAX_TIMELINE_WORKERS} (default: 8).
  --encoder <name>       Encoder: auto, software, nvenc, or qsv (default: auto).
  --codec <name>         Delivery codec for render: h264, hevc, or vp9 (default: h264; vp9 for webm).
  --container <name>     Delivery container: mp4, mov, mkv, or webm (default: mp4).
  --scratch <dir>        Scratch directory for timeline intermediates (default: system temp).
  --overwrite            Replace an existing still or render output when the resource policy allows it.
  --force                Replace existing generated assets and manifest entries when the resource policy allows it.
  --dry-run              Validate and print the plan and handoff command without rendering, synthesizing, transcribing, or writing outputs.
  --profile <name>       Resource profile for shared machines. shared-cpu caps workers at 2, concurrency at 1, and lowers process priority.
  --low-priority         Lower the process priority without changing worker caps.
  --local-models         With init, also install the optional local-model host scaffold.
  --template <name>      Template for "add composition|timeline": static-poster, title-card, lower-third, or slideshow.
  --list                 List add templates, recipes, and scaffolds, or all explain codes.
  --file <path>          Local font file for "font add": .woff2, .woff, .ttf, or .otf.
  --url <https-url>      Download a font from HTTPS (loopback HTTP is allowed for tests).
  --family <name>        CSS font-family name or alias for "font add".
  --id <id>              Project id for "add recipe"; font manifest id for "font add --file/--url".
  --weight <value>       Font weight or variable range; comma-separated weights for Fontsource --static.
  --style <value>        qwen style instruction, or normal|italic (comma list for Fontsource).
  --subset <name>        Font subset label; comma-separated for Fontsource.
  --unicode-range <r>    CSS unicode-range for a local or URL font face.
  --license <id>         License identifier for --file/--url; warns when omitted.
  --license-file <path>  Copy a license file into the font directory.
  --sha256 <hash>        Expected SHA-256 for --url; the computed hash is always recorded.
  --category <name>      Fontsource category filter for "font search".
  --limit <n>            Fontsource result limit for "font search", 1-100 (default: 20).
  --variable             Fontsource search filter: only variable fonts.
  --static               Install static Fontsource weights instead of the variable face.
  --keep-files           Keep font files when removing a font from the manifest.
  --text-file <file>     Text to synthesize. Reads stdin when omitted.
  --speaker <value>      Named speaker for qwen, or the numeric speaker id for Supertonic.
  --engine <name>        Speech engine: qwen or supertonic (default: qwen).
  --model-dir <dir>      Supertonic model directory from the sherpa-onnx archive.
  --talker-model <gguf>  Talker GGUF model path for qwen.
  --codec-model <gguf>   Codec GGUF model path for qwen.
  --style <value>        Optional qwen style instruction, or normal|italic for "font add".
  --language <lang>      Spoken language. Supertonic requires one of its 31 upstream language codes.
  --device <name>        Compute device for qwen-tts, such as CPU or CUDA0.
  --model <gguf>         Whisper GGML model path.
  --words                Request measured word timings during transcription.
  --export srt,vtt       Derived subtitle exports next to the transcript.
  --executable <path>    Explicit qwen-tts, sherpa-onnx-offline-tts, or whisper-cli executable.
  --manifest <file>      Provenance manifest path (default: fy.assets.json).
  --qwen-tts <path>      qwen-tts executable to inspect with doctor.
  --sherpa-onnx-tts <path>  sherpa-onnx-offline-tts executable to inspect with doctor.
  --whisper-cli <path>   whisper-cli executable to inspect with doctor.
  --json                 Print a structured result to stdout.
  --help, -h             Show this help.
  --version, -v          Print the version.

Resource policy: the nearest fy.policy.json from the working directory upward sets light, authoring, or full; FRAMEYARD_POLICY overrides it. tts, transcribe, and render are blocked outside full. font add requires authoring or full; font remove and font add --force require full. Use --dry-run to validate and produce a handoff command without doing heavy work.
`);
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "init":
      process.stdout.write(
        "Usage: frameyard init [directory] [--local-models]\nScaffold a minimal Frameyard project. Without a directory, init asks for a project name (default: my-video) and creates that directory; non-interactive and --json runs use the default. --local-models also installs the optional policy, OpenCode, and Pi scaffold.\n",
      );
      return;
    case "dev":
      process.stdout.write(
        "Usage: frameyard dev [--port <port>] [--project <dir>]\nStart the browser preview server.\n",
      );
      return;
    case "context":
      process.stdout.write(
        "Usage: frameyard context [--project <dir>] [--json]\nPrint a compact digest of the project, resolved timelines, assets, diagnostics, active policy, and next commands. It never launches Chromium.\n",
      );
      return;
    case "lint":
      process.stdout.write(
        "Usage: frameyard lint <composition-or-timeline-id> [--props <file>] [--project <dir>] [--json]\nRun static validation, timeline resolution, scene and keyframe projection for every timeline frame, and a controller determinism scan without launching Chromium. It does not run validateProps or capture frames; use check for the full gate.\n",
      );
      return;
    case "check":
      process.stdout.write(
        "Usage: frameyard check <composition-id> [--props <file>] [--project <dir>] [--profile <name>] [--low-priority] [--json]\nValidate props, assets, audio, and every frame without encoding. The authoring policy lowers process priority for check.\n",
      );
      return;
    case "still":
      process.stdout.write(
        "Usage: frameyard still <composition-or-timeline-id> --frame <spec> [--out <path>] [--props <file>] [--project <dir>] [--overwrite] [--profile <name>] [--low-priority] [--json]\nCapture one or more frames through the production rendering path. <spec> is a frame number, an inclusive range like 2-12, or a comma-separated list; the policy caps unique frames per invocation. With one frame, --out is a .png file; with multiple frames, --out is a directory. A static composition exposes only frame 0.\n",
      );
      return;
    case "inspect":
      process.stdout.write(
        "Usage: frameyard inspect <image> [--json]\nDecode the first frame and report dimensions, alpha coverage, blank detection, background and dominant colors, content bbox, a coarse luminance grid, and edge density. It never launches Chromium.\n",
      );
      return;
    case "compare":
      process.stdout.write(
        "Usage: frameyard compare <first-image> <second-image> [--json]\nCompare two decoded images pixel by pixel and by 3×3 region. Exits 1 when the images differ; the JSON result still has ok: true and identical: false.\n",
      );
      return;
    case "render":
      process.stdout.write(
        `Usage: frameyard render <composition-or-timeline-id> [--out <file>] [--frames <spec>] [--scale <factor>] [--sequence <dir>] [--props <file>] [--project <dir>] [--concurrency <n>] [--workers <n>] [--encoder <name>] [--codec <name>] [--container <name>] [--scratch <dir>] [--overwrite] [--dry-run] [--profile <name>] [--low-priority] [--json]\nRender an MP4, MOV, MKV, or WebM with H.264, HEVC, or VP9 video and AAC or Opus audio, a PNG for a static composition, or a PNG sequence with --sequence. The default output is out/<id>.<extension> for video and out/<id>.png for a static composition. --frames accepts n, n-m, or a comma list; video requires a contiguous range, while --sequence accepts arbitrary lists and requires --frames. --scale is 0.25-1 and scales during encode; output dimensions stay even. Animated composition concurrency is 1-${MAX_RENDER_CONCURRENCY}; timeline workers are 1-${MAX_TIMELINE_WORKERS}. The shared-cpu profile caps workers at 2 and concurrency at 1. Encoder choices are auto, software, nvenc, and qsv; the default auto probes NVENC, then Quick Sync, then the codec's software encoder. WebM and VP9 use Opus audio, and HEVC in MP4/MOV keeps the hvc1 sample entry. A static composition rejects --concurrency, --container, --codec, --encoder, --frames, and --scale. With --dry-run, validates and prints the plan and handoff command without writing outputs or launching Chromium.\n`,
      );
      return;
    case "tts":
      process.stdout.write(
        "Usage: frameyard tts [--engine qwen] --speaker <name> --talker-model <gguf> --codec-model <gguf> --out <file.wav> [--text-file <file>] [--style <text>] [--language <lang>] [--device <name>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]\n       frameyard tts --engine supertonic --speaker <sid> --model-dir <dir> --language <code> --out <file.wav> [--text-file <file>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]\nProduce one frozen 24 kHz mono WAV with local qwentts.cpp CustomVoice or sherpa-onnx Supertonic 3 synthesis. Supertonic language codes: ar, bg, cs, da, de, el, en, es, et, fi, fr, hi, hr, hu, id, it, ja, ko, lt, lv, nl, pl, pt, ro, ru, sk, sl, sv, tr, uk, vi. With --dry-run, validates inputs and prints the plan and command without loading a model.\n",
      );
      return;
    case "transcribe":
      process.stdout.write(
        "Usage: frameyard transcribe <source> --model <gguf> --out <file.json> [--words] [--export srt,vtt] [--language <lang>] [--executable <path>] [--manifest <file>] [--force] [--dry-run] [--profile <name>] [--low-priority] [--json]\nProduce a canonical Frameyard transcript, optionally with word timings and subtitle exports. With --dry-run, validates inputs and prints the plan and command without loading a model.\n",
      );
      return;
    case "add":
      process.stdout.write(
        "Usage: frameyard add --list [--json]\n       frameyard add local-models [--project <dir>] [--json]\n       frameyard add <composition|timeline> <id> --template <name> [--project <dir>] [--json]\nWrite a valid template entry and print the exact fy.config.js registration snippet, or install the optional local-model host scaffold. Templates are static-poster, title-card, lower-third, and slideshow. The command refuses to overwrite an existing file or an already registered id.\n",
      );
      return;
    case "font":
      process.stdout.write(
        "Usage: frameyard font search [query] [--category <name>] [--subset <name>] [--style normal|italic] [--variable] [--limit <n>] [--json]\n       frameyard font add <fontsource-id> [--family <alias>] [--subset <name>] [--style normal|italic] [--weight <n>] [--static] [--force] [--project <dir>] [--json]\n       frameyard font add --file <path> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--subset <name>] [--unicode-range <range>] [--license <id>] [--license-file <path>] [--force] [--project <dir>] [--json]\n       frameyard font add --url <https-url> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--subset <name>] [--unicode-range <range>] [--license <id>] [--license-file <path>] [--sha256 <hash>] [--force] [--project <dir>] [--json]\n       frameyard font list|verify [--project <dir>] [--json]\n       frameyard font remove <id> [--keep-files] [--project <dir>] [--json]\nSearch Fontsource, vendor a Fontsource/local/URL font into assets/fonts/<id>/, and manage fy.fonts.json. The server serves the generated @font-face sheet at /__frameyard/fonts.css. Project policy allows search/list/verify everywhere, add in authoring and full, and remove or --force only in full. A --url import without --license also requires full.\n",
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

async function projectFromFlag(flags: Map<string, string | true>, options: { fonts?: boolean } = {}): Promise<Project> {
  const requested = flags.get("project");
  const root =
    typeof requested === "string" ? path.resolve(process.cwd(), requested) : await resolveProjectRoot(process.cwd());
  return loadProject(root, options);
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
    if (diagnostic.fix !== undefined) {
      process.stderr.write(`  fix: ${diagnostic.fix.message}\n`);
      if (diagnostic.fix.command !== undefined) {
        process.stderr.write(`  run: ${diagnostic.fix.command}\n`);
      }
      if (diagnostic.fix.docs !== undefined) {
        process.stderr.write(`  docs: ${diagnostic.fix.docs}\n`);
      }
    }
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function handoffCommand(args: readonly string[]): string {
  return ["npx", "frameyard", ...args].map(shellQuote).join(" ");
}

function collectPrerequisites(timeline: ResolvedTimeline): string[] {
  const values = new Set<string>();
  const visit = (current: ResolvedTimeline): void => {
    for (const clip of current.clips) {
      const source = clip.source;
      if (source.kind === "video" || source.kind === "image" || source.kind === "audio") {
        values.add(source.src);
      } else if (source.kind === "composition") {
        values.add(source.entry);
        for (const audio of source.audioClips) {
          values.add(audio.src);
        }
        for (const transcript of source.transcriptClips) {
          values.add(transcript.src);
        }
      } else if (source.kind === "timeline") {
        visit(source.timeline);
      }
    }
  };
  visit(timeline);
  return [...values].sort();
}

interface DryRunBlocker {
  code: string;
  message: string;
  suggestion?: string;
}

function printDryRun(
  label: string,
  plan: Record<string, unknown>,
  commandLine: string,
  prerequisites: readonly string[],
  blockers: readonly DryRunBlocker[],
): void {
  process.stdout.write(`${label} dry run\n`);
  process.stdout.write(`  plan: ${JSON.stringify(plan)}\n`);
  process.stdout.write(`  command: ${commandLine}\n`);
  if (prerequisites.length > 0) {
    process.stdout.write(`  prerequisites: ${prerequisites.join(", ")}\n`);
  }
  for (const blocker of blockers) {
    process.stdout.write(`  blocker [${blocker.code}]: ${blocker.message}\n`);
  }
}

async function prerequisiteBlockers(
  items: ReadonlyArray<{ label: string; path: string; directory?: boolean }>,
): Promise<DryRunBlocker[]> {
  const blockers: DryRunBlocker[] = [];
  for (const item of items) {
    let info;
    try {
      info = await stat(item.path);
    } catch {
      blockers.push({
        code: "ASSET_NOT_FOUND",
        message: `${item.label} does not exist: ${item.path}`,
        suggestion: "Check the path before running the heavy operation.",
      });
      continue;
    }
    if (item.directory === true ? !info.isDirectory() : !info.isFile()) {
      blockers.push({
        code: "ASSET_NOT_FOUND",
        message: `${item.label} is not a ${item.directory === true ? "directory" : "file"}: ${item.path}`,
        suggestion: "Check the path before running the heavy operation.",
      });
    }
  }
  return blockers;
}

const DEFAULT_INIT_PROJECT_NAME = "my-video";

function assertProjectDirectoryName(name: string): void {
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    usage(`Project name must be a directory name without path separators; received "${name}".`);
  }
}

/**
 * Asks for the project name on an interactive terminal. EOF accepts the
 * default; Ctrl+C cancels the command.
 */
async function promptProjectName(defaultName: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });

  try {
    const closed = new Promise<null>((resolve) => {
      rl.once("close", () => resolve(null));
    });
    const answer = await Promise.race([rl.question(`Project name (${defaultName}): `), closed]);

    if (interrupted) {
      throw new FrameyardError("CANCELLED", "Project creation cancelled.");
    }

    const name = (answer ?? "").trim();
    return name === "" ? defaultName : name;
  } finally {
    rl.close();
  }
}

/**
 * `init <directory>` scaffolds into that directory. A bare `init` asks for a
 * project name on an interactive terminal and creates a directory with it;
 * non-interactive and `--json` runs use the default name without prompting.
 */
async function resolveInitTarget(parsed: ParsedArgs): Promise<string> {
  const positional = parsed.positionals[0];
  if (positional !== undefined) {
    return path.resolve(process.cwd(), positional);
  }

  const interactive = parsed.flags.has("json") !== true && process.stdin.isTTY === true;
  const name = interactive ? await promptProjectName(DEFAULT_INIT_PROJECT_NAME) : DEFAULT_INIT_PROJECT_NAME;
  assertProjectDirectoryName(name);
  return path.resolve(process.cwd(), name);
}

async function runInit(parsed: ParsedArgs): Promise<number> {
  const target = await resolveInitTarget(parsed);
  const json = parsed.flags.has("json") === true;
  const localModels = parsed.flags.has("local-models") === true;

  const files = {
    ...scaffoldFiles(path.basename(target) || "frameyard-project"),
    ...(localModels ? localModelScaffoldFiles() : {}),
  };
  const next = localModels ? [...SCAFFOLD_NEXT, "Review .pi/settings.json and run pi --approve"] : [...SCAFFOLD_NEXT];

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
    next,
    ...(localModels ? { localModels: true } : {}),
  };

  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`Created Frameyard project at ${target}\n`);
    for (const file of Object.keys(files)) {
      process.stdout.write(`  ${file}\n`);
    }
    process.stdout.write("Next: " + next.slice(0, 2).join(" && ") + "\n");
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

async function runContext(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  assertOperationAllowed(policy, "context");
  const project = await projectFromFlag(parsed.flags);
  const result = await buildProjectContext({ project, policy, signal });
  const json = parsed.flags.has("json") === true;

  if (json) {
    printJson({ ok: true, command: "context", ...result });
    return 0;
  }

  process.stdout.write(`Frameyard project: ${result.root}\n`);
  if (result.format !== undefined) {
    process.stdout.write(`format: ${result.format.width}×${result.format.height} @ ${result.format.fps} fps\n`);
  }
  process.stdout.write(`policy: ${describePolicy(policy)}\n`);
  process.stdout.write(`compositions: ${result.compositions.length}\n`);
  for (const composition of result.compositions) {
    const metadata = composition.metadata;
    const detail =
      metadata === undefined
        ? composition.kind
        : metadata.static === true
          ? `static ${metadata.width}×${metadata.height}`
          : `${metadata.width}×${metadata.height} @ ${metadata.fps} fps, ${metadata.durationInFrames} frames`;
    process.stdout.write(
      `  ${composition.id}: ${detail}, ${composition.props.length} props, ${composition.diagnostics.errors} errors/${composition.diagnostics.warnings} warnings\n`,
    );
  }
  process.stdout.write(`timelines: ${result.timelines.length}\n`);
  for (const timeline of result.timelines) {
    const detail =
      timeline.durationInFrames === undefined
        ? "unresolved"
        : `${timeline.durationInFrames} frames (${timeline.durationSeconds?.toFixed(1)}s), ${timeline.tracks} tracks, ${timeline.clips?.length ?? 0} clips, ${timeline.transitions} transitions, ${timeline.audio} audio, ${timeline.transcripts} transcripts`;
    process.stdout.write(
      `  ${timeline.id}: ${detail}, ${timeline.diagnostics.errors} errors/${timeline.diagnostics.warnings} warnings\n`,
    );
  }
  process.stdout.write(`assets: ${result.assets.length}\n`);
  process.stdout.write(`fonts: ${result.fonts.length}\n`);
  for (const font of result.fonts) {
    const subsets = font.subsets.length === 0 ? "no subset" : font.subsets.join(",");
    process.stdout.write(
      `  ${font.id}: ${font.family} (${font.provider}${font.version ? ` ${font.version}` : ""}), ${subsets}, ${font.styles.join("/")}, ${font.license}, ${font.files} files, ${font.status}\n`,
    );
  }
  process.stdout.write(`next:\n`);
  for (const command of result.next) {
    process.stdout.write(`  ${command}\n`);
  }
  return 0;
}

async function runInspect(parsed: ParsedArgs): Promise<number> {
  const startedAt = performance.now();
  const filePath = path.resolve(process.cwd(), parsed.positionals[0] as string);
  const probed = await probeImage(filePath);
  const pixels = await decodeRgba(filePath, probed.width, probed.height);
  const stats = analyzeRgba(pixels, probed.width, probed.height);
  const json = parsed.flags.has("json") === true;
  const result = {
    ok: true,
    command: "inspect",
    path: filePath,
    bytes: probed.bytes,
    ...stats,
    elapsedMs: performance.now() - startedAt,
  };

  if (json) {
    printJson(result);
    return 0;
  }

  process.stdout.write(`Inspected ${filePath} (${stats.width}×${stats.height}, ${probed.bytes} bytes)\n`);
  process.stdout.write(
    `  blank: ${stats.blank}; alpha ${stats.alpha.min}..${stats.alpha.max}, coverage ${(stats.alpha.coverage * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(
    `  background: ${stats.background.hex} (${(stats.background.share * 100).toFixed(1)}%); content: ${stats.content.pixels} px (${(stats.content.share * 100).toFixed(1)}%)${stats.content.bbox === null ? "" : ` at ${stats.content.bbox.x},${stats.content.bbox.y} ${stats.content.bbox.width}×${stats.content.bbox.height}`}\n`,
  );
  process.stdout.write(
    `  colors: ${stats.colors.map((color) => `${color.hex} ${(color.share * 100).toFixed(1)}%`).join(", ") || "(none)"}\n`,
  );
  process.stdout.write(`  edge density: ${stats.edgeDensity}\n`);
  return 0;
}

async function runCompare(parsed: ParsedArgs): Promise<number> {
  const startedAt = performance.now();
  const firstPath = path.resolve(process.cwd(), parsed.positionals[0] as string);
  const secondPath = path.resolve(process.cwd(), parsed.positionals[1] as string);
  const [first, second] = await Promise.all([probeImage(firstPath), probeImage(secondPath)]);
  if (first.width !== second.width || first.height !== second.height) {
    throw new FrameyardError(
      "IMAGE_INVALID",
      `Images have different dimensions: ${firstPath} is ${first.width}×${first.height}, ${secondPath} is ${second.width}×${second.height}.`,
      { details: { first: firstPath, second: secondPath } },
    );
  }
  const [firstPixels, secondPixels] = await Promise.all([
    decodeRgba(firstPath, first.width, first.height),
    decodeRgba(secondPath, second.width, second.height),
  ]);
  const stats = compareRgba(firstPixels, secondPixels, first.width, first.height);
  const json = parsed.flags.has("json") === true;
  const result = {
    ok: true,
    command: "compare",
    first: firstPath,
    second: secondPath,
    ...stats,
    elapsedMs: performance.now() - startedAt,
  };

  if (json) {
    printJson(result);
  } else if (stats.identical) {
    process.stdout.write(`${firstPath} and ${secondPath} are pixel-identical (${stats.width}×${stats.height}).\n`);
  } else {
    process.stdout.write(`${firstPath} and ${secondPath} differ:\n`);
    process.stdout.write(`  dimensions: ${stats.width}×${stats.height}\n`);
    process.stdout.write(`  differing pixels: ${stats.differingPixels} / ${stats.totalPixels} (${stats.percent}%)\n`);
    process.stdout.write(`  max channel delta: ${stats.maxChannelDelta}; mean ${stats.meanChannelDelta}\n`);
    process.stdout.write(
      `  bounding box: ${stats.bbox === null ? "(none)" : `x=${stats.bbox.x}..${stats.bbox.x + stats.bbox.width - 1}, y=${stats.bbox.y}..${stats.bbox.y + stats.bbox.height - 1}`}\n`,
    );
  }
  return stats.identical ? 0 : 1;
}

function runExplain(parsed: ParsedArgs): number {
  const json = parsed.flags.has("json") === true;
  if (parsed.flags.has("list")) {
    const codes = listDiagnosticExplanations();
    if (json) {
      printJson({ ok: true, command: "explain", codes });
    } else {
      for (const entry of codes) {
        process.stdout.write(`${entry.code}\t${entry.summary}\n`);
      }
    }
    return 0;
  }

  const code = parsed.positionals[0] as string;
  const explanation = explainDiagnosticCode(code);
  if (explanation === undefined) {
    usage(`Unknown diagnostic code "${code}". Run "frameyard explain --list" to see available codes.`);
  }

  const result = {
    ok: true,
    command: "explain",
    code: explanation.code,
    message: explanation.message,
    ...(explanation.docs !== undefined ? { docs: explanation.docs } : {}),
    ...(explanation.examples !== undefined ? { examples: explanation.examples } : {}),
  };
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`${explanation.code}\n`);
    process.stdout.write(`Cause: ${explanation.message}\n`);
    if (explanation.examples !== undefined) {
      process.stdout.write(`Failing:\n  ${explanation.examples.failing}\n`);
      process.stdout.write(`Corrected:\n  ${explanation.examples.corrected}\n`);
    }
    if (explanation.docs !== undefined) {
      process.stdout.write(`Docs: ${explanation.docs}\n`);
    }
  }
  return 0;
}

async function runAddRecipe(parsed: ParsedArgs, json: boolean): Promise<number> {
  const recipeId = parsed.positionals[1] as string;
  const id = flagString(parsed.flags, "id") as string;
  const recipe = findRecipe(recipeId);
  if (recipe === undefined) {
    usage(`Unknown recipe "${recipeId}".`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      `Invalid id "${id}". Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.`,
    );
  }

  const project = await projectFromFlag(parsed.flags);
  if (project.format === undefined) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      "Project recipes inherit the project format. Add format { width, height, fps } to fy.config.js first.",
    );
  }

  const plan = recipeInstallPlan(recipe, id);
  const registered: string[] = [];
  const entryIds = new Set<string>();
  for (const entry of plan.entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
      throw new FrameyardError("CONFIG_INVALID", `Recipe "${recipe.id}" produced invalid project id "${entry.id}".`);
    }
    if (entryIds.has(entry.id)) {
      throw new FrameyardError("CONFIG_INVALID", `Recipe "${recipe.id}" produced duplicate project id "${entry.id}".`);
    }
    entryIds.add(entry.id);
    if (project.compositions.has(entry.id) || project.timelines.has(entry.id)) {
      registered.push(entry.id);
    }
  }
  if (registered.length > 0) {
    throw new FrameyardError(
      "OUTPUT_EXISTS",
      `Project id${registered.length === 1 ? "" : "s"} ${registered.map((entry) => `"${entry}"`).join(", ")} already registered in fy.config.js.`,
      { details: { ids: registered } },
    );
  }

  const conflicts: string[] = [];
  const filePaths = new Set<string>();
  for (const file of plan.files) {
    if (filePaths.has(file.path)) {
      throw new FrameyardError("CONFIG_INVALID", `Recipe "${recipe.id}" produced duplicate file path "${file.path}".`);
    }
    filePaths.add(file.path);
    const target = path.resolve(project.root, file.path);
    if (target === project.root || !target.startsWith(project.root + path.sep)) {
      throw new FrameyardError("CONFIG_INVALID", `Recipe file escapes the project root: ${file.path}`);
    }
    if (await pathExists(target)) {
      conflicts.push(file.path);
    }
  }
  if (conflicts.length > 0) {
    throw new FrameyardError("OUTPUT_EXISTS", `Refusing to overwrite recipe files: ${conflicts.join(", ")}.`, {
      details: { conflicts },
    });
  }

  const created: string[] = [];
  try {
    for (const file of plan.files) {
      const target = path.resolve(project.root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
      created.push(target);
    }
  } catch (error) {
    await Promise.allSettled(created.map((file) => rm(file, { force: true })));
    throw new FrameyardError("OUTPUT_FAILED", `Could not write recipe "${recipe.id}": ${errorMessage(error)}`, {
      cause: error,
      details: { files: plan.files.map((file) => file.path) },
    });
  }

  const registration = recipeRegistration(recipe, id);
  const register = {
    ...(registration.compositions !== undefined ? { compositions: registration.compositions } : {}),
    ...(registration.timelines !== undefined ? { timelines: registration.timelines } : {}),
  };
  const timeline = plan.entries.find((entry) => entry.kind === "timeline");
  const lintTarget = timeline?.id ?? plan.entries[0]?.id;
  const next = [
    "Add the register entries to fy.config.js",
    ...(lintTarget !== undefined ? [`npx frameyard lint ${lintTarget} --json`] : []),
    ...(timeline !== undefined ? [`npx frameyard render ${timeline.id} --json`] : []),
  ];
  const result = {
    ok: true,
    command: "add",
    kind: "recipe",
    recipe: recipe.id,
    id,
    path: project.root,
    files: plan.files.map((file) => file.path),
    register,
    prerequisites: recipe.prerequisites ?? [],
    next,
  };

  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`Installed recipe ${recipe.id} as ${id}\n`);
    for (const file of result.files) {
      process.stdout.write(`  ${file}\n`);
    }
    process.stdout.write("Add to fy.config.js:\n");
    for (const [key, value] of Object.entries(register)) {
      const entries = Object.entries(value)
        .map(([entryId, entry]) => `"${entryId}": "${entry}"`)
        .join(", ");
      process.stdout.write(`  ${key}: { ${entries} }\n`);
    }
    if (result.prerequisites.length > 0) {
      process.stdout.write(`Provide: ${result.prerequisites.join(", ")}\n`);
    }
  }
  return 0;
}

async function runAdd(parsed: ParsedArgs): Promise<number> {
  const json = parsed.flags.has("json") === true;
  if (parsed.flags.has("list")) {
    const templates = listTemplates().map((template) => ({
      name: template.name,
      kind: template.kind,
      description: template.description,
      ...(template.prerequisites !== undefined ? { prerequisites: template.prerequisites } : {}),
    }));
    const recipes = listRecipes().map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      tags: recipe.tags,
      kind: recipe.kind,
      files: recipe.files.map((file) => file.path),
      ...(recipe.prerequisites !== undefined ? { prerequisites: recipe.prerequisites } : {}),
    }));
    const scaffolds = [
      {
        name: "local-models",
        description: "Optional policy, OpenCode permissions, and Pi settings for a shared local model.",
      },
    ];
    if (json) {
      printJson({ ok: true, command: "add", templates, recipes, scaffolds });
    } else {
      for (const template of templates) {
        process.stdout.write(`${template.kind}\t${template.name}\t${template.description}\n`);
      }
      for (const recipe of recipes) {
        process.stdout.write(`recipe\t${recipe.id}\t${recipe.title}\t${recipe.description}\n`);
      }
      for (const scaffold of scaffolds) {
        process.stdout.write(`scaffold\t${scaffold.name}\t${scaffold.description}\n`);
      }
    }
    return 0;
  }

  if (parsed.positionals[0] === "recipe") {
    return runAddRecipe(parsed, json);
  }

  if (parsed.positionals[0] === "local-models") {
    const root = await assetRootFromFlag(parsed.flags);
    const files = localModelScaffoldFiles();
    const conflicts: string[] = [];
    for (const relative of Object.keys(files)) {
      if (await pathExists(path.join(root, relative))) {
        conflicts.push(relative);
      }
    }
    if (conflicts.length > 0) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Refusing to overwrite local-model scaffold files: ${conflicts.join(", ")}.`,
        { details: { conflicts } },
      );
    }

    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }

    const result = {
      ok: true,
      command: "add",
      kind: "scaffold",
      scaffold: "local-models",
      path: root,
      files: Object.keys(files),
      next: [
        "Review .opencode/opencode.jsonc and .pi/settings.json",
        "Run pi --approve in the project",
        "Run npx frameyard context --json from the project",
      ],
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`Installed local-model scaffold in ${root}\n`);
      for (const file of result.files) {
        process.stdout.write(`  ${file}\n`);
      }
      process.stdout.write(`Next: ${result.next[0]}\n`);
    }
    return 0;
  }

  const kind = parsed.positionals[0] as TemplateKind;
  const id = parsed.positionals[1] as string;
  const templateName = flagString(parsed.flags, "template") as string;
  const template = findTemplate(templateName);
  if (template === undefined) {
    usage(`Unknown template "${templateName}".`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      `Invalid id "${id}". Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.`,
    );
  }

  const project = await projectFromFlag(parsed.flags);
  if (project.compositions.has(id) || project.timelines.has(id)) {
    throw new FrameyardError("OUTPUT_EXISTS", `Project id "${id}" is already registered in fy.config.js.`);
  }
  if (project.format === undefined) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      "Project templates inherit the project format. Add format { width, height, fps } to fy.config.js first.",
    );
  }

  const entry = template.entry(id);
  const targetPath = path.resolve(project.root, entry);
  if (await pathExists(targetPath)) {
    throw new FrameyardError("OUTPUT_EXISTS", `Refusing to overwrite ${targetPath}.`);
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, template.content, { flag: "wx" });
  } catch (error) {
    throw new FrameyardError("OUTPUT_FAILED", `Could not write ${targetPath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const registration = templateRegistration(template, id);
  const register = Object.fromEntries(Object.entries(registration).filter(([, value]) => value !== undefined));
  const result = {
    ok: true,
    command: "add",
    kind,
    id,
    template: template.name,
    entry,
    path: targetPath,
    register,
    prerequisites: template.prerequisites ?? [],
    next: ["Add the register entry to fy.config.js", `npx frameyard lint ${id} --json`],
  };

  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`Created ${targetPath}\n`);
    const key = kind === "composition" ? "compositions" : "timelines";
    process.stdout.write(`Add to fy.config.js:\n  ${key}: { "${id}": "./${entry}" }\n`);
    if ((template.prerequisites ?? []).length > 0) {
      process.stdout.write(`Provide: ${(template.prerequisites ?? []).join(", ")}\n`);
    }
  }
  return 0;
}

function splitFontList(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    usage(`--${flag} requires at least one value.`);
  }
  return parts;
}

function parseFontsourceWeights(value: string | undefined): number[] | undefined {
  const parts = splitFontList(value, "weight");
  if (parts === undefined) {
    return undefined;
  }
  return parts.map((part) => {
    const weight = Number(part);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      usage(`--weight entries must be integers between 1 and 1000; received "${part}".`);
    }
    return weight;
  });
}

function parseFontsourceStyles(value: string | undefined): ReturnType<typeof parseFontStyle>[] | undefined {
  const parts = splitFontList(value, "style");
  return parts?.map((part) => parseFontStyle(part));
}

function printFontAddResult(
  result: {
    font: FontSummary;
    manifest: string;
    files: string[];
    warnings: Array<{ code: string; message: string }>;
  },
  json: boolean,
): void {
  if (json) {
    printJson({ ok: true, command: "font", action: "add", ...result });
    return;
  }
  for (const warning of result.warnings) {
    process.stderr.write(`⚠ ${warning.code}: ${warning.message}\n`);
  }
  process.stdout.write(
    `✓ font ${result.font.id}: ${result.font.family} (${result.font.provider}${result.font.version ? ` ${result.font.version}` : ""}), ${result.font.files} file${result.font.files === 1 ? "" : "s"}, ${result.font.bytes} bytes\n`,
  );
  process.stdout.write(`  manifest: ${result.manifest}\n`);
  process.stdout.write(`  css: /__frameyard/fonts.css\n`);
  process.stdout.write(`  use: font-family: "${result.font.family}", system-ui, sans-serif\n`);
}

async function runFont(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  const action = parsed.positionals[0] as string;
  const json = parsed.flags.has("json") === true;
  assertOperationAllowed(policy, "font");

  if (action === "search") {
    const query = parsed.positionals[1] ?? "";
    const category = flagString(parsed.flags, "category");
    const subset = flagString(parsed.flags, "subset");
    const styleValue = flagString(parsed.flags, "style");
    const style = styleValue === undefined ? undefined : parseFontStyle(styleValue);
    const variable = parsed.flags.has("variable") ? true : undefined;
    const limitValue = flagString(parsed.flags, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    const result = await searchFontsource({
      query,
      ...(category !== undefined ? { category } : {}),
      ...(subset !== undefined ? { subset } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(variable !== undefined ? { variable } : {}),
      ...(limit !== undefined ? { limit } : {}),
      signal,
    });
    if (json) {
      printJson({ ok: true, command: "font", action: "search", ...result });
    } else {
      process.stdout.write(
        `fontsource: ${result.results.length} result${result.results.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}\n`,
      );
      for (const item of result.results) {
        process.stdout.write(
          `  ${item.id}: ${item.family} [${item.category}]${item.variable ? " variable" : ""}, weights ${item.weights.join(",")}, ${item.styles.join("/")}, subsets ${item.subsets.join(",")}, ${item.license}\n`,
        );
      }
    }
    return 0;
  }

  if (action === "add") {
    assertPolicyTier(policy, "authoring", "font add");
    if (
      typeof parsed.flags.get("url") === "string" &&
      !parsed.flags.has("license") &&
      !parsed.flags.has("license-file")
    ) {
      assertPolicyTier(policy, "full", "font add --url without --license");
    }
  }
  if (action === "remove") {
    assertPolicyTier(policy, "full", "font remove");
  }
  if (parsed.flags.has("force")) {
    assertOverwriteAllowed(policy, "force");
  }

  const project = await projectFromFlag(parsed.flags, { fonts: false });
  let manifest: FontManifest | undefined;
  try {
    manifest = await readFontManifest(project.root);
  } catch (error) {
    if (action === "verify" && isFrameyardError(error)) {
      const verification = {
        manifest: fontManifestPath(project.root),
        fonts: 0,
        files: 0,
        bytes: 0,
        diagnostics: [
          {
            severity: "error" as const,
            code: error.code,
            message: error.message,
          },
        ],
        valid: false,
      };
      if (json) {
        printJson({ ok: true, command: "font", action: "verify", ...verification });
      } else {
        process.stderr.write(`✗ ${error.code}: ${error.message}\n`);
      }
      return 1;
    }
    throw error;
  }

  if (action === "add") {
    const file = flagString(parsed.flags, "file");
    const url = flagString(parsed.flags, "url");
    const family = flagString(parsed.flags, "family");
    const id = flagString(parsed.flags, "id");
    const weightValue = flagString(parsed.flags, "weight");
    const styleValue = flagString(parsed.flags, "style");
    const subsetValue = flagString(parsed.flags, "subset");
    const force = parsed.flags.has("force") === true;

    if (file !== undefined) {
      printFontAddResult(
        await addLocalFont({
          projectRoot: project.root,
          ...(manifest !== undefined ? { manifest } : {}),
          file,
          family: family as string,
          ...(id !== undefined ? { id } : {}),
          weight: weightValue === undefined ? 400 : parseFontWeight(weightValue),
          style: styleValue === undefined ? "normal" : parseFontStyle(styleValue),
          ...(subsetValue !== undefined ? { subset: subsetValue } : {}),
          ...(flagString(parsed.flags, "unicode-range") !== undefined
            ? { unicodeRange: flagString(parsed.flags, "unicode-range") as string }
            : {}),
          ...(flagString(parsed.flags, "license") !== undefined
            ? { license: flagString(parsed.flags, "license") as string }
            : {}),
          ...(flagString(parsed.flags, "license-file") !== undefined
            ? { licenseFile: flagString(parsed.flags, "license-file") as string }
            : {}),
          force,
        }),
        json,
      );
      return 0;
    }

    if (url !== undefined) {
      printFontAddResult(
        await addUrlFont({
          projectRoot: project.root,
          ...(manifest !== undefined ? { manifest } : {}),
          url,
          family: family as string,
          ...(id !== undefined ? { id } : {}),
          weight: weightValue === undefined ? 400 : parseFontWeight(weightValue),
          style: styleValue === undefined ? "normal" : parseFontStyle(styleValue),
          ...(subsetValue !== undefined ? { subset: subsetValue } : {}),
          ...(flagString(parsed.flags, "unicode-range") !== undefined
            ? { unicodeRange: flagString(parsed.flags, "unicode-range") as string }
            : {}),
          ...(flagString(parsed.flags, "license") !== undefined
            ? { license: flagString(parsed.flags, "license") as string }
            : {}),
          ...(flagString(parsed.flags, "license-file") !== undefined
            ? { licenseFile: flagString(parsed.flags, "license-file") as string }
            : {}),
          ...(flagString(parsed.flags, "sha256") !== undefined
            ? { sha256: flagString(parsed.flags, "sha256") as string }
            : {}),
          force,
          signal,
        }),
        json,
      );
      return 0;
    }

    printFontAddResult(
      await addFontsource({
        projectRoot: project.root,
        ...(manifest !== undefined ? { manifest } : {}),
        id: parsed.positionals[1] as string,
        ...(family !== undefined ? { family } : {}),
        ...(subsetValue !== undefined ? { subsets: splitFontList(subsetValue, "subset") } : {}),
        ...(styleValue !== undefined ? { styles: parseFontsourceStyles(styleValue) } : {}),
        ...(weightValue !== undefined ? { weights: parseFontsourceWeights(weightValue) } : {}),
        static: parsed.flags.has("static") === true,
        force,
        signal,
      }),
      json,
    );
    return 0;
  }

  if (action === "list") {
    const verification =
      manifest === undefined
        ? undefined
        : await verifyFontManifest({
            projectRoot: project.root,
            manifest,
            hashes: false,
            licenses: false,
            orphans: false,
          });
    const statuses = verification === undefined ? new Map() : fontStatuses(verification);
    const fonts = (manifest?.fonts ?? [])
      .map((font) => summarizeFont(font, statuses.get(font.id) ?? "ok"))
      .sort((left, right) => left.family.localeCompare(right.family));
    const result = {
      ok: true,
      command: "font",
      action: "list",
      manifest: fontManifestPath(project.root),
      fonts,
    };
    if (json) {
      printJson(result);
    } else {
      if (fonts.length === 0) {
        process.stdout.write("No project fonts are installed.\n");
      } else {
        process.stdout.write(`fonts: ${fonts.length}\n`);
        for (const font of fonts) {
          const subsets = font.subsets.length === 0 ? "no subset" : font.subsets.join(", ");
          process.stdout.write(
            `  ${font.id}: ${font.family} (${font.provider}${font.version ? ` ${font.version}` : ""}), ${subsets}, ${font.styles.join("/")}, ${font.license}, ${font.files} files, ${font.bytes} bytes, ${font.status}\n`,
          );
        }
      }
    }
    return 0;
  }

  if (action === "verify") {
    const verification = await verifyFontManifest({
      projectRoot: project.root,
      manifest: manifest ?? emptyFontManifest(),
      hashes: true,
      licenses: true,
      orphans: true,
    });
    if (json) {
      printJson({ ok: true, command: "font", action: "verify", ...verification });
    } else {
      if (verification.fonts === 0) {
        process.stdout.write("No project fonts are installed.\n");
      } else {
        process.stdout.write(
          `${verification.valid ? "✓" : "✗"} font manifest: ${verification.fonts} fonts, ${verification.files} files, ${verification.bytes} bytes\n`,
        );
        process.stdout.write(`  ${verification.manifest}\n`);
      }
      for (const diagnostic of verification.diagnostics) {
        const marker = diagnostic.severity === "error" ? "✗" : "⚠";
        process.stderr.write(
          `${marker} ${diagnostic.code}: ${diagnostic.message}${diagnostic.file !== undefined ? ` (${diagnostic.file})` : ""}\n`,
        );
      }
    }
    return verification.valid ? 0 : 1;
  }

  if (action === "remove") {
    const result = await removeFont({
      projectRoot: project.root,
      ...(manifest !== undefined ? { manifest } : {}),
      id: parsed.positionals[1] as string,
      keepFiles: parsed.flags.has("keep-files") === true,
    });
    if (json) {
      printJson({ ok: true, command: "font", action: "remove", ...result });
    } else {
      process.stdout.write(`Removed font ${result.id} (${result.family}).\n`);
      if (result.keptFiles) {
        process.stdout.write(`  kept files: ${result.files.join(", ")}\n`);
      }
    }
    return 0;
  }

  usage(`Unknown font action "${action}". Use add, list, verify, or remove.`);
}

async function runLint(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  const project = await projectFromFlag(parsed.flags);
  await assertFontIntegrity(project.root, project.fonts, { hashes: false });
  const props = await readPropsFile(parsed.flags);
  const targetId = parsed.positionals[0] as string;
  const json = parsed.flags.has("json") === true;

  if (project.timelines.has(targetId)) {
    if (props !== undefined && !isPlainObject(props)) {
      usage("Timeline --props must be a JSON object keyed by composition clip id.");
    }
    const result = await lintTimeline({
      project,
      timelineId: targetId,
      ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
      signal,
    });
    printDiagnostics(result.diagnostics);
    if (json) {
      printJson({ ok: true, command: "lint", policy: policyDetails(policy), ...result });
    } else {
      process.stdout.write(
        `✓ lint timeline ${targetId}: ${result.framesProjected} frames projected, ${result.segments} segment${result.segments === 1 ? "" : "s"}, ${result.tracks} track${result.tracks === 1 ? "" : "s"}, ${result.clips} clip${result.clips === 1 ? "" : "s"}\n`,
      );
      process.stdout.write(
        `  policy: ${describePolicy(policy)}; lint does not replace check (props hooks and frame runtime are not evaluated)\n`,
      );
    }
    return 0;
  }

  const compositionId = targetId;
  const result = await lintComposition({
    project,
    compositionId,
    props,
    signal,
  });
  printDiagnostics(result.diagnostics);
  if (json) {
    printJson({ ok: true, command: "lint", policy: policyDetails(policy), ...result });
  } else if (result.metadata.static === true) {
    process.stdout.write(
      `✓ lint ${compositionId}: static ${result.metadata.width}×${result.metadata.height}; controller and document validated\n`,
    );
    process.stdout.write(`  policy: ${describePolicy(policy)}; lint does not replace check\n`);
  } else {
    process.stdout.write(
      `✓ lint ${compositionId}: document and controller validated for ${result.metadata.durationInFrames} frames; frame runtime is not evaluated\n`,
    );
    process.stdout.write(`  policy: ${describePolicy(policy)}; use check for props hooks and every frame\n`);
  }
  return 0;
}

async function runCheck(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  assertOperationAllowed(policy, "check");
  const profile = resolveProfile(policy, flagString(parsed.flags, "profile"));
  if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
    lowerProcessPriority();
  }

  const project = await projectFromFlag(parsed.flags);
  await assertFontIntegrity(project.root, project.fonts, { hashes: true });
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

/** Expands a frame spec into unique frames, preserving input order. */
function parseFrameSpec(value: string, options: { flag?: string; label?: string; maximum?: number } = {}): number[] {
  const flag = options.flag ?? "--frame";
  const label = options.label ?? "still";
  const maximum = options.maximum ?? MAX_STILL_FRAMES;
  const frames: number[] = [];
  const seen = new Set<number>();

  for (const rawSegment of value.split(",")) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      frameSpecUsage(`${flag} contains an empty entry: "${value}".`, { requested: value });
    }
    if (/\s/.test(segment)) {
      frameSpecUsage(
        `${flag} entries must not contain spaces; write ranges like 2-12 and separate frames with commas.`,
        {
          requested: value,
          segment,
        },
      );
    }

    const match = /^(\d+)(?:-(\d+))?$/.exec(segment);
    if (!match) {
      frameSpecUsage(`${flag} entries must be a frame number or an inclusive range like 2-12; received "${segment}".`, {
        requested: value,
        segment,
      });
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
      frameSpecUsage(`${flag} entries must use non-negative safe integers: "${segment}".`, {
        requested: value,
        segment,
      });
    }
    if (end < start) {
      frameSpecUsage(`${flag} range "${segment}" is descending; ranges must be ascending.`, {
        requested: value,
        range: segment,
      });
    }

    const count = end - start + 1;
    if (count > maximum) {
      frameSpecUsage(
        `${flag} range "${segment}" expands to ${count} frames; ${label} uses at most ${maximum} frames per invocation.`,
        { requested: value, range: segment, count, cap: maximum },
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

  if (frames.length > maximum) {
    frameSpecUsage(
      `${label} uses at most ${maximum} unique frames per invocation; the requested spec expands to ${frames.length}.`,
      { requested: value, count: frames.length, cap: maximum },
    );
  }

  return frames;
}

function contiguousRenderRange(frames: readonly number[]): { startFrame: number; endFrame: number } {
  const first = frames[0];
  if (first === undefined) {
    throw new FrameyardError("USAGE", "Video --frames requires at least one frame.");
  }
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index] !== first + index) {
      throw new FrameyardError(
        "USAGE",
        "Video --frames must be a contiguous range; use --sequence for arbitrary frame lists.",
        { details: { frames: [...frames] } },
      );
    }
  }
  return { startFrame: first, endFrame: first + frames.length };
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

async function runStill(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  assertOperationAllowed(policy, "still");
  if (parsed.flags.has("overwrite")) {
    assertOverwriteAllowed(policy, "overwrite");
  }
  const profile = resolveProfile(policy, flagString(parsed.flags, "profile"));
  if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
    lowerProcessPriority();
  }

  const project = await projectFromFlag(parsed.flags);
  await assertFontIntegrity(project.root, project.fonts, { hashes: true });
  const props = await readPropsFile(parsed.flags);
  const targetId = parsed.positionals[0] as string;
  const frameValue = parsed.flags.get("frame");
  if (typeof frameValue !== "string") {
    usage('"still" requires --frame <spec>.');
  }

  const frames = parseFrameSpec(frameValue);
  assertStillFrameLimit(policy, frames.length);
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

async function runRenderSequence(options: {
  project: Project;
  targetId: string;
  frames: number[];
  sequenceDir: string;
  props: unknown;
  overwrite: boolean;
  signal: AbortSignal;
  json: boolean;
}): Promise<number> {
  const outPaths = options.frames.map((frame) =>
    path.join(options.sequenceDir, `sequence-${options.targetId}-${frame}.png`),
  );

  let result:
    | {
        timeline: string;
        entry: string;
        frames: Array<{ frame: number; path: string }>;
        width: number;
        height: number;
        diagnostics: FrameyardDiagnostic[];
        elapsedMs: number;
      }
    | {
        composition: string;
        entry: string;
        frames: Array<{ frame: number; path: string }>;
        width: number;
        height: number;
        diagnostics: FrameyardDiagnostic[];
        elapsedMs: number;
      };

  if (options.project.timelines.has(options.targetId)) {
    if (options.props !== undefined && !isPlainObject(options.props)) {
      usage("Timeline --props must be a JSON object keyed by composition clip id.");
    }
    const stills = await captureTimelineStills({
      project: options.project,
      timelineId: options.targetId,
      frames: options.frames,
      outPaths,
      overwrite: options.overwrite,
      ...(options.props !== undefined ? { propsOverrides: options.props as Record<string, unknown> } : {}),
      signal: options.signal,
    });
    result = {
      timeline: stills.timeline,
      entry: stills.entry,
      frames: stills.frames,
      width: stills.width,
      height: stills.height,
      diagnostics: stills.diagnostics,
      elapsedMs: stills.elapsedMs,
    };
  } else {
    const stills = await captureStills({
      project: options.project,
      compositionId: options.targetId,
      frames: options.frames,
      outPaths,
      overwrite: options.overwrite,
      props: options.props,
      signal: options.signal,
    });
    result = {
      composition: stills.composition,
      entry: stills.entry,
      frames: stills.frames,
      width: stills.width,
      height: stills.height,
      diagnostics: stills.diagnostics,
      elapsedMs: stills.elapsedMs,
    };
  }

  const output = {
    ok: true,
    command: "render",
    kind: "sequence",
    ...result,
    path: options.sequenceDir,
    sequence: options.sequenceDir,
    scale: 1,
  };
  printDiagnostics(result.diagnostics);
  if (options.json) {
    printJson(output);
  } else {
    process.stdout.write(
      `Rendered ${result.frames.length} still${result.frames.length === 1 ? "" : "s"} for ${options.targetId} to ${options.sequenceDir}\n`,
    );
  }
  return 0;
}

async function runRender(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  const dryRun = parsed.flags.has("dry-run") === true;
  const profile = resolveProfile(policy, flagString(parsed.flags, "profile"));
  if (!dryRun) {
    assertOperationAllowed(policy, "render");
  }
  if (parsed.flags.has("overwrite")) {
    assertOverwriteAllowed(policy, "overwrite");
  }

  const project = await projectFromFlag(parsed.flags);
  await assertFontIntegrity(project.root, project.fonts, { hashes: true });
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
  const framesValue = flagString(parsed.flags, "frames");
  const frames =
    framesValue === undefined
      ? undefined
      : parseFrameSpec(framesValue, {
          flag: "--frames",
          label: "render",
          maximum: Number.MAX_SAFE_INTEGER,
        });
  const scaleValue = flagString(parsed.flags, "scale");
  const scale = validateRenderScale(scaleValue === undefined ? undefined : Number(scaleValue));
  const sequenceValue = flagString(parsed.flags, "sequence");
  const sequenceDir = sequenceValue === undefined ? undefined : path.resolve(process.cwd(), sequenceValue);

  if (sequenceDir !== undefined) {
    if (explicitOutPath !== undefined) {
      usage("--out is not valid with --sequence; use --sequence <dir>.");
    }
    if (frames === undefined) {
      usage("--sequence requires --frames <spec>.");
    }
    if (dryRun) {
      usage("--dry-run is not supported with --sequence.");
    }
    if (scale !== 1) {
      usage("--scale is not supported with --sequence; sequence output is full-size.");
    }
    for (const flag of ["container", "codec", "encoder", "concurrency", "workers", "scratch"]) {
      if (parsed.flags.has(flag)) {
        usage(`--${flag} is not valid with --sequence.`);
      }
    }
    return runRenderSequence({
      project,
      targetId,
      frames,
      sequenceDir,
      props,
      overwrite: parsed.flags.has("overwrite") === true,
      signal,
      json,
    });
  }

  const videoRange = frames === undefined ? undefined : contiguousRenderRange(frames);

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

    let effectiveWorkers = workers;
    if (profile === "shared-cpu") {
      if (workers !== undefined) {
        assertProfileLimit(profile, "workers", workers, SHARED_CPU_MAX_WORKERS);
      }
      effectiveWorkers = workers ?? SHARED_CPU_MAX_WORKERS;
    }

    if (dryRun) {
      const projectTimeline = project.timelines.get(targetId);
      if (!projectTimeline) {
        throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${targetId}" is not listed in fy.config.js.`);
      }
      const resolved = await resolveProjectTimeline({
        project,
        timeline: projectTimeline,
        ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
        signal,
      });
      const firstError = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (!resolved.timeline || firstError) {
        throw new FrameyardError(
          firstError?.code ?? "TIMELINE_INVALID",
          firstError?.message ?? "Timeline resolution failed.",
          { diagnostics: resolved.diagnostics },
        );
      }
      const lintResult = await lintResolvedTimeline({
        timeline: resolved.timeline,
        projectRoot: project.root,
        diagnostics: resolved.diagnostics,
        signal,
      });
      const lintError = lintResult.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (lintError) {
        throw new FrameyardError(lintError.code, lintError.message, { diagnostics: lintResult.diagnostics });
      }

      const planStart = videoRange?.startFrame ?? 0;
      const planEnd = videoRange?.endFrame ?? resolved.timeline.durationInFrames;
      if (planStart < 0 || planEnd > resolved.timeline.durationInFrames || planEnd <= planStart) {
        throw new FrameyardError(
          "FRAME_OUT_OF_RANGE",
          `Frame range ${planStart}..${planEnd - 1} is outside 0..${resolved.timeline.durationInFrames - 1}.`,
          {
            details: {
              validRange: { min: 0, max: resolved.timeline.durationInFrames - 1 },
              startFrame: planStart,
              endFrame: planEnd,
            },
          },
        );
      }
      const plan = planTimelineRender(resolved.timeline, { startFrame: planStart, endFrame: planEnd });
      const planWorkers = effectiveWorkers ?? 8;
      const planDetails = {
        kind: "video" as const,
        frames: planEnd - planStart,
        durationSeconds: (planEnd - planStart) / resolved.timeline.format.fps,
        frameRange: { start: planStart, end: planEnd - 1 },
        scale,
        segments: plan.segments.length,
        workers: planWorkers,
        encoder: encoder ?? "auto",
        codec,
        container,
        probed: false,
        ...(scratchDir !== undefined ? { scratch: scratchDir } : {}),
      };
      const outputExists = await pathExists(timelineOutPath);
      const blockers: DryRunBlocker[] = outputExists
        ? [
            {
              code: "OUTPUT_EXISTS",
              message: `Output already exists: ${timelineOutPath}.`,
              suggestion: policy.allowOverwrite
                ? "Pass --overwrite to replace it."
                : "Choose a new --out path or ask the user to run with FRAMEYARD_POLICY=full.",
            },
          ]
        : [];
      const prerequisites = collectPrerequisites(resolved.timeline);
      const args = ["render", targetId];
      if (outValue !== undefined) args.push("--out", outValue);
      const propsValue = flagString(parsed.flags, "props");
      if (propsValue !== undefined) args.push("--props", propsValue);
      args.push("--workers", String(planWorkers));
      if (framesValue !== undefined) args.push("--frames", framesValue);
      if (scaleValue !== undefined) args.push("--scale", scaleValue);
      if (encoder !== undefined) args.push("--encoder", encoder);
      args.push("--codec", codec, "--container", container);
      if (scratchValue !== undefined) args.push("--scratch", scratchValue);
      if (profile !== undefined) args.push("--profile", profile);
      if (parsed.flags.has("low-priority")) args.push("--low-priority");
      const prefix = policy.tier === "full" ? "" : "FRAMEYARD_POLICY=full ";
      const commandLine = prefix + handoffCommand(args);
      printDiagnostics(lintResult.diagnostics);
      if (json) {
        printJson({
          ok: true,
          command: "render",
          dryRun: true,
          deferred: true,
          policy: policyDetails(policy),
          ...(profile !== undefined ? { profile } : {}),
          plan: planDetails,
          commandLine,
          prerequisites,
          blockers,
          diagnostics: lintResult.diagnostics,
          output: { path: timelineOutPath, exists: outputExists },
        });
      } else {
        printDryRun("render", planDetails, commandLine, prerequisites, blockers);
      }
      return 0;
    }

    if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
      lowerProcessPriority();
    }

    const result = await renderTimeline({
      project,
      timelineId: targetId,
      outPath: timelineOutPath,
      ...(effectiveWorkers !== undefined ? { workers: effectiveWorkers } : {}),
      ...(scratchDir !== undefined ? { scratchDir } : {}),
      ...(encoder !== undefined ? { encoder } : {}),
      codec,
      container,
      ...(props !== undefined ? { propsOverrides: props as Record<string, unknown> } : {}),
      ...(videoRange !== undefined ? { startFrame: videoRange.startFrame, endFrame: videoRange.endFrame } : {}),
      scale,
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

  let effectiveConcurrency = concurrency;
  if (profile === "shared-cpu") {
    if (concurrency !== undefined) {
      assertProfileLimit(profile, "concurrency", concurrency, SHARED_CPU_MAX_CONCURRENCY);
    }
    effectiveConcurrency = concurrency ?? SHARED_CPU_MAX_CONCURRENCY;
  }

  if (dryRun) {
    const lintResult = await lintComposition({ project, compositionId, props, signal });
    const metadata = lintResult.metadata;
    const staticTarget = metadata.static === true;
    if (
      staticTarget &&
      (parsed.flags.has("concurrency") ||
        parsed.flags.has("container") ||
        parsed.flags.has("codec") ||
        parsed.flags.has("encoder") ||
        frames !== undefined ||
        scale !== 1)
    ) {
      usage(
        "A static composition render rejects --concurrency, --container, --codec, --encoder, --frames, and --scale.",
      );
    }
    const compositionOutPath =
      explicitOutPath ??
      path.join(
        project.root,
        "out",
        staticTarget ? `${compositionId}.png` : `${compositionId}.${CONTAINER_EXTENSION[container]}`,
      );
    const outputExists = await pathExists(compositionOutPath);
    const blockers: DryRunBlocker[] = outputExists
      ? [
          {
            code: "OUTPUT_EXISTS",
            message: `Output already exists: ${compositionOutPath}.`,
            suggestion: policy.allowOverwrite
              ? "Pass --overwrite to replace it."
              : "Choose a new --out path or ask the user to run with FRAMEYARD_POLICY=full.",
          },
        ]
      : [];
    const planStart = videoRange?.startFrame ?? 0;
    const planEnd = metadata.static === true ? 1 : (videoRange?.endFrame ?? metadata.durationInFrames);
    if (metadata.static !== true && (planStart < 0 || planEnd > metadata.durationInFrames || planEnd <= planStart)) {
      throw new FrameyardError(
        "FRAME_OUT_OF_RANGE",
        `Frame range ${planStart}..${planEnd - 1} is outside 0..${metadata.durationInFrames - 1}.`,
        {
          details: {
            validRange: { min: 0, max: metadata.durationInFrames - 1 },
            startFrame: planStart,
            endFrame: planEnd,
          },
        },
      );
    }
    const planDetails =
      metadata.static === true
        ? {
            kind: "image" as const,
            width: metadata.width,
            height: metadata.height,
            frames: 1,
            frameRange: { start: 0, end: 0 },
            scale: 1,
          }
        : {
            kind: "video" as const,
            frames: planEnd - planStart,
            durationSeconds: (planEnd - planStart) / metadata.fps,
            frameRange: { start: planStart, end: planEnd - 1 },
            scale,
            concurrency: effectiveConcurrency ?? 1,
            encoder: encoder ?? "auto",
            codec,
            container,
            probed: false,
          };
    const args = ["render", compositionId];
    if (outValue !== undefined) args.push("--out", outValue);
    const propsValue = flagString(parsed.flags, "props");
    if (propsValue !== undefined) args.push("--props", propsValue);
    if (!staticTarget) {
      if (framesValue !== undefined) args.push("--frames", framesValue);
      if (scaleValue !== undefined) args.push("--scale", scaleValue);
      args.push("--concurrency", String(effectiveConcurrency ?? 1));
      if (encoder !== undefined) args.push("--encoder", encoder);
      if (codecValue !== undefined) args.push("--codec", codecValue);
      if (containerValue !== undefined) args.push("--container", containerValue);
    }
    if (profile !== undefined) args.push("--profile", profile);
    if (parsed.flags.has("low-priority")) args.push("--low-priority");
    const prefix = policy.tier === "full" ? "" : "FRAMEYARD_POLICY=full ";
    const commandLine = prefix + handoffCommand(args);
    printDiagnostics(lintResult.diagnostics);
    if (json) {
      printJson({
        ok: true,
        command: "render",
        dryRun: true,
        deferred: true,
        policy: policyDetails(policy),
        ...(profile !== undefined ? { profile } : {}),
        plan: planDetails,
        commandLine,
        prerequisites: [],
        blockers,
        diagnostics: lintResult.diagnostics,
        output: { path: compositionOutPath, exists: outputExists },
      });
    } else {
      printDryRun("render", planDetails, commandLine, [], blockers);
    }
    return 0;
  }

  if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
    lowerProcessPriority();
  }

  const result = await renderComposition({
    project,
    compositionId,
    props,
    ...(explicitOutPath !== undefined ? { outPath: explicitOutPath } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(encoder !== undefined ? { encoder } : {}),
    ...(codecValue !== undefined ? { codec: codecValue } : {}),
    ...(containerValue !== undefined ? { container: containerValue } : {}),
    ...(videoRange !== undefined ? { startFrame: videoRange.startFrame, endFrame: videoRange.endFrame } : {}),
    scale,
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

async function runTts(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  const dryRun = parsed.flags.has("dry-run") === true;
  const profile = resolveProfile(policy, flagString(parsed.flags, "profile"));
  if (!dryRun) {
    assertOperationAllowed(policy, "tts");
  }
  if (parsed.flags.has("force")) {
    assertOverwriteAllowed(policy, "force");
  }

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

  const outPath = path.resolve(process.cwd(), outValue);
  const force = parsed.flags.has("force") === true;
  const manifestPath = resolveManifestPath(projectRoot, flagString(parsed.flags, "manifest"));

  if (dryRun) {
    if (text.trim().length === 0) {
      throw new FrameyardError("TTS_FAILED", "Speech synthesis requires non-empty text.");
    }
    if (!outPath.toLowerCase().endsWith(".wav")) {
      throw new FrameyardError("TTS_FAILED", `Speech output must use a .wav extension: ${outPath}`);
    }
    const executableValue = flagString(parsed.flags, "executable");
    const prerequisites =
      engine === "supertonic"
        ? [
            {
              label: "Supertonic model directory",
              path: path.resolve(process.cwd(), flagString(parsed.flags, "model-dir") as string),
              directory: true,
            },
            ...(executableValue !== undefined ? [{ label: "TTS executable", path: executableValue }] : []),
          ]
        : [
            {
              label: "talker model",
              path: path.resolve(process.cwd(), flagString(parsed.flags, "talker-model") as string),
            },
            {
              label: "codec model",
              path: path.resolve(process.cwd(), flagString(parsed.flags, "codec-model") as string),
            },
            ...(executableValue !== undefined ? [{ label: "TTS executable", path: executableValue }] : []),
          ];
    const blockers = await prerequisiteBlockers(prerequisites);
    if (engine === "supertonic") {
      try {
        await resolveSupertonicModelFiles(path.resolve(process.cwd(), flagString(parsed.flags, "model-dir") as string));
      } catch (error) {
        blockers.push({
          code: isFrameyardError(error) ? error.code : "TTS_FAILED",
          message: errorMessage(error),
          suggestion: "Check --model-dir and the seven Supertonic model files.",
        });
      }
    }
    const outputExists = await pathExists(outPath);
    if (outputExists) {
      blockers.push({
        code: "OUTPUT_EXISTS",
        message: `Output already exists: ${outPath}.`,
        suggestion: policy.allowOverwrite
          ? "Pass --force to replace it."
          : "Choose a new --out path or ask the user to run with FRAMEYARD_POLICY=full.",
      });
    }
    const plan = {
      kind: "tts" as const,
      engine,
      speaker,
      textCharacters: text.length,
      out: outPath,
      manifest: manifestPath,
      probed: false,
    };
    const args = process.argv.slice(2).filter((argument) => argument !== "--dry-run" && argument !== "--json");
    const prefix = policy.tier === "full" ? "" : "FRAMEYARD_POLICY=full ";
    const commandLine = prefix + handoffCommand(args);
    if (json) {
      printJson({
        ok: true,
        command: "tts",
        dryRun: true,
        deferred: true,
        policy: policyDetails(policy),
        ...(profile !== undefined ? { profile } : {}),
        plan,
        commandLine,
        prerequisites: prerequisites.map((item) => item.path),
        blockers,
        output: { path: outPath, exists: outputExists },
      });
    } else {
      printDryRun(
        "tts",
        plan,
        commandLine,
        prerequisites.map((item) => item.path),
        blockers,
      );
    }
    return 0;
  }

  if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
    lowerProcessPriority();
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
          outPath,
          ...(flagString(parsed.flags, "executable") !== undefined
            ? { executable: flagString(parsed.flags, "executable") as string }
            : {}),
          ...(flagString(parsed.flags, "manifest") !== undefined
            ? { manifestPath: flagString(parsed.flags, "manifest") as string }
            : {}),
          force,
          signal,
        })
      : await synthesizeSpeech({
          engine: "qwen",
          projectRoot,
          text,
          speaker,
          talkerModelPath: path.resolve(process.cwd(), flagString(parsed.flags, "talker-model") as string),
          codecModelPath: path.resolve(process.cwd(), flagString(parsed.flags, "codec-model") as string),
          outPath,
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
          force,
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

async function runTranscribe(parsed: ParsedArgs, signal: AbortSignal, policy: LoadedResourcePolicy): Promise<number> {
  const dryRun = parsed.flags.has("dry-run") === true;
  const profile = resolveProfile(policy, flagString(parsed.flags, "profile"));
  if (!dryRun) {
    assertOperationAllowed(policy, "transcribe");
  }
  if (parsed.flags.has("force")) {
    assertOverwriteAllowed(policy, "force");
  }

  const projectRoot = await assetRootFromFlag(parsed.flags);
  const json = parsed.flags.has("json") === true;
  const outValue = flagString(parsed.flags, "out");
  const modelValue = flagString(parsed.flags, "model");
  if (!outValue || !modelValue) {
    usage('"transcribe" requires --out and --model.');
  }

  const outPath = path.resolve(process.cwd(), outValue);
  const sourcePath = path.resolve(process.cwd(), parsed.positionals[0] as string);
  const modelPath = path.resolve(process.cwd(), modelValue);
  const formats = parseSubtitleFormats(parsed.flags.get("export"));
  const exports = formats.map((format) => ({
    format,
    path: `${outPath.toLowerCase().endsWith(".json") ? outPath.slice(0, -5) : outPath}.${format}`,
  }));
  const force = parsed.flags.has("force") === true;
  const manifestPath = resolveManifestPath(projectRoot, flagString(parsed.flags, "manifest"));

  if (dryRun) {
    if (!outPath.toLowerCase().endsWith(".json")) {
      throw new FrameyardError("TRANSCRIPT_INVALID", `Transcript output must use a .json extension: ${outPath}`);
    }
    const executableValue = flagString(parsed.flags, "executable");
    const prerequisites = [
      { label: "transcription source", path: sourcePath },
      { label: "Whisper model", path: modelPath },
      ...(executableValue !== undefined ? [{ label: "transcribe executable", path: executableValue }] : []),
    ];
    const blockers = await prerequisiteBlockers(prerequisites);
    for (const destination of [outPath, ...exports.map((entry) => entry.path)]) {
      if (await pathExists(destination)) {
        blockers.push({
          code: "OUTPUT_EXISTS",
          message: `Output already exists: ${destination}.`,
          suggestion: policy.allowOverwrite
            ? "Pass --force to replace it."
            : "Choose a new --out path or ask the user to run with FRAMEYARD_POLICY=full.",
        });
      }
    }
    const plan = {
      kind: "transcribe" as const,
      source: sourcePath,
      model: modelPath,
      words: parsed.flags.has("words") === true,
      exports: formats,
      out: outPath,
      manifest: manifestPath,
      probed: false,
    };
    const args = process.argv.slice(2).filter((argument) => argument !== "--dry-run" && argument !== "--json");
    const prefix = policy.tier === "full" ? "" : "FRAMEYARD_POLICY=full ";
    const commandLine = prefix + handoffCommand(args);
    if (json) {
      printJson({
        ok: true,
        command: "transcribe",
        dryRun: true,
        deferred: true,
        policy: policyDetails(policy),
        ...(profile !== undefined ? { profile } : {}),
        plan,
        commandLine,
        prerequisites: prerequisites.map((item) => item.path),
        blockers,
        output: { path: outPath, exists: await pathExists(outPath) },
        exports,
      });
    } else {
      printDryRun(
        "transcribe",
        plan,
        commandLine,
        prerequisites.map((item) => item.path),
        blockers,
      );
    }
    return 0;
  }

  if (shouldLowerPriority(policy, profile, parsed.flags.has("low-priority") === true)) {
    lowerProcessPriority();
  }

  const result = await transcribeAudio({
    projectRoot,
    sourcePath,
    outPath,
    modelPath,
    words: parsed.flags.has("words") === true,
    exports: formats,
    ...(flagString(parsed.flags, "language") !== undefined
      ? { language: flagString(parsed.flags, "language") as string }
      : {}),
    ...(flagString(parsed.flags, "executable") !== undefined
      ? { executable: flagString(parsed.flags, "executable") as string }
      : {}),
    ...(flagString(parsed.flags, "manifest") !== undefined
      ? { manifestPath: flagString(parsed.flags, "manifest") as string }
      : {}),
    force,
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
  let policy: LoadedResourcePolicy | undefined;
  let policyError: FrameyardError | undefined;
  try {
    policy = await loadResourcePolicy({ cwd: process.cwd(), env: process.env });
  } catch (error) {
    if (isFrameyardError(error) && error.code === "POLICY_INVALID") {
      policyError = error;
    } else {
      throw error;
    }
  }

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

  const policyReport =
    policy !== undefined
      ? { status: "ok" as const, ...policyDetails(policy) }
      : {
          status: "error" as const,
          code: policyError?.code ?? "POLICY_INVALID",
          detail: policyError?.message ?? "Resource policy could not be loaded.",
        };
  const resources = {
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    loadAverage: loadavg(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
  const report = { ...result, policy: policyReport, resources };

  if (json) {
    printJson({ ok: true, command: "doctor", ...report });
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
    const fontDetail = result.fonts.detail ? ` — ${result.fonts.detail}` : "";
    process.stdout.write(
      `${result.fonts.valid ? "✓" : "✗"} fonts: ${result.fonts.exists ? `${result.fonts.fonts} installed, ${result.fonts.files} files, ${result.fonts.bytes} bytes` : "none"}${fontDetail}\n`,
    );
    if (policyReport.status === "ok") {
      process.stdout.write(
        `✓ policy: ${policyReport.policy}${policyReport.profile ? `, ${policyReport.profile}` : ""}, still ≤${policyReport.maxStillFrames}, ${policyReport.allowOverwrite ? "overwrite allowed" : "overwrite blocked"} (${policyReport.source})\n`,
      );
    } else {
      process.stdout.write(`✗ policy: ${policyReport.detail}\n`);
    }
    process.stdout.write(
      `resources: ${resources.cpus} cpus, load ${resources.loadAverage.map((value) => value.toFixed(2)).join(" ")}, ${(resources.totalMemoryBytes / 1024 ** 3).toFixed(1)} GB RAM\n`,
    );
    process.stdout.write(`\ndoctor: ${result.healthy ? "healthy" : "problems found"}\n`);
  }
  return result.healthy ? 0 : 1;
}

function reportFailure(error: unknown, command: string, jsonRequested: boolean, signal?: AbortSignal): number {
  const aborted = signal?.aborted === true;
  const cancelled = aborted || (isFrameyardError(error) && error.code === "CANCELLED");
  const code = cancelled ? "CANCELLED" : isFrameyardError(error) ? error.code : "INTERNAL";
  const message = aborted ? "Operation cancelled." : error instanceof Error ? error.message : String(error);

  const details = isFrameyardError(error) ? error.details : undefined;
  const diagnostics = isFrameyardError(error) ? error.diagnostics : undefined;
  const fix = isFrameyardError(error)
    ? (error.fix ??
      diagnostics?.find((diagnostic) => diagnostic.fix !== undefined)?.fix ??
      diagnosticFix(error.code, details, message))
    : undefined;
  if (jsonRequested) {
    printJson({
      ok: false,
      command: command || null,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        ...(fix !== undefined ? { fix } : {}),
      },
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    });
  }
  process.stderr.write(`${cancelled ? "Cancelled" : `error [${code}]`}${cancelled ? "" : `: ${message}`}\n`);
  if (diagnostics !== undefined) {
    printDiagnostics(diagnostics);
  }

  if (!aborted && !isFrameyardError(error) && process.env.FRAMEYARD_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ""}\n`);
  }

  if (cancelled) {
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
    const needsPolicy = !["doctor", "inspect", "compare", "add", "explain"].includes(parsed.command);
    const policy = needsPolicy ? await loadResourcePolicy({ cwd: process.cwd(), env: process.env }) : undefined;

    switch (parsed.command) {
      case "context":
        return await runContext(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "lint":
        return await runLint(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "check":
        return await runCheck(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "still":
        return await runStill(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "inspect":
        return await runInspect(parsed);
      case "compare":
        return await runCompare(parsed);
      case "render":
        return await runRender(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "tts":
        return await runTts(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "transcribe":
        return await runTranscribe(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "font":
        return await runFont(parsed, controller.signal, policy as LoadedResourcePolicy);
      case "add":
        return await runAdd(parsed);
      case "explain":
        return runExplain(parsed);
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
