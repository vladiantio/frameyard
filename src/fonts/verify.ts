import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "../assets/provenance.js";
import { FrameyardError, type FrameyardErrorCode } from "../errors.js";
import { hasFontMagic } from "./binary.js";
import { fontManifestPath, resolveFontAssetPath } from "./manifest.js";
import { FONT_ASSET_PREFIX, type FontFile, type FontManifest } from "./types.js";

export interface FontVerificationDiagnostic {
  severity: "error" | "warning";
  code: FrameyardErrorCode;
  message: string;
  font?: string;
  file?: string;
  details?: Record<string, unknown>;
}

export interface FontVerification {
  manifest: string;
  fonts: number;
  files: number;
  bytes: number;
  diagnostics: FontVerificationDiagnostic[];
  valid: boolean;
}

export interface FontVerificationOptions {
  projectRoot: string;
  manifest: FontManifest;
  hashes: boolean;
  licenses: boolean;
  orphans?: boolean;
}

async function firstBytes(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function expectedExtension(format: FontFile["format"]): string {
  return `.${format}`;
}

function error(
  diagnostics: FontVerificationDiagnostic[],
  code: FrameyardErrorCode,
  message: string,
  font: string,
  file?: FontFile,
  details?: Record<string, unknown>,
): void {
  diagnostics.push({
    severity: "error",
    code,
    message,
    font,
    ...(file !== undefined ? { file: file.path } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

function warning(
  diagnostics: FontVerificationDiagnostic[],
  code: FrameyardErrorCode,
  message: string,
  font: string,
  file?: FontFile,
  details?: Record<string, unknown>,
): void {
  diagnostics.push({
    severity: "warning",
    code,
    message,
    font,
    ...(file !== undefined ? { file: file.path } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

/** Verifies manifest files, hashes, licenses, and orphaned font directories. */
export async function verifyFontManifest(options: FontVerificationOptions): Promise<FontVerification> {
  const diagnostics: FontVerificationDiagnostic[] = [];
  let files = 0;
  let bytes = 0;
  const referencedDirectories = new Set<string>();

  for (const font of options.manifest.fonts) {
    referencedDirectories.add(`${FONT_ASSET_PREFIX}${font.id}/`);

    if (font.license.type === "unknown") {
      warning(
        diagnostics,
        "FONT_LICENSE_MISSING",
        `Font "${font.family}" has no known license. Add a license before redistributing the project.`,
        font.id,
      );
    }
    if (options.licenses && font.license.file !== undefined) {
      const licensePath = resolveFontAssetPath(options.projectRoot, font.license.file);
      try {
        const info = await stat(licensePath);
        if (!info.isFile()) {
          warning(
            diagnostics,
            "FONT_LICENSE_MISSING",
            `License path for "${font.family}" is not a regular file: ${font.license.file}`,
            font.id,
            undefined,
            { path: font.license.file },
          );
        }
      } catch {
        warning(
          diagnostics,
          "FONT_LICENSE_MISSING",
          `License file for "${font.family}" is missing: ${font.license.file}`,
          font.id,
          undefined,
          { path: font.license.file },
        );
      }
    } else if (options.licenses && font.license.file === undefined && font.license.type !== "unknown") {
      warning(
        diagnostics,
        "FONT_LICENSE_MISSING",
        `Font "${font.family}" records license "${font.license.type}" but no license file.`,
        font.id,
        undefined,
        { license: font.license.type },
      );
    }

    for (const file of font.files) {
      files += 1;
      const absolute = resolveFontAssetPath(options.projectRoot, file.path);
      let info;
      try {
        info = await stat(absolute);
      } catch {
        error(diagnostics, "FONT_FILE_MISSING", `Font file is missing: ${file.path}`, font.id, file);
        continue;
      }
      if (!info.isFile()) {
        error(diagnostics, "FONT_FILE_INVALID", `Font path is not a regular file: ${file.path}`, font.id, file);
        continue;
      }
      if (info.size !== file.bytes) {
        error(
          diagnostics,
          "FONT_HASH_MISMATCH",
          `Font file size changed for ${file.path}: manifest says ${file.bytes} bytes, file has ${info.size}.`,
          font.id,
          file,
          { expected: file.bytes, actual: info.size },
        );
      }
      if (path.extname(file.path).toLowerCase() !== expectedExtension(file.format)) {
        error(
          diagnostics,
          "FONT_FILE_INVALID",
          `Font file extension does not match format "${file.format}": ${file.path}`,
          font.id,
          file,
        );
      }
      try {
        const magic = await firstBytes(absolute, 4);
        if (!hasFontMagic(file.format, magic)) {
          error(
            diagnostics,
            "FONT_FILE_INVALID",
            `Font file does not have a valid ${file.format} signature: ${file.path}`,
            font.id,
            file,
          );
        }
      } catch (cause) {
        error(
          diagnostics,
          "FONT_FILE_INVALID",
          `Could not inspect font file ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          font.id,
          file,
        );
      }

      if (options.hashes) {
        try {
          const identity = await hashFile(absolute, { label: `font ${file.path}` });
          bytes += identity.bytes;
          if (identity.sha256 !== file.sha256.toLowerCase()) {
            error(
              diagnostics,
              "FONT_HASH_MISMATCH",
              `Font hash changed for ${file.path}. Run "npx frameyard font add --force" or restore the file.`,
              font.id,
              file,
              { expected: file.sha256, actual: identity.sha256 },
            );
          }
        } catch (cause) {
          if (cause instanceof FrameyardError) {
            throw cause;
          }
          error(
            diagnostics,
            "FONT_FILE_INVALID",
            `Could not hash font file ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            font.id,
            file,
          );
        }
      } else {
        bytes += info.size;
      }
    }
  }

  if (options.orphans === true) {
    const fontRoot = path.join(path.resolve(options.projectRoot), FONT_ASSET_PREFIX);
    try {
      const entries = await readdir(fontRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const directory = `${FONT_ASSET_PREFIX}${entry.name}/`;
        if (!referencedDirectories.has(directory)) {
          warning(
            diagnostics,
            "FONT_ORPHANED",
            `Font directory is not referenced by the manifest: ${directory}`,
            entry.name,
            undefined,
            { path: directory, orphaned: true },
          );
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cause;
      }
    }
  }

  return {
    manifest: fontManifestPath(options.projectRoot),
    fonts: options.manifest.fonts.length,
    files,
    bytes,
    diagnostics,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  };
}

export function fontStatuses(verification: FontVerification): Map<string, "ok" | "missing" | "invalid"> {
  const statuses = new Map<string, "ok" | "missing" | "invalid">();
  for (const diagnostic of verification.diagnostics) {
    if (diagnostic.font === undefined || diagnostic.severity !== "error") {
      continue;
    }
    const current = statuses.get(diagnostic.font);
    if (diagnostic.code === "FONT_FILE_INVALID" || diagnostic.code === "FONT_HASH_MISMATCH" || current === "invalid") {
      statuses.set(diagnostic.font, "invalid");
    } else {
      statuses.set(diagnostic.font, "missing");
    }
  }
  return statuses;
}

/** Fails before capture when a declared font file is missing or modified. */
export async function assertFontIntegrity(
  projectRoot: string,
  manifest: FontManifest | undefined,
  options: { hashes: boolean },
): Promise<void> {
  if (manifest === undefined || manifest.fonts.length === 0) {
    return;
  }
  const verification = await verifyFontManifest({
    projectRoot,
    manifest,
    hashes: options.hashes,
    licenses: false,
    orphans: false,
  });
  const firstError = verification.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new FrameyardError(firstError.code, firstError.message, {
      details: {
        font: firstError.font,
        file: firstError.file,
        ...firstError.details,
      },
      diagnostics: verification.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.font !== undefined || diagnostic.file !== undefined || diagnostic.details !== undefined
          ? {
              details: {
                ...(diagnostic.font !== undefined ? { font: diagnostic.font } : {}),
                ...(diagnostic.file !== undefined ? { file: diagnostic.file } : {}),
                ...diagnostic.details,
              },
            }
          : {}),
      })),
    });
  }
}
