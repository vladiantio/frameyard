import { isPlainObject } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import {
  FONT_ASSET_PREFIX,
  FONT_MANIFEST_VERSION,
  type FontAxis,
  type FontFamily,
  type FontFile,
  type FontFormat,
  type FontLicense,
  type FontManifest,
  type FontProvider,
  type FontStyle,
  type FontWeight,
} from "./types.js";

const FONT_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SUBSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNICODE_RANGE = /^[Uu]\+[0-9A-Fa-f?*-]+(?:\s*,\s*[Uu]\+[0-9A-Fa-f?*-]+)*$/;
const FAMILY_FORBIDDEN = /[\p{Cc}"'\\;{}<>]/u;
const MANIFEST_KEYS = new Set(["version", "fonts"]);
const FAMILY_KEYS = new Set([
  "id",
  "family",
  "provider",
  "providerId",
  "providerVersion",
  "license",
  "variable",
  "axes",
  "files",
]);
const LICENSE_KEYS = new Set(["type", "file", "attribution"]);
const FILE_KEYS = new Set(["path", "subset", "style", "weight", "format", "unicodeRange", "sha256", "bytes", "source"]);
const PROVIDERS = new Set<FontProvider>(["local", "fontsource", "url"]);
const STYLES = new Set<FontStyle>(["normal", "italic"]);
const FORMATS = new Set<FontFormat>(["woff2", "woff", "ttf", "otf"]);

function manifestError(message: string, details?: Record<string, unknown>): never {
  throw new FrameyardError("FONT_MANIFEST_INVALID", message, details === undefined ? undefined : { details });
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    manifestError(`${label} must be a plain object.`, { path: label });
  }
  return value;
}

function requireKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      manifestError(`${label} contains an unknown field "${key}".`, {
        jsonPath: `${label}.${key}`,
        allowed: [...allowed],
      });
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    manifestError(`${label} must be a non-empty string.`, { jsonPath: label });
  }
  return value;
}

function requireOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, label);
}

function requireProjectRelativePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    manifestError(`${label} must be a project-relative POSIX path without "." or ".." segments.`, {
      jsonPath: label,
      value: path,
    });
  }
  return path;
}

function requireFontAssetPath(value: unknown, label: string, fontId: string): string {
  const path = requireProjectRelativePath(value, label);
  const expectedPrefix = `${FONT_ASSET_PREFIX}${fontId}/`;
  if (!path.startsWith(expectedPrefix) || path.length === expectedPrefix.length) {
    manifestError(`${label} must be a file below ${expectedPrefix}.`, {
      jsonPath: label,
      value: path,
      expectedPrefix,
    });
  }
  return path;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    manifestError(`${label} must be a finite number.`, { jsonPath: label });
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    manifestError(`${label} must be an integer.`, { jsonPath: label });
  }
  return value;
}

function parseWeight(value: unknown, label: string): FontWeight {
  if (typeof value === "number") {
    const weight = requireInteger(value, label);
    if (weight < 1 || weight > 1000) {
      manifestError(`${label} must be between 1 and 1000.`, { jsonPath: label, value: weight });
    }
    return weight;
  }

  const range = requireObject(value, label);
  requireKeys(range, new Set(["min", "max"]), label);
  const min = requireInteger(range.min, `${label}.min`);
  const max = requireInteger(range.max, `${label}.max`);
  if (min < 1 || max > 1000 || min > max) {
    manifestError(`${label} must be a weight range between 1 and 1000 with min <= max.`, {
      jsonPath: label,
      value: { min, max },
    });
  }
  return { min, max };
}

function parseAxis(value: unknown, label: string): FontAxis {
  const axis = requireObject(value, label);
  requireKeys(axis, new Set(["min", "max", "default"]), label);
  const min = requireFiniteNumber(axis.min, `${label}.min`);
  const max = requireFiniteNumber(axis.max, `${label}.max`);
  const defaultValue = requireFiniteNumber(axis.default, `${label}.default`);
  if (min > max || defaultValue < min || defaultValue > max) {
    manifestError(`${label} must satisfy min <= default <= max.`, {
      jsonPath: label,
      value: { min, max, default: defaultValue },
    });
  }
  return { min, max, default: defaultValue };
}

function parseLicense(value: unknown, label: string, fontId: string): FontLicense {
  const license = requireObject(value, label);
  requireKeys(license, LICENSE_KEYS, label);
  const type = requireString(license.type, `${label}.type`);
  const file = license.file === undefined ? undefined : requireFontAssetPath(license.file, `${label}.file`, fontId);
  const attribution = requireOptionalString(license.attribution, `${label}.attribution`);
  return {
    type,
    ...(file !== undefined ? { file } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
  };
}

function parseFontFile(value: unknown, label: string, fontId: string): FontFile {
  const file = requireObject(value, label);
  requireKeys(file, FILE_KEYS, label);
  const path = requireFontAssetPath(file.path, `${label}.path`, fontId);
  const subset = file.subset === undefined ? undefined : requireString(file.subset, `${label}.subset`);
  if (subset !== undefined && !SUBSET.test(subset)) {
    manifestError(`${label}.subset must contain only letters, digits, dots, underscores, and hyphens.`, {
      jsonPath: `${label}.subset`,
      value: subset,
    });
  }
  if (typeof file.style !== "string" || !STYLES.has(file.style as FontStyle)) {
    manifestError(`${label}.style must be "normal" or "italic".`, {
      jsonPath: `${label}.style`,
      value: file.style,
    });
  }
  if (typeof file.format !== "string" || !FORMATS.has(file.format as FontFormat)) {
    manifestError(`${label}.format must be "woff2", "woff", "ttf", or "otf".`, {
      jsonPath: `${label}.format`,
      value: file.format,
    });
  }
  const unicodeRange =
    file.unicodeRange === undefined ? undefined : requireString(file.unicodeRange, `${label}.unicodeRange`);
  if (unicodeRange !== undefined && !UNICODE_RANGE.test(unicodeRange)) {
    manifestError(`${label}.unicodeRange is not a valid CSS unicode-range list.`, {
      jsonPath: `${label}.unicodeRange`,
      value: unicodeRange,
    });
  }
  const sha256 = requireString(file.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) {
    manifestError(`${label}.sha256 must be a 64-character SHA-256 hex digest.`, {
      jsonPath: `${label}.sha256`,
    });
  }
  const bytes = requireInteger(file.bytes, `${label}.bytes`);
  if (bytes <= 0) {
    manifestError(`${label}.bytes must be a positive integer.`, { jsonPath: `${label}.bytes`, value: bytes });
  }
  const source = requireOptionalString(file.source, `${label}.source`);

  return {
    path,
    ...(subset !== undefined ? { subset } : {}),
    style: file.style as FontStyle,
    weight: parseWeight(file.weight, `${label}.weight`),
    format: file.format as FontFormat,
    ...(unicodeRange !== undefined ? { unicodeRange } : {}),
    sha256,
    bytes,
    ...(source !== undefined ? { source } : {}),
  };
}

function weightKey(weight: FontWeight): string {
  return typeof weight === "number" ? String(weight) : `${weight.min}-${weight.max}`;
}

function faceKey(file: FontFile): string {
  return `${file.subset ?? ""}\0${file.style}\0${weightKey(file.weight)}`;
}

function parseFontFamily(value: unknown, label: string): FontFamily {
  const family = requireObject(value, label);
  requireKeys(family, FAMILY_KEYS, label);

  const id = requireString(family.id, `${label}.id`);
  if (!FONT_ID.test(id)) {
    manifestError(`${label}.id must use lowercase letters, digits, and hyphens, starting with a letter or digit.`, {
      jsonPath: `${label}.id`,
      value: id,
    });
  }

  const name = requireString(family.family, `${label}.family`);
  if (name.trim() !== name || FAMILY_FORBIDDEN.test(name)) {
    manifestError(
      `${label}.family must be a CSS font-family name without quotes, backslashes, semicolons, braces, or control characters.`,
      {
        jsonPath: `${label}.family`,
        value: name,
      },
    );
  }

  if (typeof family.provider !== "string" || !PROVIDERS.has(family.provider as FontProvider)) {
    manifestError(`${label}.provider must be "local", "fontsource", or "url".`, {
      jsonPath: `${label}.provider`,
      value: family.provider,
    });
  }
  const providerId = requireOptionalString(family.providerId, `${label}.providerId`);
  const providerVersion = requireOptionalString(family.providerVersion, `${label}.providerVersion`);
  const license = parseLicense(family.license, `${label}.license`, id);

  if (family.variable !== undefined && typeof family.variable !== "boolean") {
    manifestError(`${label}.variable must be a boolean.`, { jsonPath: `${label}.variable` });
  }

  let axes: Record<string, FontAxis> | undefined;
  if (family.axes !== undefined) {
    const rawAxes = requireObject(family.axes, `${label}.axes`);
    axes = {};
    for (const [axisName, axisValue] of Object.entries(rawAxes)) {
      if (!/^[A-Za-z0-9]{1,8}$/.test(axisName)) {
        manifestError(`${label}.axes contains an invalid axis name "${axisName}".`, {
          jsonPath: `${label}.axes.${axisName}`,
        });
      }
      axes[axisName] = parseAxis(axisValue, `${label}.axes.${axisName}`);
    }
  }

  if (!Array.isArray(family.files) || family.files.length === 0) {
    manifestError(`${label}.files must be a non-empty array.`, { jsonPath: `${label}.files` });
  }

  const files: FontFile[] = [];
  const paths = new Set<string>();
  const faces = new Set<string>();
  for (const [index, rawFile] of family.files.entries()) {
    const file = parseFontFile(rawFile, `${label}.files[${index}]`, id);
    if (paths.has(file.path)) {
      manifestError(`${label}.files contains the duplicate path "${file.path}".`, {
        jsonPath: `${label}.files[${index}].path`,
        value: file.path,
      });
    }
    const key = faceKey(file);
    if (faces.has(key)) {
      manifestError(`${label}.files contains a duplicate face for subset/style/weight.`, {
        jsonPath: `${label}.files[${index}]`,
        value: { subset: file.subset ?? null, style: file.style, weight: file.weight },
      });
    }
    paths.add(file.path);
    faces.add(key);
    files.push(file);
  }

  return {
    id,
    family: name,
    provider: family.provider as FontProvider,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(providerVersion !== undefined ? { providerVersion } : {}),
    license,
    ...(family.variable !== undefined ? { variable: family.variable } : {}),
    ...(axes !== undefined ? { axes } : {}),
    files,
  };
}

/** Parses and validates a `fy.fonts.json` document. */
export function parseFontManifest(value: unknown): FontManifest {
  const manifest = requireObject(value, "font manifest");
  requireKeys(manifest, MANIFEST_KEYS, "font manifest");
  if (manifest.version !== FONT_MANIFEST_VERSION) {
    manifestError(`font manifest.version must be ${FONT_MANIFEST_VERSION}.`, {
      jsonPath: "font manifest.version",
      value: manifest.version,
    });
  }
  if (!Array.isArray(manifest.fonts)) {
    manifestError("font manifest.fonts must be an array.", { jsonPath: "font manifest.fonts" });
  }

  const fonts: FontFamily[] = [];
  const ids = new Set<string>();
  const families = new Set<string>();
  for (const [index, rawFamily] of manifest.fonts.entries()) {
    const font = parseFontFamily(rawFamily, `font manifest.fonts[${index}]`);
    if (ids.has(font.id)) {
      manifestError(`font manifest contains the duplicate font id "${font.id}".`, {
        jsonPath: `font manifest.fonts[${index}].id`,
        value: font.id,
      });
    }
    const familyKey = font.family.toLocaleLowerCase("en-US");
    if (families.has(familyKey)) {
      manifestError(`font manifest contains the duplicate CSS font-family "${font.family}".`, {
        jsonPath: `font manifest.fonts[${index}].family`,
        value: font.family,
      });
    }
    ids.add(font.id);
    families.add(familyKey);
    fonts.push(font);
  }

  return { version: FONT_MANIFEST_VERSION, fonts };
}
