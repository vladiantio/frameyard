import { defineCommand, parseArgs, renderUsage, type ArgDef, type ArgsDef, type CommandDef } from "citty";
import { FrameyardError } from "../errors.js";
import { VERSION } from "../version.js";

/**
 * Declarative command and argument metadata for the CLI.
 *
 * citty parses the raw tokens and renders usage; command routing and the
 * command-specific cross-flag validation live in `src/cli.ts`.
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

export interface CliCommandSpec {
  readonly summary: string;
  /** Prose printed after citty's generated usage block. */
  readonly details?: string;
  readonly args: ArgsDef;
}

const HELP: ArgDef = { type: "boolean", alias: "h", description: "Show help." };
const VERSION_ARG: ArgDef = { type: "boolean", alias: "v", description: "Print the version." };

const PROJECT: ArgDef = {
  type: "string",
  valueHint: "DIR",
  description: "Use a project other than the current directory.",
};
const JSON_ARG: ArgDef = {
  type: "boolean",
  description: "Print a structured JSON result to stdout.",
};
const PROPS: ArgDef = {
  type: "string",
  valueHint: "FILE",
  description: 'Composition props, or a { "<clip-id>": {...} } override map for a timeline.',
};
const PROFILE: ArgDef = {
  type: "string",
  valueHint: "NAME",
  description: "Resource profile for shared machines; shared-cpu caps workers at 2 and concurrency at 1.",
};
const LOW_PRIORITY: ArgDef = {
  type: "boolean",
  description: "Lower process priority without changing worker caps.",
};
const OUT: ArgDef = {
  type: "string",
  valueHint: "PATH",
  description: "Output path for still, render, tts, transcribe, asset add, or font add --file/--url.",
};
const MANIFEST: ArgDef = {
  type: "string",
  valueHint: "FILE",
  description: "Provenance manifest path (default: fy.assets.json).",
};
const DRY_RUN: ArgDef = {
  type: "boolean",
  description: "Validate and print the plan and handoff command without doing heavy work.",
};
const FORCE: ArgDef = {
  type: "boolean",
  description: "Replace existing generated assets when the resource policy allows it.",
};
const OVERWRITE: ArgDef = {
  type: "boolean",
  description: "Replace existing still or render output when the resource policy allows it.",
};
const EXECUTABLE: ArgDef = {
  type: "string",
  valueHint: "PATH",
  description: "Explicit qwen-tts, sherpa-onnx-offline-tts, or whisper-cli executable.",
};
const LANGUAGE: ArgDef = {
  type: "string",
  valueHint: "LANG",
  description: "Spoken or transcription language.",
};

function global(args: ArgsDef, extra: ArgsDef = {}): ArgsDef {
  return { ...args, ...extra, help: HELP, version: VERSION_ARG };
}

export const COMMAND_SPECS = {
  init: {
    summary: "Scaffold a minimal Frameyard project.",
    args: global({
      directory: {
        type: "positional",
        description: "Target directory; without one, init prompts for a project name.",
        required: false,
      },
      json: JSON_ARG,
      "local-models": {
        type: "boolean",
        description: "Also install the optional local-model host scaffold.",
      },
    }),
    details:
      "Without a directory, init asks for a project name (default: my-video) and creates that directory; non-interactive and --json runs use the default. --local-models also installs the optional policy, OpenCode, and Pi scaffold.",
  },
  dev: {
    summary: "Start the browser preview server.",
    args: global({
      project: PROJECT,
      port: {
        type: "string",
        valueHint: "PORT",
        description: "Preview server port between 0 and 65535 (default: 5173; 0 picks a free port).",
      },
    }),
    details: "Press Ctrl+C to stop the server.",
  },
  context: {
    summary: "Print a compact project digest.",
    args: global({ project: PROJECT, json: JSON_ARG }),
    details:
      "Print the format, composition metadata, prop types, timeline clips, assets, fonts, diagnostics, active policy, and next commands. It never launches Chromium.",
  },
  lint: {
    summary: "Validate documents, timelines, and controllers without Chromium.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      props: PROPS,
      target: {
        type: "positional",
        description: "Composition or timeline id.",
        required: true,
      },
    }),
    details:
      "Run static validation, timeline resolution, scene and keyframe projection for every timeline frame, and a controller determinism scan. It does not run validateProps or capture frames; use check for the full gate.",
  },
  check: {
    summary: "Validate props, assets, audio, and every frame without encoding.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      props: PROPS,
      profile: PROFILE,
      "low-priority": LOW_PRIORITY,
      "no-progress": {
        type: "boolean",
        description: "Suppress check progress on stderr.",
      },
      target: {
        type: "positional",
        description: "Composition or timeline id.",
        required: true,
      },
    }),
    details: "The authoring policy lowers process priority for check. No frames are captured or encoded.",
  },
  still: {
    summary: "Capture one or more frames as PNGs.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      props: PROPS,
      out: OUT,
      frame: {
        type: "string",
        valueHint: "SPEC",
        description: "n, n-m, or a comma-separated list (maximum 32 unique frames).",
      },
      overwrite: OVERWRITE,
      profile: PROFILE,
      "low-priority": LOW_PRIORITY,
      target: {
        type: "positional",
        description: "Composition or timeline id.",
        required: true,
      },
    }),
    details:
      "Capture through the production rendering path. With one frame, --out is a .png file; with multiple frames, --out is a directory. A static composition exposes only frame 0.",
  },
  inspect: {
    summary: "Inspect a decoded image.",
    args: global({
      json: JSON_ARG,
      image: { type: "positional", description: "Image path.", required: true },
    }),
    details:
      "Report dimensions, alpha coverage, blank detection, background and dominant colors, content bbox, a coarse luminance grid, and edge density. It never launches Chromium.",
  },
  compare: {
    summary: "Compare two decoded images pixel by pixel.",
    args: global({
      json: JSON_ARG,
      first: { type: "positional", description: "First image path.", required: true },
      second: { type: "positional", description: "Second image path.", required: true },
    }),
    details:
      "Compare by pixel and by 3×3 region. Exits 1 when the images differ; the JSON result still has ok: true and identical: false.",
  },
  render: {
    summary: "Render a composition or timeline to video, PNG, or a PNG sequence.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      props: PROPS,
      out: OUT,
      frames: {
        type: "string",
        valueHint: "SPEC",
        description: "n, n-m, or a comma-separated list; video requires a contiguous range.",
      },
      scale: {
        type: "string",
        valueHint: "FACTOR",
        description: "Encode-time scale from 0.25 to 1; output stays even-sized.",
      },
      sequence: {
        type: "string",
        valueHint: "DIR",
        description: "Write PNG frames instead of video; requires --frames and is full-size only.",
      },
      concurrency: {
        type: "string",
        valueHint: "N",
        description: "Parallel browser sessions for animated composition render, 1-16 (default: 1).",
      },
      workers: {
        type: "string",
        valueHint: "N",
        description: "Parallel segment workers for timeline render, 1-16 (default: 8).",
      },
      encoder: {
        type: "string",
        valueHint: "NAME",
        description: "Encoder: auto, software, nvenc, or qsv (default: auto).",
      },
      codec: {
        type: "string",
        valueHint: "NAME",
        description: "Delivery codec: h264, hevc, or vp9 (default: h264; vp9 for webm).",
      },
      container: {
        type: "string",
        valueHint: "NAME",
        description: "Delivery container: mp4, mov, mkv, or webm (default: mp4).",
      },
      scratch: {
        type: "string",
        valueHint: "DIR",
        description: "Scratch directory for timeline intermediates (default: system temp).",
      },
      overwrite: OVERWRITE,
      "dry-run": DRY_RUN,
      profile: PROFILE,
      "low-priority": LOW_PRIORITY,
      "no-progress": {
        type: "boolean",
        description: "Suppress render progress on stderr.",
      },
      target: {
        type: "positional",
        description: "Composition or timeline id.",
        required: true,
      },
    }),
    details:
      "The default output is out/<id>.<extension> for video and out/<id>.png for a static composition. --frames accepts n, n-m, or a comma list; video requires a contiguous range, while --sequence accepts arbitrary lists and requires --frames. --scale is 0.25-1 and scales during encode; output dimensions stay even. Encoder choices are auto, software, nvenc, and qsv; auto probes NVENC, then Quick Sync, then the codec's software encoder. WebM and VP9 use Opus audio, and HEVC in MP4/MOV keeps the hvc1 sample entry. A static composition rejects --concurrency, --container, --codec, --encoder, --frames, and --scale. With --dry-run, validates and prints the plan and handoff command without writing outputs or launching Chromium.",
  },
  tts: {
    summary: "Synthesize speech with a local engine.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      "text-file": {
        type: "string",
        valueHint: "FILE",
        description: "Text to synthesize. Reads stdin when omitted.",
      },
      speaker: {
        type: "string",
        valueHint: "VALUE",
        description: "Named speaker for qwen, or the numeric speaker id for Supertonic.",
      },
      engine: {
        type: "string",
        valueHint: "NAME",
        description: "Speech engine: qwen or supertonic (default: qwen).",
      },
      "model-dir": {
        type: "string",
        valueHint: "DIR",
        description: "Supertonic model directory from the sherpa-onnx archive.",
      },
      "talker-model": {
        type: "string",
        valueHint: "GGUF",
        description: "Talker GGUF model path for qwen.",
      },
      "codec-model": {
        type: "string",
        valueHint: "GGUF",
        description: "Codec GGUF model path for qwen.",
      },
      out: OUT,
      style: {
        type: "string",
        valueHint: "TEXT",
        description: "Optional qwen style instruction.",
      },
      language: {
        type: "string",
        valueHint: "LANG",
        description: "Spoken language; Supertonic requires one of its 31 upstream language codes.",
      },
      device: {
        type: "string",
        valueHint: "NAME",
        description: "Compute device for qwen-tts, such as CPU or CUDA0.",
      },
      executable: EXECUTABLE,
      manifest: MANIFEST,
      force: FORCE,
      "dry-run": DRY_RUN,
      profile: PROFILE,
      "low-priority": LOW_PRIORITY,
    }),
    details:
      "Produce one frozen 24 kHz mono WAV with local qwentts.cpp CustomVoice or sherpa-onnx Supertonic 3 synthesis. Supertonic language codes: ar, bg, cs, da, de, el, en, es, et, fi, fr, hi, hr, hu, id, it, ja, ko, lt, lv, nl, pl, pt, ro, ru, sk, sl, sv, tr, uk, vi. With --dry-run, validates inputs and prints the plan and command without loading a model.",
  },
  transcribe: {
    summary: "Transcribe audio with whisper.cpp.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      out: OUT,
      model: {
        type: "string",
        valueHint: "GGUF",
        description: "Whisper GGML model path.",
      },
      words: {
        type: "boolean",
        description: "Request measured word timings during transcription.",
      },
      export: {
        type: "string",
        valueHint: "FORMATS",
        description: "Derived subtitle exports next to the transcript (srt,vtt).",
      },
      language: LANGUAGE,
      executable: EXECUTABLE,
      manifest: MANIFEST,
      force: FORCE,
      "dry-run": DRY_RUN,
      profile: PROFILE,
      "low-priority": LOW_PRIORITY,
      source: { type: "positional", description: "Audio or video source path.", required: true },
    }),
    details:
      "Produce a canonical Frameyard transcript, optionally with word timings and subtitle exports. With --dry-run, validates inputs and prints the plan and command without loading a model.",
  },
  add: {
    summary: "Install a template, recipe, or scaffold.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      template: {
        type: "string",
        valueHint: "NAME",
        description: "Template for add composition|timeline: static-poster, title-card, lower-third, or slideshow.",
      },
      list: { type: "boolean", description: "List add templates, recipes, and scaffolds." },
      id: {
        type: "string",
        valueHint: "ID",
        description: "Project id for add recipe.",
      },
      kind: {
        type: "positional",
        description: "composition, timeline, recipe, or local-models.",
        required: false,
      },
      entry: { type: "positional", description: "Project id or recipe id.", required: false },
    }),
    details:
      "Forms:\n  frameyard add --list\n  frameyard add local-models\n  frameyard add <composition|timeline> <id> --template <name>\n  frameyard add recipe <recipe-id> --id <project-id>\nWrite a valid template entry and print the exact fy.config.js registration snippet, or install the optional local-model host scaffold. Templates are static-poster, title-card, lower-third, and slideshow. The command refuses to overwrite an existing file or an already registered id.",
  },
  asset: {
    summary: "Download a remote asset into the project.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      out: OUT,
      sha256: {
        type: "string",
        valueHint: "HASH",
        description: "Expected SHA-256 for --url or asset add; the computed hash is always recorded.",
      },
      manifest: MANIFEST,
      force: FORCE,
      action: { type: "positional", description: "The add action.", required: false },
      url: {
        type: "positional",
        description: "HTTPS asset URL (loopback HTTP is allowed for tests).",
        required: false,
      },
    }),
    details:
      "Download an HTTPS image, video, or audio asset into the project, verify its SHA-256, and record it in fy.assets.json. --force replaces an existing destination and requires the full policy tier.",
  },
  font: {
    summary: "Search, install, verify, and remove project fonts.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      file: {
        type: "string",
        valueHint: "FILE",
        description: "Local font file for font add: .woff2, .woff, .ttf, or .otf.",
      },
      family: {
        type: "string",
        valueHint: "NAME",
        description: "CSS font-family name or alias for font add.",
      },
      id: {
        type: "string",
        valueHint: "ID",
        description: "Font manifest id for font add --file/--url.",
      },
      weight: {
        type: "string",
        valueHint: "VALUE",
        description: "Font weight or variable range; comma-separated weights for Fontsource --static.",
      },
      style: {
        type: "string",
        valueHint: "VALUE",
        description: "normal or italic (comma list for Fontsource).",
      },
      subset: {
        type: "string",
        valueHint: "NAME",
        description: "Font subset label; comma-separated for Fontsource.",
      },
      "unicode-range": {
        type: "string",
        valueHint: "RANGE",
        description: "CSS unicode-range for a local or URL font face.",
      },
      license: {
        type: "string",
        valueHint: "ID",
        description: "License identifier for --file/--url; warns when omitted.",
      },
      "license-file": {
        type: "string",
        valueHint: "FILE",
        description: "Copy a license file into the font directory.",
      },
      category: {
        type: "string",
        valueHint: "NAME",
        description: "Fontsource category filter for font search.",
      },
      limit: {
        type: "string",
        valueHint: "N",
        description: "Fontsource result limit for font search, 1-100 (default: 20).",
      },
      url: {
        type: "string",
        valueHint: "URL",
        description: "Download a font from HTTPS (loopback HTTP is allowed for tests).",
      },
      sha256: {
        type: "string",
        valueHint: "HASH",
        description: "Expected SHA-256 for --url.",
      },
      static: {
        type: "boolean",
        description: "Install static Fontsource weights instead of the variable face.",
      },
      variable: {
        type: "boolean",
        description: "Fontsource search filter: only variable fonts.",
      },
      force: FORCE,
      "keep-files": {
        type: "boolean",
        description: "Keep font files when removing a font from the manifest.",
      },
      action: {
        type: "positional",
        description: "search, add, list, verify, or remove.",
        required: false,
      },
      value: {
        type: "positional",
        description: "Search query, Fontsource id, or font id.",
        required: false,
      },
    }),
    details:
      "Forms:\n  frameyard font search [query] [--category <name>] [--subset <name>] [--style normal|italic] [--variable] [--limit <n>]\n  frameyard font add <fontsource-id> [--family <alias>] [--subset <name>] [--style normal|italic] [--weight <n>] [--static] [--force]\n  frameyard font add --file <path> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--subset <name>] [--unicode-range <range>] [--license <id>] [--license-file <path>] [--force]\n  frameyard font add --url <https-url> --family <name> [--id <id>] [--weight <n|n-n>] [--style normal|italic] [--subset <name>] [--unicode-range <range>] [--license <id>] [--license-file <path>] [--sha256 <hash>] [--force]\n  frameyard font list|verify\n  frameyard font remove <id> [--keep-files]\nSearch Fontsource, vendor a Fontsource/local/URL font into assets/fonts/<id>/, and manage fy.fonts.json. The server serves the generated @font-face sheet at /__frameyard/fonts.css. Project policy allows search/list/verify everywhere, add in authoring and full, and remove or --force only in full. A --url import without --license also requires full.",
  },
  doctor: {
    summary: "Inspect the environment and optional integrations.",
    args: global({
      project: PROJECT,
      json: JSON_ARG,
      manifest: MANIFEST,
      "qwen-tts": { type: "string", valueHint: "PATH", description: "qwen-tts executable to inspect." },
      "sherpa-onnx-tts": {
        type: "string",
        valueHint: "PATH",
        description: "sherpa-onnx-offline-tts executable to inspect.",
      },
      "whisper-cli": {
        type: "string",
        valueHint: "PATH",
        description: "whisper-cli executable to inspect.",
      },
      "talker-model": {
        type: "string",
        valueHint: "GGUF",
        description: "Talker GGUF model path for qwen.",
      },
      "codec-model": {
        type: "string",
        valueHint: "GGUF",
        description: "Codec GGUF model path for qwen.",
      },
      "model-dir": {
        type: "string",
        valueHint: "DIR",
        description: "Supertonic model directory to inspect.",
      },
      model: {
        type: "string",
        valueHint: "GGUF",
        description: "Whisper GGML model path.",
      },
    }),
    details:
      "Inspect core requirements, optional integrations, model readability, and provenance integrity without changing the environment.",
  },
  explain: {
    summary: "Explain a diagnostic code.",
    args: global({
      json: JSON_ARG,
      list: { type: "boolean", description: "List every diagnostic code with a short summary." },
      code: { type: "positional", description: "Diagnostic code.", required: false },
    }),
    details:
      "Print the cause, a minimal failing example, the corrected example, and a documentation link. Fixes are advisory and are never applied automatically.",
  },
  help: {
    summary: "Show help for Frameyard or a command.",
    args: global({
      command: { type: "positional", description: "Command to describe.", required: false },
    }),
    details: "Run frameyard help <command> or frameyard <command> --help for options specific to a command.",
  },
} satisfies Record<string, CliCommandSpec>;

export type CommandName = keyof typeof COMMAND_SPECS;

export const COMMAND_NAMES: ReadonlySet<string> = new Set(Object.keys(COMMAND_SPECS));

function commandSpec(name: string): CliCommandSpec | undefined {
  return Object.hasOwn(COMMAND_SPECS, name) ? (COMMAND_SPECS[name as CommandName] as CliCommandSpec) : undefined;
}

const COMMAND_DEFS: Record<string, CommandDef<any>> = Object.fromEntries(
  Object.entries(COMMAND_SPECS).map(([name, spec]) => [
    name,
    defineCommand({
      meta: { name, description: spec.summary },
      args: spec.args,
    }),
  ]),
);

/** Union of every named argument, used when no command token is present. */
const ALL_ARGS: ArgsDef = (() => {
  const args: ArgsDef = {};
  for (const spec of Object.values(COMMAND_SPECS)) {
    for (const [name, definition] of Object.entries(spec.args)) {
      if (definition.type === "positional" || Object.hasOwn(args, name)) continue;
      args[name] = definition;
    }
  }
  args.help = HELP;
  args.version = VERSION_ARG;
  return args;
})();

const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(
  Object.entries(ALL_ARGS)
    .filter(([, definition]) => definition.type === "string")
    .map(([name]) => name),
);

export const ROOT_COMMAND = defineCommand({
  meta: {
    name: "frameyard",
    version: VERSION,
    description: "Local-first, deterministic video compositions authored with HTML, CSS, and JavaScript.",
  },
  args: { help: HELP, version: VERSION_ARG },
  subCommands: COMMAND_DEFS,
});

function usage(message: string): never {
  throw new FrameyardError("USAGE", message);
}

/**
 * Finds the command token without mistaking a value flag's argument for the
 * command. Everything after `--` is positional, matching the router contract.
 */
export function findCommand(argv: readonly string[]): { command: string; index: number } {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      break;
    }
    if (argument.startsWith("--")) {
      const name = argument.slice(2).split("=")[0] as string;
      if (VALUE_FLAG_NAMES.has(name) && !argument.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return { command: argument, index };
  }
  return { command: "", index: -1 };
}

/** Best-effort command name for error envelopes, even when parsing fails. */
export function inferCommand(argv: readonly string[]): string {
  return findCommand(argv).command;
}

function namedArgs(args: ArgsDef): ArgsDef {
  return Object.fromEntries(Object.entries(args).filter(([, definition]) => definition.type !== "positional"));
}

function validateTokens(tokens: readonly string[], argsDef: ArgsDef): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--") {
      return;
    }
    if (token === "-h" || token === "-v") {
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const definition = Object.hasOwn(argsDef, name) ? argsDef[name] : undefined;
      if (definition === undefined || definition.type === "positional") {
        usage(`Unknown option --${name}.`);
      }
      if (definition.type === "boolean") {
        if (equals !== -1) {
          usage(`Option --${name} does not take a value.`);
        }
        continue;
      }
      if (equals !== -1) {
        if (token.slice(equals + 1) === "") {
          usage(`Option --${name} requires a value.`);
        }
        continue;
      }
      index += 1;
      if (tokens[index] === undefined || tokens[index] === "") {
        usage(`Option --${name} requires a value.`);
      }
      continue;
    }
    if (token.startsWith("-")) {
      usage(`Unknown option ${token}.`);
    }
  }
}

/**
 * Parses tokens with citty after validating option shapes and removing the
 * command token. Unknown commands fall back to the union definition so the
 * router can report `Unknown command` with a useful command name.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const { command, index } = findCommand(argv);
  const spec = command === "" ? undefined : commandSpec(command);
  const argsDef = spec?.args ?? ALL_ARGS;
  const rawTokens = index === -1 ? [...argv] : [...argv.slice(0, index), ...argv.slice(index + 1)];

  // citty treats `--no-*` as boolean negation, so the explicit
  // `--no-progress` switch is removed here and kept as a positive flag.
  const flags = new Map<string, string | true>();
  const supportsNoProgress = Object.hasOwn(argsDef, "no-progress");
  const tokens: string[] = [];
  let raw = false;
  for (const token of rawTokens) {
    if (raw) {
      tokens.push(token);
      continue;
    }
    if (token === "--") {
      raw = true;
      tokens.push(token);
      continue;
    }
    if (token === "--no-progress" && supportsNoProgress) {
      flags.set("no-progress", true);
      continue;
    }
    tokens.push(token);
  }

  validateTokens(tokens, argsDef);
  const parsed = parseArgs(tokens, namedArgs(argsDef));

  for (const [name, definition] of Object.entries(argsDef)) {
    if (definition.type === "positional") {
      continue;
    }
    const value = parsed[name];
    if (typeof value === "string") {
      flags.set(name, value);
    } else if (value === true) {
      flags.set(name, true);
    }
  }

  return { command, positionals: [...parsed._], flags };
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Removes ANSI styling from citty's usage text when the terminal does not support it. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

async function renderedUsage(command: CommandDef<any>, color: boolean, parent?: CommandDef<any>): Promise<string> {
  const usage = await renderUsage(command, parent);
  return color ? usage : stripAnsi(usage);
}

export async function renderRootHelp(color: boolean): Promise<string> {
  const usage = await renderedUsage(ROOT_COMMAND, color);
  return `${usage}

Common options: --project <dir>, --json, --help, --version.

Resource policy: the nearest fy.policy.json from the working directory upward sets light, authoring, or full; FRAMEYARD_POLICY overrides it. tts, transcribe, and render are blocked outside full. font add requires authoring or full; font remove and font add --force require full. Use --dry-run to validate and produce a handoff command without doing heavy work.`;
}

export async function renderCommandHelp(command: string, color: boolean): Promise<string> {
  const spec = commandSpec(command);
  const definition = Object.hasOwn(COMMAND_DEFS, command) ? COMMAND_DEFS[command] : undefined;
  if (spec === undefined || definition === undefined) {
    return renderRootHelp(color);
  }
  const usage = await renderedUsage(definition, color, ROOT_COMMAND);
  return spec.details === undefined ? usage : `${usage}\n\n${spec.details}`;
}
