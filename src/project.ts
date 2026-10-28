import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FrameyardError } from "./errors.js";
import { isPlainObject } from "./contracts.js";

export interface ProjectComposition {
  id: string;
  /** Forward-slash relative path from the project root, without a leading "./". */
  entry: string;
  absoluteEntry: string;
}

export interface Project {
  root: string;
  configPath: string;
  compositions: Map<string, ProjectComposition>;
}

const COMPOSITION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/** Loads video.config.js and validates its explicitly listed composition entries. */
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

  const entries = config.compositions;
  if (!isPlainObject(entries)) {
    throw new FrameyardError("CONFIG_INVALID", "video.config.js must contain a compositions object.");
  }

  const compositions = new Map<string, ProjectComposition>();

  for (const [id, rawEntry] of Object.entries(entries)) {
    if (!COMPOSITION_ID.test(id)) {
      throw new FrameyardError(
        "CONFIG_INVALID",
        `Invalid composition id "${id}". Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.`,
      );
    }
    if (typeof rawEntry !== "string" || rawEntry.length === 0) {
      throw new FrameyardError("CONFIG_INVALID", `Composition "${id}" entry must be a non-empty string.`);
    }

    const entry = rawEntry.replaceAll("\\", "/");
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
      throw new FrameyardError("CONFIG_INVALID", `Composition "${id}" entry must be relative to the project root.`);
    }

    const absoluteEntry = path.resolve(root, entry);
    if (absoluteEntry !== root && !absoluteEntry.startsWith(root + path.sep)) {
      throw new FrameyardError("CONFIG_INVALID", `Composition "${id}" entry escapes the project root: ${rawEntry}`);
    }
    if (!(await isFile(absoluteEntry))) {
      throw new FrameyardError("CONFIG_INVALID", `Composition "${id}" entry does not exist: ${rawEntry}`);
    }

    compositions.set(id, {
      id,
      entry: path.relative(root, absoluteEntry).split(path.sep).join("/"),
      absoluteEntry,
    });
  }

  return { root, configPath, compositions };
}
