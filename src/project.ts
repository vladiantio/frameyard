import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FrameyardError } from "./errors.js";
import { isPlainObject } from "./contracts.js";

export type CompositionKind = "html";
export type TimelineKind = "timeline";

export interface ProjectFormat {
  width: number;
  height: number;
  fps: number;
}

export interface ProjectComposition {
  id: string;
  /** Forward-slash relative path from the project root, without a leading "./". */
  entry: string;
  absoluteEntry: string;
  kind: CompositionKind;
}

export interface ProjectTimeline {
  id: string;
  /** Forward-slash relative path from the project root, without a leading "./". */
  entry: string;
  absoluteEntry: string;
  kind: TimelineKind;
}

export interface Project {
  root: string;
  configPath: string;
  format?: ProjectFormat;
  compositions: Map<string, ProjectComposition>;
  timelines: Map<string, ProjectTimeline>;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Walks up from a directory until it finds video.config.js. */
export async function resolveProjectRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);

  try {
    if (!(await stat(current)).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    throw new FrameyardError("CONFIG_NOT_FOUND", `Project directory does not exist: ${current}`);
  }

  while (true) {
    if (await isFile(path.join(current, "video.config.js"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FrameyardError(
        "CONFIG_NOT_FOUND",
        `No video.config.js found from ${path.resolve(start)} upward. Run inside a Frameyard project or pass --project.`,
      );
    }
    current = parent;
  }
}

function normalizeFormat(value: unknown): ProjectFormat {
  if (!isPlainObject(value)) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js format must be an object with width, height, and fps.");
  }

  const { width, height, fps } = value;
  if (!Number.isInteger(width) || (width as number) <= 0) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js format.width must be a positive integer.");
  }
  if (!Number.isInteger(height) || (height as number) <= 0) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js format.height must be a positive integer.");
  }
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js format.fps must be a positive number.");
  }

  return { width: width as number, height: height as number, fps };
}

function entryPath(
  root: string,
  id: string,
  entryValue: unknown,
  extension: string,
): { entry: string; absoluteEntry: string } {
  if (typeof entryValue !== "string" || entryValue.length === 0) {
    throw new FrameyardError("CONFIG_INVALID", `Entry "${id}" must be a non-empty string.`);
  }

  const entry = entryValue.replaceAll("\\", "/");
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    throw new FrameyardError("CONFIG_INVALID", `Entry "${id}" must be relative to the project root.`);
  }

  const absoluteEntry = path.resolve(root, entry);
  if (absoluteEntry !== root && !absoluteEntry.startsWith(root + path.sep)) {
    throw new FrameyardError("CONFIG_INVALID", `Entry "${id}" escapes the project root: ${entryValue}`);
  }
  if (path.extname(absoluteEntry).toLowerCase() !== extension) {
    throw new FrameyardError("CONFIG_INVALID", `Entry "${id}" must be a ${extension} file: ${entryValue}`);
  }

  return { entry: path.relative(root, absoluteEntry).split(path.sep).join("/"), absoluteEntry };
}

/** Loads video.config.js and validates its explicit composition and timeline entries. */
export async function loadProject(projectRoot: string): Promise<Project> {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, "video.config.js");

  if (!(await isFile(configPath))) {
    throw new FrameyardError("CONFIG_NOT_FOUND", `No video.config.js found in ${root}.`);
  }

  let configModule: { default?: unknown };
  try {
    const url = pathToFileURL(configPath);
    url.searchParams.set("mtime", String((await stat(configPath)).mtimeMs));
    configModule = (await import(url.href)) as { default?: unknown };
  } catch (error) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      `Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const config = configModule.default;
  if (!isPlainObject(config)) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js must default-export a configuration object.");
  }

  const rawCompositions = config.compositions;
  const rawTimelines = config.timelines;
  if (rawCompositions === undefined && rawTimelines === undefined) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js must contain a compositions or timelines object.");
  }
  if (rawCompositions !== undefined && !isPlainObject(rawCompositions)) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js must contain a compositions object.");
  }
  if (rawTimelines !== undefined && !isPlainObject(rawTimelines)) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js timelines must be an object.");
  }

  const format = config.format === undefined ? undefined : normalizeFormat(config.format);
  const compositions = new Map<string, ProjectComposition>();
  const timelines = new Map<string, ProjectTimeline>();
  const ids = new Set<string>();

  for (const [id, rawEntry] of Object.entries(rawCompositions ?? {})) {
    if (!PROJECT_ID.test(id)) {
      throw new FrameyardError(
        "CONFIG_INVALID",
        `Invalid composition id "${id}". Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.`,
      );
    }
    if (ids.has(id)) {
      throw new FrameyardError("CONFIG_INVALID", `Project id "${id}" is used by more than one entry.`);
    }

    const location = entryPath(root, id, rawEntry, ".html");
    if (!(await isFile(location.absoluteEntry))) {
      throw new FrameyardError("CONFIG_INVALID", `Composition "${id}" entry does not exist: ${String(rawEntry)}`);
    }

    ids.add(id);
    compositions.set(id, { id, ...location, kind: "html" });
  }

  for (const [id, rawEntry] of Object.entries(rawTimelines ?? {})) {
    if (!PROJECT_ID.test(id)) {
      throw new FrameyardError(
        "CONFIG_INVALID",
        `Invalid timeline id "${id}". Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.`,
      );
    }
    if (ids.has(id)) {
      throw new FrameyardError("CONFIG_INVALID", `Project id "${id}" is used by more than one entry.`);
    }

    const location = entryPath(root, id, rawEntry, ".json");
    if (!(await isFile(location.absoluteEntry))) {
      throw new FrameyardError("CONFIG_INVALID", `Timeline "${id}" entry does not exist: ${String(rawEntry)}`);
    }

    ids.add(id);
    timelines.set(id, { id, ...location, kind: "timeline" });
  }

  if (compositions.size === 0 && timelines.size === 0) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js must list at least one composition or timeline.");
  }
  if (timelines.size > 0 && !format) {
    throw new FrameyardError(
      "CONFIG_INVALID",
      "video.config.js must declare format { width, height, fps } when it lists timelines.",
    );
  }

  return {
    root,
    configPath,
    ...(format ? { format } : {}),
    compositions,
    timelines,
  };
}
