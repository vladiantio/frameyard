import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { FrameyardError } from "../errors.js";

/** Fails early with an actionable error when an input file is missing or unreadable. */
export async function assertReadableFile(filePath: string, label: string): Promise<number> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new FrameyardError("ASSET_NOT_FOUND", `${label} does not exist: ${filePath}`);
  }
  if (!info.isFile()) {
    throw new FrameyardError("ASSET_NOT_FOUND", `${label} is not a file: ${filePath}`);
  }
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new FrameyardError("ASSET_NOT_FOUND", `${label} is not readable: ${filePath}`);
  }
  return info.size;
}

export function requireExtension(filePath: string, extension: string, label: string): void {
  if (path.extname(filePath).toLowerCase() !== extension) {
    throw new FrameyardError("USAGE", `${label} must use a ${extension} extension: ${filePath}`);
  }
}
