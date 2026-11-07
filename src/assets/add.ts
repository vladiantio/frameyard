import { link, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FrameyardError, errorMessage } from "../errors.js";
import {
  hashFile,
  projectRelativePath,
  readManifest,
  resolveManifestPath,
  stageManifest,
  temporaryPath,
  upsertAsset,
  type ManifestAsset,
} from "./provenance.js";

const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".opus",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface AddRemoteAssetOptions {
  projectRoot: string;
  url: string;
  /** Absolute destination path inside the project root. */
  outPath: string;
  expectedSha256?: string;
  force?: boolean;
  manifestPath?: string;
  signal?: AbortSignal;
}

export interface AddRemoteAssetResult {
  src: string;
  path: string;
  sha256: string;
  bytes: number;
  source: string;
  fetchedAt: string;
  manifest: string;
}

function assetError(code: "ASSET_URL_INVALID" | "ASSET_PATH_INVALID", message: string): never {
  throw new FrameyardError(code, message);
}

/** Validates HTTPS, with loopback HTTP allowed for tests and local fixtures. */
export function validateAssetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    assetError("ASSET_URL_INVALID", `Asset URL is invalid: ${value}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url;
  }
  assetError("ASSET_URL_INVALID", `Asset URL must use HTTPS (loopback HTTP is allowed for tests): ${value}`);
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function pathKind(target: string): Promise<"missing" | "file" | "other"> {
  try {
    const info = await stat(target);
    return info.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw new FrameyardError("OUTPUT_FAILED", `Could not inspect ${target}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Fetches a remote media asset into the project, verifies its hash, and updates
 * the provenance manifest. The data file and manifest are published atomically.
 */
export async function addRemoteAsset(options: AddRemoteAssetOptions): Promise<AddRemoteAssetResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const target = path.resolve(options.outPath);
  if (!contains(projectRoot, target) || target === projectRoot) {
    assetError("ASSET_PATH_INVALID", `Asset destination escapes the project root: ${options.outPath}`);
  }
  const extension = path.extname(target).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    assetError(
      "ASSET_PATH_INVALID",
      `Unsupported media extension "${extension || "(none)"}". Use an image, video, or audio extension.`,
    );
  }

  const force = options.force === true;
  const existing = await pathKind(target);
  if (existing === "other") {
    throw new FrameyardError("OUTPUT_FAILED", `Asset destination is not a file: ${target}`);
  }
  if (existing === "file" && !force) {
    throw new FrameyardError("OUTPUT_EXISTS", `Asset already exists: ${target}. Pass --force to replace it.`);
  }
  if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
    throw new FrameyardError("USAGE", "--sha256 must be a 64-character SHA-256 hex digest.");
  }

  const url = validateAssetUrl(options.url);
  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal, redirect: "follow" });
  } catch (error) {
    throw new FrameyardError("ASSET_DOWNLOAD_FAILED", `Could not download ${url.href}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new FrameyardError(
      "ASSET_DOWNLOAD_FAILED",
      `Could not download ${url.href}: HTTP ${response.status} ${response.statusText}`.trim(),
      { details: { status: response.status } },
    );
  }
  if (response.url !== "" && response.url !== url.href) {
    validateAssetUrl(response.url);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(target), { recursive: true });
  const tempPath = temporaryPath(target, "asset");
  let manifestTemp: string | undefined;
  let backupPath: string | undefined;
  let published = false;

  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    const identity = await hashFile(tempPath, { signal: options.signal, label: "downloaded asset" });
    if (
      options.expectedSha256 !== undefined &&
      identity.sha256.toLowerCase() !== options.expectedSha256.toLowerCase()
    ) {
      throw new FrameyardError(
        "ASSET_HASH_MISMATCH",
        `Asset hash does not match --sha256: expected ${options.expectedSha256.toLowerCase()}, received ${identity.sha256}.`,
        { details: { expected: options.expectedSha256.toLowerCase(), actual: identity.sha256 } },
      );
    }

    const manifestPath = resolveManifestPath(projectRoot, options.manifestPath);
    const manifest = await readManifest(manifestPath);
    const fetchedAt = new Date().toISOString();
    const asset: ManifestAsset = {
      src: projectRelativePath(projectRoot, target),
      sha256: identity.sha256,
      bytes: identity.bytes,
      source: url.href,
      fetchedAt,
    };
    manifestTemp = await stageManifest(upsertAsset(manifest, asset), manifestPath);

    if (force && existing === "file") {
      backupPath = temporaryPath(target, "backup");
      await rename(target, backupPath);
    }

    if (force) {
      await rename(tempPath, target);
    } else {
      try {
        await link(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FrameyardError("OUTPUT_EXISTS", `Asset already exists: ${target}. Pass --force to replace it.`, {
            cause: error,
          });
        }
        throw new FrameyardError("OUTPUT_FAILED", `Could not publish ${target}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      await rm(tempPath, { force: true });
    }
    published = true;
    await rename(manifestTemp, manifestPath);
    manifestTemp = undefined;
    if (backupPath !== undefined) {
      await rm(backupPath, { force: true });
      backupPath = undefined;
    }

    return {
      ...asset,
      path: target,
      manifest: manifestPath,
    };
  } catch (error) {
    if (backupPath !== undefined) {
      try {
        await rename(backupPath, target);
        backupPath = undefined;
      } catch {
        // Preserve the original error.
      }
    } else if (published) {
      await rm(target, { force: true });
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true });
    if (manifestTemp !== undefined) {
      await rm(manifestTemp, { force: true });
    }
    if (backupPath !== undefined) {
      await rm(backupPath, { force: true });
    }
  }
}
