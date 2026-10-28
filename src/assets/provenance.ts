import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainObject, type JsonValue } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { VERSION } from "../version.js";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILENAME = "frameyard.assets.json";

export interface ManifestGenerator {
  name: "frameyard";
  version: string;
  command: "tts" | "transcribe";
  executable: string;
  integration: "qwentts.cpp" | "whisper.cpp";
  referenceRevision: string;
}

export interface ManifestModel {
  role: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ManifestSource {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ManifestDerived {
  path: string;
  format: "srt" | "vtt";
  sha256: string;
  bytes: number;
}

export interface ManifestArtifact {
  path: string;
  kind: "audio" | "transcript";
  operation: "tts" | "transcribe";
  sha256: string;
  bytes: number;
  createdAt: string;
  generator: ManifestGenerator;
  models: ManifestModel[];
  parameters: Record<string, JsonValue>;
  source?: ManifestSource;
  derived?: ManifestDerived[];
}

export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  artifacts: ManifestArtifact[];
}

export interface StagedFile {
  tempPath: string;
  path: string;
  label: string;
  /** Allow replacing an existing file even when the operation is not forced (used for the manifest). */
  overwrite?: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/i;

function manifestError(message: string): never {
  throw new FrameyardError("MANIFEST_INVALID", message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    manifestError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    manifestError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function parseIdentity(value: unknown, label: string): { path: string; sha256: string; bytes: number } {
  if (!isPlainObject(value)) {
    manifestError(`${label} must be a plain object.`);
  }
  const sha256 = requireString(value.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) {
    manifestError(`${label}.sha256 must be a 64-character SHA-256 hex digest.`);
  }
  return {
    path: requireString(value.path, `${label}.path`),
    sha256,
    bytes: requireInteger(value.bytes, `${label}.bytes`),
  };
}

function parseManifest(value: unknown): Manifest {
  if (!isPlainObject(value)) {
    manifestError("The provenance manifest must be a plain JSON object.");
  }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    manifestError(
      `Unsupported provenance manifest schemaVersion ${String(value.schemaVersion)}; expected ${MANIFEST_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(value.artifacts)) {
    manifestError("Provenance manifest artifacts must be an array.");
  }

  const artifacts: ManifestArtifact[] = [];
  for (const [index, item] of value.artifacts.entries()) {
    const label = `Provenance manifest artifacts[${index}]`;
    if (!isPlainObject(item)) {
      manifestError(`${label} must be a plain object.`);
    }
    if (item.kind !== "audio" && item.kind !== "transcript") {
      manifestError(`${label}.kind must be "audio" or "transcript".`);
    }
    if (item.operation !== "tts" && item.operation !== "transcribe") {
      manifestError(`${label}.operation must be "tts" or "transcribe".`);
    }

    if (!isPlainObject(item.generator)) {
      manifestError(`${label}.generator must be a plain object.`);
    }
    const generator: ManifestGenerator = {
      name: "frameyard",
      version: requireString(item.generator.version, `${label}.generator.version`),
      command: item.generator.command === "tts" || item.generator.command === "transcribe"
        ? item.generator.command
        : manifestError(`${label}.generator.command must be "tts" or "transcribe".`),
      executable: requireString(item.generator.executable, `${label}.generator.executable`),
      integration: item.generator.integration === "qwentts.cpp" || item.generator.integration === "whisper.cpp"
        ? item.generator.integration
        : manifestError(`${label}.generator.integration must be "qwentts.cpp" or "whisper.cpp".`),
      referenceRevision: requireString(
        item.generator.referenceRevision,
        `${label}.generator.referenceRevision`,
      ),
    };

    if (!Array.isArray(item.models)) {
      manifestError(`${label}.models must be an array.`);
    }
    const models: ManifestModel[] = item.models.map((model, modelIndex) => {
      if (!isPlainObject(model)) {
        manifestError(`${label}.models[${modelIndex}] must be a plain object.`);
      }
      const identity = parseIdentity(model, `${label}.models[${modelIndex}]`);
      return {
        role: requireString(model.role, `${label}.models[${modelIndex}].role`),
        ...identity,
      };
    });

    if (!isPlainObject(item.parameters)) {
      manifestError(`${label}.parameters must be a plain object.`);
    }

    const artifactIdentity = parseIdentity(item, label);
    const artifact: ManifestArtifact = {
      path: artifactIdentity.path,
      kind: item.kind,
      operation: item.operation,
      sha256: artifactIdentity.sha256,
      bytes: artifactIdentity.bytes,
      createdAt: requireString(item.createdAt, `${label}.createdAt`),
      generator,
      models,
      parameters: item.parameters as Record<string, JsonValue>,
    };

    if (item.source !== undefined) {
      artifact.source = parseIdentity(item.source, `${label}.source`);
    }
    if (item.derived !== undefined) {
      if (!Array.isArray(item.derived)) {
        manifestError(`${label}.derived must be an array.`);
      }
      artifact.derived = item.derived.map((entry, entryIndex) => {
        if (!isPlainObject(entry)) {
          manifestError(`${label}.derived[${entryIndex}] must be a plain object.`);
        }
        if (entry.format !== "srt" && entry.format !== "vtt") {
          manifestError(`${label}.derived[${entryIndex}].format must be "srt" or "vtt".`);
        }
        return {
          format: entry.format,
          ...parseIdentity(entry, `${label}.derived[${entryIndex}]`),
        };
      });
    }

    artifacts.push(artifact);
  }

  return { schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts };
}

export function defaultManifestPath(projectRoot: string): string {
  return path.join(projectRoot, MANIFEST_FILENAME);
}

export function resolveManifestPath(projectRoot: string, requested?: string): string {
  return requested === undefined ? defaultManifestPath(projectRoot) : path.resolve(process.cwd(), requested);
}

export function projectRelativePath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative.split(path.sep).join("/");
}

export function temporaryPath(destination: string, label = "tmp"): string {
  const extension = path.extname(destination);
  const base = path.basename(destination, extension);
  return path.join(
    path.dirname(destination),
    `.${base}.frameyard-${label}-${process.pid}-${randomUUID()}${extension}`,
  );
}

export async function hashFile(
  filePath: string,
  options: { signal?: AbortSignal; label?: string } = {},
): Promise<{ sha256: string; bytes: number }> {
  const label = options.label ?? "file";
  let bytes = 0;
  const hash = createHash("sha256");

  try {
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw new FrameyardError("CANCELLED", "Operation cancelled.");
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      hash.update(buffer);
    }
  } catch (error) {
    if (error instanceof FrameyardError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrameyardError("ASSET_NOT_FOUND", `Could not read ${label}: ${filePath}`, { cause: error });
    }
    throw new FrameyardError(
      "OUTPUT_FAILED",
      `Could not hash ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return { sha256: hash.digest("hex"), bytes };
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function readManifest(manifestPath: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts: [] };
    }
    throw new FrameyardError(
      "MANIFEST_INVALID",
      `Could not read provenance manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new FrameyardError(
      "MANIFEST_INVALID",
      `Provenance manifest ${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return parseManifest(parsed);
  } catch (error) {
    if (error instanceof FrameyardError) {
      throw new FrameyardError(error.code, `${manifestPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export function upsertArtifact(manifest: Manifest, artifact: ManifestArtifact): Manifest {
  const artifacts = manifest.artifacts.filter((entry) => entry.path !== artifact.path);
  artifacts.push(artifact);
  artifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts };
}

export async function stageManifest(manifest: Manifest, manifestPath: string): Promise<string> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = temporaryPath(manifestPath, "manifest");
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return tempPath;
}

/** Fails before doing inference work when an output cannot be replaced. */
export async function assertOutputAvailable(paths: readonly string[], force: boolean): Promise<void> {
  for (const outputPath of paths) {
    const kind = await fileKind(outputPath);
    if (kind === "file" && !force) {
      throw new FrameyardError(
        "OUTPUT_EXISTS",
        `Output already exists: ${outputPath}. Pass --force to replace it.`,
      );
    }
  }
}

async function fileKind(filePath: string): Promise<"missing" | "file"> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new FrameyardError("OUTPUT_FAILED", `Output path is not a regular file: ${filePath}`);
    }
    return "file";
  } catch (error) {
    if (error instanceof FrameyardError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw new FrameyardError(
      "OUTPUT_FAILED",
      `Could not inspect output path ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Publishes staged files atomically. Existing destinations are backed up and
 * restored if any part of the transaction fails.
 */
export async function publishStagedFiles(
  files: StagedFile[],
  options: { force: boolean },
): Promise<void> {
  const backups = new Map<string, string>();
  const published: string[] = [];
  const originallyMissing = new Set<string>();

  try {
    for (const file of files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      const kind = await fileKind(file.path);
      if (kind === "missing") {
        originallyMissing.add(file.path);
        continue;
      }
      if (!options.force && file.overwrite !== true) {
        throw new FrameyardError(
          "OUTPUT_EXISTS",
          `Output already exists: ${file.path} (${file.label}). Pass --force to replace it.`,
        );
      }
      const backup = temporaryPath(file.path, "backup");
      await rename(file.path, backup);
      backups.set(file.path, backup);
    }

    for (const file of files) {
      if (originallyMissing.has(file.path)) {
        try {
          await link(file.tempPath, file.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new FrameyardError(
              "OUTPUT_EXISTS",
              `Output already exists: ${file.path} (${file.label}). Pass --force to replace it.`,
              { cause: error },
            );
          }
          throw error;
        }
        await rm(file.tempPath, { force: true });
      } else {
        await rename(file.tempPath, file.path);
      }
      published.push(file.path);
    }
  } catch (error) {
    for (const publishedPath of published.reverse()) {
      await rm(publishedPath, { force: true }).catch(() => undefined);
    }
    for (const [destination, backup] of backups) {
      await rename(backup, destination).catch(() => undefined);
    }
    if (error instanceof FrameyardError) {
      throw error;
    }
    throw new FrameyardError(
      "OUTPUT_FAILED",
      `Could not publish generated assets: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    for (const backup of backups.values()) {
      await rm(backup, { force: true }).catch(() => undefined);
    }
  }
}
