import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { FrameyardError } from "../errors.js";

export interface ResolvedExecutable {
  /** The default command name, such as "qwen-tts". */
  command: string;
  /** Absolute path to the executable that will be used. */
  path: string;
  source: "option" | "environment" | "path";
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return false;
    }
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function pathCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return path.extname(command) ? [command] : extensions.map((extension) => `${command}${extension}`);
}

async function findOnPath(command: string, cwd: string): Promise<string | undefined> {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    for (const candidate of pathCandidates(command)) {
      const absolute = path.resolve(cwd, entry, candidate);
      if (await isExecutable(absolute)) {
        return absolute;
      }
    }
  }
  return undefined;
}

/** Resolves an integration executable: explicit option, environment, then PATH. */
export async function resolveExecutable(options: {
  command: string;
  explicit?: string;
  envVar: string;
  cwd?: string;
  installHint: string;
}): Promise<ResolvedExecutable> {
  const cwd = options.cwd ?? process.cwd();
  const configured = options.explicit ?? process.env[options.envVar];
  const source: ResolvedExecutable["source"] =
    options.explicit !== undefined ? "option" : process.env[options.envVar] !== undefined ? "environment" : "path";

  if (configured !== undefined) {
    const absolute = hasPathSeparator(configured) ? path.resolve(cwd, configured) : await findOnPath(configured, cwd);
    if (absolute && (await isExecutable(absolute))) {
      return { command: options.command, path: absolute, source };
    }
    const sourceLabel = source === "environment" ? ` in ${options.envVar}` : "";
    throw new FrameyardError(
      "EXECUTABLE_NOT_FOUND",
      `Could not find an executable at "${configured}"${sourceLabel}. ${options.installHint}`,
    );
  }

  const fromPath = await findOnPath(options.command, cwd);
  if (fromPath) {
    return { command: options.command, path: fromPath, source: "path" };
  }

  throw new FrameyardError(
    "EXECUTABLE_NOT_FOUND",
    `${options.command} was not found on PATH. ${options.installHint} You can also pass --executable or set ${options.envVar}.`,
  );
}
