import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FrameyardError } from "../errors.js";
import { temporaryPath } from "../assets/provenance.js";
import { parseFontManifest } from "./schema.js";
import {
  FONT_ASSET_PREFIX,
  FONT_MANIFEST_FILENAME,
  emptyFontManifest,
  type FontFamily,
  type FontManifest,
} from "./types.js";

export function fontManifestPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), FONT_MANIFEST_FILENAME);
}

export function fontAssetDirectory(projectRoot: string, id: string): string {
  return path.join(path.resolve(projectRoot), FONT_ASSET_PREFIX, id);
}

export function resolveFontAssetPath(projectRoot: string, relativePath: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new FrameyardError("FONT_MANIFEST_INVALID", `Font asset path escapes the project root: ${relativePath}`);
  }
  return absolute;
}

/** Reads and schema-validates the manifest. A missing manifest is not an error. */
export async function readFontManifest(projectRoot: string): Promise<FontManifest | undefined> {
  const manifestPath = fontManifestPath(projectRoot);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new FrameyardError(
      "FONT_MANIFEST_INVALID",
      `Could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { path: manifestPath } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new FrameyardError(
      "FONT_MANIFEST_INVALID",
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { path: manifestPath } },
    );
  }

  try {
    return parseFontManifest(parsed);
  } catch (error) {
    if (error instanceof FrameyardError) {
      throw new FrameyardError(error.code, `${manifestPath}: ${error.message}`, {
        cause: error,
        ...(error.details !== undefined ? { details: { path: manifestPath, ...(error.details as object) } } : {}),
      });
    }
    throw error;
  }
}

export async function readFontManifestIfPresent(projectRoot: string): Promise<FontManifest> {
  return (await readFontManifest(projectRoot)) ?? emptyFontManifest();
}

/** Writes a validated manifest to a temporary sibling file for atomic publication. */
export async function stageFontManifest(projectRoot: string, manifest: FontManifest): Promise<string> {
  parseFontManifest(manifest);
  const manifestPath = fontManifestPath(projectRoot);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = temporaryPath(manifestPath, "fonts");
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return tempPath;
}

export interface FontManifestSummary {
  fonts: number;
  files: number;
  bytes: number;
}

export function summarizeFontManifest(manifest: FontManifest | undefined): FontManifestSummary {
  let files = 0;
  let bytes = 0;
  for (const font of manifest?.fonts ?? []) {
    files += font.files.length;
    for (const file of font.files) {
      bytes += file.bytes;
    }
  }
  return { fonts: manifest?.fonts.length ?? 0, files, bytes };
}

export function uniqueFontValues(font: FontFamily): { subsets: string[]; styles: string[] } {
  const subsets = new Set<string>();
  const styles = new Set<string>();
  for (const file of font.files) {
    if (file.subset !== undefined) {
      subsets.add(file.subset);
    }
    styles.add(file.style);
  }
  return { subsets: [...subsets].sort(), styles: [...styles].sort() };
}

export async function fontManifestExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(fontManifestPath(projectRoot))).isFile();
  } catch {
    return false;
  }
}
