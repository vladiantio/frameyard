import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { hasFontMagic } from "./binary.js";
import type { AddLocalFontResult } from "./add.js";
import { fontManifestPath, readFontManifest } from "./manifest.js";
import { installFontRecord, type FontPayload } from "./install.js";
import { fontFormatForPath, fontSlug, safeFontFileName } from "./options.js";
import { summarizeFont } from "./summary.js";
import type { FontFamily, FontManifest } from "./types.js";
import type { FontStyle, FontWeight } from "./types.js";

const DEFAULT_API = "https://api.fontsource.org/v1";
const DEFAULT_CDN = "https://cdn.jsdelivr.net";
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface FontsourceSummary {
  id: string;
  family: string;
  category: string;
  variable: boolean;
  weights: number[];
  styles: string[];
  subsets: string[];
  license: string;
  version?: string;
  type: string;
}

export interface FontsourceSearchOptions {
  query: string;
  category?: string;
  subset?: string;
  style?: string;
  variable?: boolean;
  limit?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FontsourceSearchResult {
  provider: "fontsource";
  query: string;
  filters: {
    category?: string;
    subset?: string;
    style?: string;
    variable?: boolean;
  };
  results: FontsourceSummary[];
  truncated: boolean;
}

export interface FontsourceDetail {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  defSubset: string;
  variable: boolean;
  category: string;
  license?: string;
  version: string;
  npmVersion: string;
  unicodeRange?: Record<string, string>;
  variants?: Record<string, Record<string, Record<string, { url?: { woff2?: string; woff?: string; ttf?: string } }>>>;
}

export interface AddFontsourceOptions {
  projectRoot: string;
  manifest?: FontManifest;
  id: string;
  family?: string;
  subsets?: string[];
  styles?: FontStyle[];
  weights?: number[];
  static?: boolean;
  force: boolean;
  apiBase?: string;
  cdnBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface AddRemoteFontResult {
  font: AddLocalFontResult["font"];
  manifest: string;
  files: string[];
  warnings: Array<{ code: string; message: string }>;
  next: string[];
}

function apiBase(explicit?: string): string {
  return (explicit ?? process.env.FRAMEYARD_FONTSOURCE_API ?? DEFAULT_API).replace(/\/+$/, "");
}

function cdnBase(explicit?: string): string {
  return (explicit ?? process.env.FRAMEYARD_FONTSOURCE_CDN ?? DEFAULT_CDN).replace(/\/+$/, "");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function providerError(message: string, details?: Record<string, unknown>, cause?: unknown): FrameyardError {
  return new FrameyardError("FONT_PROVIDER_UNAVAILABLE", message, {
    ...(cause !== undefined ? { cause } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

async function request(
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; label: string },
): Promise<Response> {
  try {
    return await (options.fetchImpl ?? fetch)(url, {
      signal: requestSignal(options.signal),
      headers: { accept: "application/json, font/woff2, text/plain;q=0.8" },
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new FrameyardError("CANCELLED", "Operation cancelled.", { cause: error });
    }
    throw providerError(`Could not reach ${options.label}: ${url}`, { url }, error);
  }
}

async function fetchJson(
  url: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    label: string;
    notFoundCode?: "FONT_NOT_FOUND";
  },
): Promise<unknown> {
  const response = await request(url, options);
  if (!response.ok) {
    if (response.status === 404 && options.notFoundCode === "FONT_NOT_FOUND") {
      throw new FrameyardError("FONT_NOT_FOUND", `${options.label} was not found: ${url}`, {
        details: { status: response.status, url },
      });
    }
    throw providerError(`${options.label} returned HTTP ${response.status}: ${url}`, {
      status: response.status,
      url,
    });
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw providerError(`${options.label} returned invalid JSON: ${url}`, { url }, error);
  }
}

async function fetchBytes(
  url: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    label: string;
    failureCode?: "FONT_DOWNLOAD_FAILED";
  },
): Promise<Buffer> {
  const response = await request(url, options);
  if (!response.ok) {
    const code = options.failureCode ?? "FONT_PROVIDER_UNAVAILABLE";
    throw new FrameyardError(code, `${options.label} returned HTTP ${response.status}: ${url}`, {
      details: { status: response.status, url },
    });
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
    throw new FrameyardError(
      options.failureCode ?? "FONT_PROVIDER_UNAVAILABLE",
      `${options.label} is larger than the ${MAX_DOWNLOAD_BYTES} byte limit: ${url}`,
      { details: { url } },
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new FrameyardError(
      options.failureCode ?? "FONT_PROVIDER_UNAVAILABLE",
      `${options.label} is larger than the ${MAX_DOWNLOAD_BYTES} byte limit: ${url}`,
      { details: { url } },
    );
  }
  return bytes;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw providerError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw providerError(`${label} must be a non-empty string.`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw providerError(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function asNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw providerError(`${label} must be an array of numbers.`);
  }
  return value as number[];
}

function parseSummary(value: unknown): FontsourceSummary {
  const item = requireObject(value, "Fontsource font");
  return {
    id: asString(item.id, "Fontsource font.id"),
    family: asString(item.family, "Fontsource font.family"),
    category: asString(item.category, "Fontsource font.category"),
    variable: item.variable === true,
    weights: asNumberArray(item.weights, "Fontsource font.weights"),
    styles: asStringArray(item.styles, "Fontsource font.styles"),
    subsets: asStringArray(item.subsets, "Fontsource font.subsets"),
    license: asString(item.license, "Fontsource font.license"),
    ...(typeof item.version === "string" && item.version.length > 0 ? { version: item.version } : {}),
    type: asString(item.type, "Fontsource font.type"),
  };
}

function parseDetail(value: unknown, id: string): FontsourceDetail {
  const item = requireObject(value, `Fontsource font ${id}`);
  const parsed: FontsourceDetail = {
    id: asString(item.id, "Fontsource font.id"),
    family: asString(item.family, "Fontsource font.family"),
    subsets: asStringArray(item.subsets, "Fontsource font.subsets"),
    weights: asNumberArray(item.weights, "Fontsource font.weights"),
    styles: asStringArray(item.styles, "Fontsource font.styles"),
    defSubset: asString(item.defSubset, "Fontsource font.defSubset"),
    variable: item.variable === true,
    category: asString(item.category, "Fontsource font.category"),
    ...(typeof item.license === "string" ? { license: item.license } : {}),
    version: asString(item.version, "Fontsource font.version"),
    npmVersion: asString(item.npmVersion, "Fontsource font.npmVersion"),
    ...(item.unicodeRange !== undefined && typeof item.unicodeRange === "object"
      ? { unicodeRange: item.unicodeRange as Record<string, string> }
      : {}),
    ...(item.variants !== undefined && typeof item.variants === "object"
      ? { variants: item.variants as FontsourceDetail["variants"] }
      : {}),
  };
  if (parsed.id !== id) {
    throw providerError(`Fontsource returned font "${parsed.id}" for requested id "${id}".`, { requested: id });
  }
  return parsed;
}

function matchRank(query: string, summary: FontsourceSummary): number {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return 0;
  }
  const id = summary.id.toLowerCase();
  const family = summary.family.toLowerCase();
  if (id === normalized || family === normalized) {
    return 0;
  }
  if (id.startsWith(normalized) || family.startsWith(normalized)) {
    return 1;
  }
  if (id.includes(normalized) || family.includes(normalized)) {
    return 2;
  }
  return 3;
}

/** Searches the Fontsource catalog. The API returns the whole catalog, so filtering is local. */
export async function searchFontsource(options: FontsourceSearchOptions): Promise<FontsourceSearchResult> {
  const value = await fetchJson(`${apiBase(options.apiBase)}/fonts`, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    label: "Fontsource API",
  });
  if (!Array.isArray(value)) {
    throw providerError("Fontsource /fonts did not return an array.");
  }

  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new FrameyardError("USAGE", "--limit must be an integer between 1 and 100.");
  }

  const all = value.map(parseSummary);
  const matching = all
    .filter((summary) => options.category === undefined || summary.category === options.category)
    .filter((summary) => options.subset === undefined || summary.subsets.includes(options.subset))
    .filter((summary) => options.style === undefined || summary.styles.includes(options.style))
    .filter((summary) => options.variable === undefined || summary.variable === options.variable)
    .filter((summary) => options.query.trim().length === 0 || matchRank(options.query, summary) < 3)
    .sort((left, right) => {
      const rank = matchRank(options.query, left) - matchRank(options.query, right);
      return rank === 0 ? left.family.localeCompare(right.family) : rank;
    });

  return {
    provider: "fontsource",
    query: options.query,
    filters: {
      ...(options.category !== undefined ? { category: options.category } : {}),
      ...(options.subset !== undefined ? { subset: options.subset } : {}),
      ...(options.style !== undefined ? { style: options.style } : {}),
      ...(options.variable !== undefined ? { variable: options.variable } : {}),
    },
    results: matching.slice(0, limit),
    truncated: matching.length > limit,
  };
}

function validateRequested<T extends string | number>(values: T[], available: T[], label: string, id: string): void {
  const missing = values.filter((value) => !available.includes(value));
  if (missing.length > 0) {
    throw new FrameyardError(
      "USAGE",
      `Fontsource font "${id}" does not provide ${label}: ${missing.join(", ")}. Available: ${available.join(", ")}.`,
    );
  }
}

function variableMetadataUrl(cdn: string, id: string, version: string): string {
  return `${cdn}/npm/@fontsource-variable/${id}@${version}/metadata.json`;
}

function variableUnicodeUrl(cdn: string, id: string, version: string): string {
  return `${cdn}/npm/@fontsource-variable/${id}@${version}/unicode.json`;
}

function variableFontUrl(cdn: string, id: string, version: string, subset: string, style: string): string {
  return `${cdn}/fontsource/fonts/${id}:vf@${version}/${subset}-wght-${style}.woff2`;
}

function staticFontUrl(detail: FontsourceDetail, subset: string, weight: number, style: string): string | undefined {
  return detail.variants?.[String(weight)]?.[style]?.[subset]?.url?.woff2;
}

function licenseUrl(cdn: string, packageName: string, id: string, version: string): string {
  return `${cdn}/npm/${packageName}/${id}@${version}/LICENSE`;
}

function licenseDetails(value: unknown): { type: string; attribution?: string } {
  if (typeof value === "string" && value.length > 0) {
    return { type: value };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const type = typeof item.type === "string" && item.type.length > 0 ? item.type : "unknown";
    return {
      type,
      ...(typeof item.attribution === "string" && item.attribution.length > 0 ? { attribution: item.attribution } : {}),
    };
  }
  return { type: "unknown" };
}

async function downloadLicense(
  cdn: string,
  id: string,
  version: string,
  variable: boolean,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ bytes: Buffer; path: string } | undefined> {
  const packages = variable ? ["@fontsource-variable", "@fontsource"] : ["@fontsource", "@fontsource-variable"];
  for (const packageName of packages) {
    const url = licenseUrl(cdn, packageName, id, version);
    try {
      const bytes = await fetchBytes(url, {
        ...options,
        label: "Fontsource license",
      });
      if (bytes.length > 0) {
        return { bytes, path: `assets/fonts/${id}/LICENSE.txt` };
      }
    } catch (error) {
      if (isFrameyardError(error) && error.code === "CANCELLED") {
        throw error;
      }
      // Try the other package name; the font files can still be installed.
    }
  }
  return undefined;
}

function fileRecordPath(id: string, fileName: string): string {
  return `assets/fonts/${id}/${fileName}`;
}

/** Installs a Fontsource family and pinned WOFF2 variants. */
export async function addFontsource(options: AddFontsourceOptions): Promise<AddRemoteFontResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.id)) {
    throw new FrameyardError(
      "USAGE",
      `Fontsource id "${options.id}" must use lowercase letters, digits, and hyphens, starting with a letter or digit.`,
    );
  }
  if (options.static === true && options.weights !== undefined && options.weights.length === 0) {
    throw new FrameyardError("USAGE", "--weight must contain at least one weight.");
  }

  const detailValue = await fetchJson(`${apiBase(options.apiBase)}/fonts/${options.id}`, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    label: `Fontsource font ${options.id}`,
    notFoundCode: "FONT_NOT_FOUND",
  });
  const detail = parseDetail(detailValue, options.id);
  const cdn = cdnBase(options.cdnBase);
  const variable = detail.variable && options.static !== true;
  const subsets = options.subsets ?? [detail.defSubset];
  validateRequested(subsets, detail.subsets, "subsets", options.id);
  const styles = options.styles ?? ["normal"];
  validateRequested(styles, detail.styles, "styles", options.id);

  if (variable && options.weights !== undefined) {
    throw new FrameyardError(
      "USAGE",
      `Fontsource font "${options.id}" is variable; pass --static to install specific weights.`,
    );
  }

  const warnings: Array<{ code: string; message: string }> = [];
  const payloads: FontPayload[] = [];
  const files: FontFamily["files"] = [];
  let variableAxes: Record<string, { min: number; max: number; default: number }> | undefined;
  let licenseType = detail.license ?? "unknown";
  let attribution: string | undefined;

  if (variable) {
    const metadataValue = await fetchJson(variableMetadataUrl(cdn, options.id, detail.npmVersion), {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      label: `Fontsource variable metadata for ${options.id}`,
    }).catch((error: unknown) => {
      if (isFrameyardError(error) && error.code === "CANCELLED") {
        throw error;
      }
      throw providerError(
        `Fontsource has no variable package for "${options.id}" at ${detail.npmVersion}. Use --static.`,
        { id: options.id, version: detail.npmVersion },
        error,
      );
    });
    const metadata = requireObject(metadataValue, `Fontsource variable metadata for ${options.id}`);
    const axes = requireObject(metadata.variable, `Fontsource variable axes for ${options.id}`);
    const wght = requireObject(axes.wght, `Fontsource variable axis wght for ${options.id}`);
    const min = Number(wght.min);
    const max = Number(wght.max);
    const defaultValue = Number(wght.default);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(defaultValue) || min > max) {
      throw providerError(`Fontsource variable axis wght for "${options.id}" is invalid.`);
    }
    variableAxes = { wght: { min, max, default: defaultValue } };
    const license = licenseDetails(metadata.license);
    licenseType = license.type;
    attribution = license.attribution;

    const unicodeValue = await fetchJson(variableUnicodeUrl(cdn, options.id, detail.npmVersion), {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      label: `Fontsource unicode ranges for ${options.id}`,
    }).catch((error: unknown) => {
      if (isFrameyardError(error) && error.code === "CANCELLED") {
        throw error;
      }
      return undefined;
    });
    const unicode =
      unicodeValue !== undefined && typeof unicodeValue === "object" && unicodeValue !== null
        ? (unicodeValue as Record<string, string>)
        : detail.unicodeRange;

    for (const subset of subsets) {
      for (const style of styles) {
        const url = variableFontUrl(cdn, options.id, detail.npmVersion, subset, style);
        const bytes = await fetchBytes(url, {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
          label: `Fontsource variable font ${options.id}`,
          failureCode: "FONT_DOWNLOAD_FAILED",
        });
        if (!hasFontMagic("woff2", bytes)) {
          throw new FrameyardError("FONT_DOWNLOAD_FAILED", `Fontsource returned an invalid WOFF2 file: ${url}`, {
            details: { url },
          });
        }
        const fileName = safeFontFileName(`${options.id}-${subset}-wght-${style}.woff2`);
        const relativePath = fileRecordPath(options.id, fileName);
        payloads.push({ path: relativePath, bytes });
        files.push({
          path: relativePath,
          subset,
          style,
          weight: { min, max },
          format: "woff2",
          ...(unicode?.[subset] !== undefined ? { unicodeRange: unicode[subset] } : {}),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          source: url,
        });
      }
    }
  } else {
    const weights = options.weights ?? (detail.weights.includes(400) ? [400] : detail.weights.slice(0, 1));
    validateRequested(weights, detail.weights, "weights", options.id);
    for (const subset of subsets) {
      for (const style of styles) {
        for (const weight of weights) {
          const url = staticFontUrl(detail, subset, weight, style);
          if (url === undefined) {
            throw providerError(`Fontsource has no ${subset}/${style}/${weight} variant for "${options.id}".`, {
              id: options.id,
              subset,
              style,
              weight,
            });
          }
          const bytes = await fetchBytes(url, {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            label: `Fontsource font ${options.id}`,
            failureCode: "FONT_DOWNLOAD_FAILED",
          });
          if (!hasFontMagic("woff2", bytes)) {
            throw new FrameyardError("FONT_DOWNLOAD_FAILED", `Fontsource returned an invalid WOFF2 file: ${url}`, {
              details: { url },
            });
          }
          const fileName = safeFontFileName(`${options.id}-${subset}-${weight}-${style}.woff2`);
          const relativePath = fileRecordPath(options.id, fileName);
          payloads.push({ path: relativePath, bytes });
          files.push({
            path: relativePath,
            subset,
            style,
            weight,
            format: "woff2",
            ...(detail.unicodeRange?.[subset] !== undefined ? { unicodeRange: detail.unicodeRange[subset] } : {}),
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            source: url,
          });
        }
      }
    }
  }

  const downloadedLicense = await downloadLicense(cdn, options.id, detail.npmVersion, variable, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (downloadedLicense === undefined) {
    warnings.push({
      code: "FONT_LICENSE_MISSING",
      message: `Could not download the Fontsource LICENSE for "${options.id}"; the manifest records license "${licenseType}" without a file.`,
    });
  } else {
    payloads.push({ path: downloadedLicense.path, bytes: downloadedLicense.bytes, overwrite: true });
  }

  const incoming: FontFamily = {
    id: options.id,
    family: options.family ?? detail.family,
    provider: "fontsource",
    providerId: options.id,
    providerVersion: detail.npmVersion,
    license: {
      type: licenseType,
      ...(downloadedLicense !== undefined ? { file: downloadedLicense.path } : {}),
      ...(attribution !== undefined ? { attribution } : {}),
    },
    ...(variable ? { variable: true } : {}),
    ...(variableAxes !== undefined ? { axes: variableAxes } : {}),
    files,
  };
  const manifest = options.manifest ?? (await readFontManifest(options.projectRoot));
  const installed = await installFontRecord({
    projectRoot: options.projectRoot,
    manifest: manifest ?? { version: 1, fonts: [] },
    incoming,
    payloads,
    force: options.force,
  });
  const family = installed.family;

  return {
    font: summarizeFont(family),
    manifest: fontManifestPath(options.projectRoot),
    files: family.files.map((file) => file.path),
    warnings,
    next: [
      `Use font-family: "${family.family}", system-ui, sans-serif`,
      "npx frameyard font verify --json",
      "npx frameyard context --json",
    ],
  };
}

/** Downloads a single HTTPS (or loopback HTTP) font URL and installs it. */
export async function addUrlFont(options: {
  projectRoot: string;
  manifest?: FontManifest;
  url: string;
  family: string;
  id?: string;
  weight: FontWeight;
  style: FontStyle;
  subset?: string;
  unicodeRange?: string;
  license?: string;
  licenseFile?: string;
  sha256?: string;
  force: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AddRemoteFontResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    throw new FrameyardError("USAGE", `--url must be a valid URL; received "${options.url}".`);
  }
  const loopback =
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "::1" ||
    parsedUrl.hostname === "[::1]";
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && loopback)) {
    throw new FrameyardError("USAGE", "--url must use HTTPS; loopback HTTP is allowed for local tests.");
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new FrameyardError("USAGE", "--url must not contain credentials.");
  }

  const format = fontFormatForPath(parsedUrl.pathname);
  const bytes = await fetchBytes(options.url, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    label: "font URL",
    failureCode: "FONT_DOWNLOAD_FAILED",
  });
  if (!hasFontMagic(format, bytes)) {
    throw new FrameyardError("FONT_DOWNLOAD_FAILED", `Font URL did not return a valid ${format} file: ${options.url}`, {
      details: { url: options.url },
    });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (options.sha256 !== undefined && options.sha256.toLowerCase() !== sha256) {
    throw new FrameyardError("FONT_HASH_MISMATCH", `Font URL hash does not match --sha256: ${options.url}`, {
      details: { expected: options.sha256, actual: sha256 },
    });
  }

  const id = options.id ?? fontSlug(options.family);
  const fileName = safeFontFileName(parsedUrl.pathname);
  const relativePath = fileRecordPath(id, fileName);
  const payloads: FontPayload[] = [{ path: relativePath, bytes }];
  const warnings: Array<{ code: string; message: string }> = [];
  const licenseType = options.license ?? "unknown";
  let licenseFile: string | undefined;
  if (options.licenseFile !== undefined) {
    let licenseBytes: Buffer;
    try {
      licenseBytes = await readFile(path.resolve(process.cwd(), options.licenseFile));
    } catch {
      throw new FrameyardError("FONT_LICENSE_MISSING", `License file does not exist: ${options.licenseFile}`);
    }
    licenseFile = `assets/fonts/${id}/LICENSE.txt`;
    payloads.push({ path: licenseFile, bytes: licenseBytes, overwrite: true });
  }
  if (licenseType === "unknown") {
    warnings.push({
      code: "FONT_LICENSE_MISSING",
      message: `Font "${options.family}" has no known license. Add --license before redistributing the project.`,
    });
  } else if (licenseFile === undefined) {
    warnings.push({
      code: "FONT_LICENSE_MISSING",
      message: `Font "${options.family}" records license "${licenseType}" but no license file. Add --license-file to vendor it.`,
    });
  }

  const incoming: FontFamily = {
    id,
    family: options.family,
    provider: "url",
    license: {
      type: licenseType,
      ...(licenseFile !== undefined ? { file: licenseFile } : {}),
    },
    ...(typeof options.weight === "number" ? {} : { variable: true }),
    files: [
      {
        path: relativePath,
        ...(options.subset !== undefined ? { subset: options.subset } : {}),
        style: options.style,
        weight: options.weight,
        format,
        ...(options.unicodeRange !== undefined ? { unicodeRange: options.unicodeRange } : {}),
        sha256,
        bytes: bytes.length,
        source: options.url,
      },
    ],
  };
  const manifest = options.manifest ?? (await readFontManifest(options.projectRoot));
  const installed = await installFontRecord({
    projectRoot: options.projectRoot,
    manifest: manifest ?? { version: 1, fonts: [] },
    incoming,
    payloads,
    force: options.force,
  });
  const family = installed.family;

  return {
    font: summarizeFont(family),
    manifest: fontManifestPath(options.projectRoot),
    files: family.files.map((file) => file.path),
    warnings,
    next: [
      `Use font-family: "${family.family}", system-ui, sans-serif`,
      "npx frameyard font verify --json",
      "npx frameyard context --json",
    ],
  };
}
