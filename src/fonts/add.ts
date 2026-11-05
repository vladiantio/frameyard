import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishStagedFiles, temporaryPath } from "../assets/provenance.js";
import { FrameyardError } from "../errors.js";
import { hasFontMagic } from "./binary.js";
import {
  fontAssetDirectory,
  fontManifestPath,
  readFontManifest,
  resolveFontAssetPath,
  stageFontManifest,
} from "./manifest.js";
import { fontFormatForPath, fontSlug, formatFontWeight, safeFontFileName } from "./options.js";
import { parseFontManifest } from "./schema.js";
import { summarizeFont, type FontSummary } from "./summary.js";
import {
  FONT_ASSET_PREFIX,
  emptyFontManifest,
  type FontFamily,
  type FontFile,
  type FontManifest,
  type FontStyle,
  type FontWeight,
} from "./types.js";

const FONT_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface AddLocalFontOptions {
  projectRoot: string;
  manifest?: FontManifest;
  file: string;
  family: string;
  id?: string;
  weight: FontWeight;
  style: FontStyle;
  subset?: string;
  unicodeRange?: string;
  license?: string;
  licenseFile?: string;
  force: boolean;
}

export interface AddLocalFontResult {
  font: FontSummary;
  manifest: string;
  files: string[];
  warnings: Array<{ code: string; message: string }>;
  next: string[];
}

function faceKey(file: FontFile): string {
  return `${file.subset ?? ""}\0${file.style}\0${formatFontWeight(file.weight)}`;
}

function sortManifest(manifest: FontManifest): FontManifest {
  const fonts = [...manifest.fonts]
    .sort((left, right) => left.family.localeCompare(right.family))
    .map((font) => ({
      ...font,
      files: [...font.files].sort((left, right) => left.path.localeCompare(right.path)),
    }));
  return { version: manifest.version, fonts };
}

function faceKeyFor(weight: FontWeight, style: FontStyle, subset?: string): string {
  return `${subset ?? ""}\0${style}\0${formatFontWeight(weight)}`;
}

function destinationName(sourcePath: string, weight: FontWeight, style: FontStyle, subset?: string): string {
  const base = safeFontFileName(sourcePath);
  const extension = base.slice(base.lastIndexOf("."));
  const stem = base.slice(0, base.lastIndexOf("."));
  return `${stem}-${subset ?? "default"}-${style}-${formatFontWeight(weight)}${extension}`;
}
function pathInFontDirectory(id: string, fileName: string): string {
  return `${FONT_ASSET_PREFIX}${id}/${fileName}`;
}

export async function addLocalFont(options: AddLocalFontOptions): Promise<AddLocalFontResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const sourcePath = path.resolve(process.cwd(), options.file);
  let sourceInfo;
  try {
    sourceInfo = await stat(sourcePath);
  } catch {
    throw new FrameyardError("FONT_FILE_MISSING", `Font file does not exist: ${sourcePath}`);
  }
  if (!sourceInfo.isFile()) {
    throw new FrameyardError("FONT_FILE_INVALID", `Font path is not a regular file: ${sourcePath}`);
  }

  const bytes = await readFile(sourcePath);
  if (bytes.length === 0) {
    throw new FrameyardError("FONT_FILE_INVALID", `Font file is empty: ${sourcePath}`);
  }
  const format = fontFormatForPath(sourcePath);
  if (!hasFontMagic(format, bytes)) {
    throw new FrameyardError("FONT_FILE_INVALID", `Font file does not have a valid ${format} signature: ${sourcePath}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = options.id ?? fontSlug(options.family);
  if (!FONT_ID.test(id)) {
    throw new FrameyardError(
      "FONT_MANIFEST_INVALID",
      `Font id "${id}" must use lowercase letters, digits, and hyphens, starting with a letter or digit.`,
    );
  }

  const manifest = options.manifest ?? (await readFontManifest(projectRoot)) ?? emptyFontManifest();
  const records = manifest.fonts.map((font) => ({
    ...font,
    license: { ...font.license },
    files: font.files.map((file) => ({ ...file, weight: file.weight })),
  }));
  const existingIndex = records.findIndex(
    (font) => font.id === id || font.family.toLocaleLowerCase("en-US") === options.family.toLocaleLowerCase("en-US"),
  );
  const existing = existingIndex === -1 ? undefined : records[existingIndex];

  if (existing !== undefined && existing.provider !== "local" && !options.force) {
    throw new FrameyardError(
      "OUTPUT_EXISTS",
      `Font "${existing.family}" is already installed from provider "${existing.provider}". Pass --force to replace it.`,
    );
  }
  if (
    existing !== undefined &&
    (existing.id !== id || existing.family.toLocaleLowerCase("en-US") !== options.family.toLocaleLowerCase("en-US")) &&
    !options.force
  ) {
    throw new FrameyardError(
      "OUTPUT_EXISTS",
      `Font id "${id}" or family "${options.family}" conflicts with the installed font "${existing.id}" (${existing.family}). Pass --force to replace it.`,
    );
  }

  const desiredFace = faceKeyFor(options.weight, options.style, options.subset);
  const baseName = safeFontFileName(sourcePath);
  const basePath = pathInFontDirectory(id, baseName);
  const collision = records.some(
    (font) => font.id === id && font.files.some((file) => file.path === basePath && faceKey(file) !== desiredFace),
  );
  const filePath = pathInFontDirectory(
    id,
    collision ? destinationName(sourcePath, options.weight, options.style, options.subset) : baseName,
  );
  const fileRecord: FontFile = {
    path: filePath,
    ...(options.subset !== undefined ? { subset: options.subset } : {}),
    style: options.style,
    weight: options.weight,
    format,
    ...(options.unicodeRange !== undefined ? { unicodeRange: options.unicodeRange } : {}),
    sha256,
    bytes: bytes.length,
  };

  const warnings: Array<{ code: string; message: string }> = [];
  const sameFamily =
    existing !== undefined &&
    existing.id === id &&
    existing.family.toLocaleLowerCase("en-US") === options.family.toLocaleLowerCase("en-US");
  let license = options.license ?? (sameFamily && existing !== undefined ? existing.license.type : "unknown");
  let licenseFileRelative = sameFamily && existing !== undefined ? existing.license.file : undefined;
  if (options.licenseFile !== undefined) {
    const licenseSource = path.resolve(process.cwd(), options.licenseFile);
    let licenseInfo;
    try {
      licenseInfo = await stat(licenseSource);
    } catch {
      throw new FrameyardError("FONT_LICENSE_MISSING", `License file does not exist: ${licenseSource}`);
    }
    if (!licenseInfo.isFile()) {
      throw new FrameyardError("FONT_LICENSE_MISSING", `License path is not a regular file: ${licenseSource}`);
    }
    licenseFileRelative = pathInFontDirectory(id, "LICENSE.txt");
  }
  if (license === "unknown") {
    warnings.push({
      code: "FONT_LICENSE_MISSING",
      message: `Font "${options.family}" has no known license. Add --license before redistributing the project.`,
    });
  } else if (licenseFileRelative === undefined) {
    warnings.push({
      code: "FONT_LICENSE_MISSING",
      message: `Font "${options.family}" records license "${license}" but no license file. Add --license-file to vendor it.`,
    });
  }

  let replacedPaths: string[] = [];
  if (existing === undefined || existing.provider !== "local" || existing.id !== id) {
    const record: FontFamily = {
      id,
      family: options.family,
      provider: "local",
      license: {
        type: license,
        ...(licenseFileRelative !== undefined ? { file: licenseFileRelative } : {}),
      },
      ...(typeof options.weight === "number" ? {} : { variable: true }),
      files: [fileRecord],
    };
    if (existingIndex === -1) {
      records.push(record);
    } else {
      replacedPaths = existing?.files.map((file) => file.path) ?? [];
      records[existingIndex] = record;
    }
  } else {
    const existingFileIndex = existing.files.findIndex((file) => faceKey(file) === faceKey(fileRecord));
    if (existingFileIndex !== -1 && !options.force) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Font face ${options.style} ${formatFontWeight(options.weight)} in subset "${options.subset ?? "default"}" is already installed for "${existing.family}". Pass --force to replace it.`,
      );
    }
    if (existingFileIndex !== -1) {
      const replaced = existing.files[existingFileIndex];
      if (replaced !== undefined) {
        replacedPaths.push(replaced.path);
      }
      existing.files[existingFileIndex] = fileRecord;
    } else {
      existing.files.push(fileRecord);
    }
    existing.license = {
      ...existing.license,
      type: license,
      ...(licenseFileRelative !== undefined ? { file: licenseFileRelative } : {}),
    };
    if (typeof options.weight !== "number") {
      existing.variable = true;
    }
  }

  const nextManifest = sortManifest({ version: manifest.version, fonts: records });
  parseFontManifest(nextManifest);

  const fontDirectory = fontAssetDirectory(projectRoot, id);
  await mkdir(fontDirectory, { recursive: true });
  const absoluteFilePath = resolveFontAssetPath(projectRoot, fileRecord.path);
  const staged: Array<{ tempPath: string; path: string; label: string; overwrite?: boolean }> = [];
  const fontTemp = temporaryPath(absoluteFilePath, "font");
  await writeFile(fontTemp, bytes);
  staged.push({ tempPath: fontTemp, path: absoluteFilePath, label: `font ${fileRecord.path}` });

  if (options.licenseFile !== undefined && licenseFileRelative !== undefined) {
    const licenseBytes = await readFile(path.resolve(process.cwd(), options.licenseFile));
    const absoluteLicensePath = resolveFontAssetPath(projectRoot, licenseFileRelative);
    const licenseTemp = temporaryPath(absoluteLicensePath, "license");
    await writeFile(licenseTemp, licenseBytes);
    staged.push({
      tempPath: licenseTemp,
      path: absoluteLicensePath,
      label: `license ${licenseFileRelative}`,
      overwrite: true,
    });
  }

  const manifestTemp = await stageFontManifest(projectRoot, nextManifest);
  staged.push({
    tempPath: manifestTemp,
    path: fontManifestPath(projectRoot),
    label: "font manifest",
    overwrite: true,
  });

  await publishStagedFiles(staged, { force: options.force });

  for (const replacedPath of replacedPaths) {
    if (replacedPath !== fileRecord.path) {
      await rm(resolveFontAssetPath(projectRoot, replacedPath), { force: true });
    }
  }

  const installed = nextManifest.fonts.find((font) => font.id === id);
  if (installed === undefined) {
    throw new FrameyardError("INTERNAL", `Font "${id}" was not found after publication.`);
  }

  return {
    font: summarizeFont(installed),
    manifest: fontManifestPath(projectRoot),
    files: installed.files.map((file) => file.path),
    warnings,
    next: [
      `Use font-family: "${installed.family}", system-ui, sans-serif`,
      "npx frameyard font verify --json",
      "npx frameyard context --json",
    ],
  };
}

export interface RemoveFontResult {
  id: string;
  family: string;
  manifest: string;
  files: string[];
  keptFiles: boolean;
}

export async function removeFont(options: {
  projectRoot: string;
  manifest?: FontManifest;
  id: string;
  keepFiles: boolean;
}): Promise<RemoveFontResult> {
  const manifest = options.manifest;
  if (manifest === undefined) {
    throw new FrameyardError("FONT_NOT_FOUND", `No fonts are installed in this project.`);
  }
  const index = manifest.fonts.findIndex((font) => font.id === options.id);
  if (index === -1) {
    throw new FrameyardError("FONT_NOT_FOUND", `Font "${options.id}" is not installed.`);
  }
  const removed = manifest.fonts[index] as FontFamily;
  const fonts = manifest.fonts.filter((font) => font.id !== options.id);
  const nextManifest: FontManifest = { version: manifest.version, fonts };
  const removedFiles = removed.files.map((file) => file.path);

  if (fonts.length === 0) {
    await rm(fontManifestPath(options.projectRoot), { force: true });
  } else {
    const manifestTemp = await stageFontManifest(options.projectRoot, nextManifest);
    await publishStagedFiles(
      [
        {
          tempPath: manifestTemp,
          path: fontManifestPath(options.projectRoot),
          label: "font manifest",
          overwrite: true,
        },
      ],
      { force: true },
    );
  }

  if (!options.keepFiles) {
    await rm(fontAssetDirectory(options.projectRoot, options.id), { recursive: true, force: true });
  }

  return {
    id: removed.id,
    family: removed.family,
    manifest: fontManifestPath(options.projectRoot),
    files: removedFiles,
    keptFiles: options.keepFiles,
  };
}
