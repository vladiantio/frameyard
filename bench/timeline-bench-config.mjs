import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const defaultTimelineBenchRoot = path.join(repoRoot, "out", "bench", "timeline");

const VALUE_FLAGS = new Set(["work", "project", "output", "scratch", "source-project", "workers"]);
const BOOLEAN_FLAGS = new Set(["video-1080", "copy-video"]);

/**
 * Shared argument parser for the timeline benchmarks.
 *
 * The scripts default to generated directories under
 * `out/bench/timeline/`, which is gitignored. Point `--output` and/or
 * `--scratch` at a larger disk for long runs.
 */
export function parseTimelineBenchArgs(argv) {
  const options = {
    work: null,
    project: null,
    output: null,
    scratch: null,
    sourceProject: null,
    workers: null,
    help: false,
    video1080: false,
    copyVideo: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unknown argument "${argument}".`);
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) {
        throw new Error(`--${name} does not take a value.`);
      }
      if (name === "video-1080") options.video1080 = true;
      else options.copyVideo = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
    let value = equals === -1 ? undefined : argument.slice(equals + 1);
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") {
      throw new Error(`--${name} requires a value.`);
    }

    if (name === "source-project") {
      options.sourceProject = value;
    } else if (name === "workers") {
      options.workers = Number(value);
    } else {
      options[name] = value;
    }
  }

  if (options.workers !== null && (!Number.isInteger(options.workers) || options.workers < 1)) {
    throw new Error("--workers must be a positive integer.");
  }
  return options;
}

export function printTimelineBenchOptions(command, extra = "") {
  process.stdout.write(`Usage: node bench/${command} [options]

Options:
  --work <dir>            Base directory for generated projects and outputs
  --project <dir>         Existing generated project to use
  --source-project <dir>  Project to copy or reuse
  --output <dir>          Artifact output directory (use a larger disk for long runs)
  --scratch <dir>         Intermediate directory (defaults to the output directory)
  --workers <n>           Segment worker count where supported
  --video-1080            Representative benchmark: use a 1080p looped media source
  --copy-video            Representative benchmark: stream-copy video-only segments
  -h, --help              Show this help
${extra}`);
}
