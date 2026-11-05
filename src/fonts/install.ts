import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishStagedFiles, temporaryPath } from "../assets/provenance.js";
import { FrameyardError } from "../errors.js";
import { fontAssetDirectory, fontManifestPath, resolveFontAssetPath, stageFontManifest } from "./manifest.js";
import { parseFontManifest } from "./schema.js";
import type { FontFamily, FontFile, FontManifest, FontWeight } from "./types.js";

export interface FontPayload {
  /** Project-relative path below assets/fonts/<font-id>/. */
  path: string;
  bytes: Buffer;
  /** License files may be refreshed while adding another face. */
  overwrite?: boolean;
}

export interface InstallFontRecordOptions {
  projectRoot: string;
  manifest: FontManifest;
  incoming: FontFamily;
  payloads: FontPayload[];
  force: boolean;
}

export interface InstallFontRecordResult {
  manifest: FontManifest;
  family: FontFamily;
  replacedFiles: string[];
}

export function fontFaceKey(file: FontFile): string {
  return `${file.subset ?? ""}\0${file.style}\0${fontWeightKey(file.weight)}`;
}

function fontWeightKey(weight: FontWeight): string {
  return typeof weight === "number" ? String(weight) : `${weight.min}-${weight.max}`;
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

function cloneManifest(manifest: FontManifest): FontManifest {
  return {
    version: manifest.version,
    fonts: manifest.fonts.map((font) => ({
      ...font,
      license: { ...font.license },
      ...(font.axes !== undefined ? { axes: { ...font.axes } } : {}),
      files: font.files.map((file) => ({ ...file, weight: file.weight })),
    })),
  };
}

function mergeFamily(
  manifest: FontManifest,
  incoming: FontFamily,
  force: boolean,
): { manifest: FontManifest; family: FontFamily; replacedFiles: string[] } {
  const fonts = cloneManifest(manifest).fonts;
  const existingIndex = fonts.findIndex(
    (font) =>
      font.id === incoming.id || font.family.toLocaleLowerCase("en-US") === incoming.family.toLocaleLowerCase("en-US"),
  );
  const existing = existingIndex === -1 ? undefined : fonts[existingIndex];
  const replacedFiles: string[] = [];

  if (existing === undefined) {
    fonts.push(incoming);
    return { manifest: { version: manifest.version, fonts }, family: incoming, replacedFiles };
  }

  const sameFamily =
    existing.id === incoming.id &&
    existing.family.toLocaleLowerCase("en-US") === incoming.family.toLocaleLowerCase("en-US");
  if (!sameFamily || existing.provider !== incoming.provider) {
    if (!force) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Font id "${incoming.id}" or family "${incoming.family}" is already installed as "${existing.provider}". Pass --force to replace it.`,
      );
    }
    replacedFiles.push(...existing.files.map((file) => file.path));
    fonts[existingIndex] = incoming;
    return { manifest: { version: manifest.version, fonts }, family: incoming, replacedFiles };
  }

  const variableMismatch = (existing.variable === true) !== (incoming.variable === true);
  if (variableMismatch) {
    if (!force) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Font "${existing.family}" is already installed as ${existing.variable === true ? "variable" : "static"}. Pass --force to replace it with ${incoming.variable === true ? "variable" : "static"} files.`,
      );
    }
    replacedFiles.push(...existing.files.map((file) => file.path));
    fonts[existingIndex] = incoming;
    return { manifest: { version: manifest.version, fonts }, family: incoming, replacedFiles };
  }

  for (const file of incoming.files) {
    const index = existing.files.findIndex((candidate) => fontFaceKey(candidate) === fontFaceKey(file));
    if (index !== -1 && !force) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Font face ${file.style} ${fontWeightKey(file.weight)} in subset "${file.subset ?? "default"}" is already installed for "${existing.family}". Pass --force to replace it.`,
      );
    }
    if (index !== -1) {
      const replaced = existing.files[index];
      if (replaced !== undefined) {
        replacedFiles.push(replaced.path);
      }
      existing.files[index] = file;
    } else {
      existing.files.push(file);
    }
  }

  existing.license = {
    ...existing.license,
    type:
      incoming.license.type === "unknown" && existing.license.type !== "unknown"
        ? existing.license.type
        : incoming.license.type,
    ...(incoming.license.file !== undefined ? { file: incoming.license.file } : {}),
    ...(incoming.license.attribution !== undefined ? { attribution: incoming.license.attribution } : {}),
  };
  if (incoming.variable === true) {
    existing.variable = true;
  }
  if (incoming.axes !== undefined) {
    existing.axes = { ...existing.axes, ...incoming.axes };
  }

  return { manifest: { version: manifest.version, fonts }, family: existing, replacedFiles };
}

/** Merges a family record, stages every payload, and publishes the manifest atomically. */
export async function installFontRecord(options: InstallFontRecordOptions): Promise<InstallFontRecordResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const merged = mergeFamily(options.manifest, options.incoming, options.force);
  const nextManifest = sortManifest(merged.manifest);
  parseFontManifest(nextManifest);

  const payloadByPath = new Map(options.payloads.map((payload) => [payload.path, payload]));
  for (const file of options.incoming.files) {
    if (!payloadByPath.has(file.path)) {
      throw new FrameyardError("INTERNAL", `Missing staged payload for font file ${file.path}.`);
    }
  }
  if (options.incoming.license.file !== undefined && !payloadByPath.has(options.incoming.license.file)) {
    try {
      await stat(resolveFontAssetPath(projectRoot, options.incoming.license.file));
    } catch {
      throw new FrameyardError("INTERNAL", `Missing staged payload for license ${options.incoming.license.file}.`);
    }
  }

  await mkdir(fontAssetDirectory(projectRoot, merged.family.id), { recursive: true });
  const staged: Array<{ tempPath: string; path: string; label: string; overwrite?: boolean }> = [];
  for (const payload of options.payloads) {
    const absolute = resolveFontAssetPath(projectRoot, payload.path);
    const tempPath = temporaryPath(absolute, "font-asset");
    await writeFile(tempPath, payload.bytes);
    staged.push({
      tempPath,
      path: absolute,
      label: `font asset ${payload.path}`,
      ...(payload.overwrite === true ? { overwrite: true } : {}),
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

  for (const replaced of merged.replacedFiles) {
    if (!merged.family.files.some((file) => file.path === replaced)) {
      await rm(resolveFontAssetPath(projectRoot, replaced), { force: true });
    }
  }

  return {
    manifest: nextManifest,
    family: nextManifest.fonts.find((font) => font.id === merged.family.id) ?? merged.family,
    replacedFiles: merged.replacedFiles,
  };
}
