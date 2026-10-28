import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ResolvedTranscriptClip } from "../contracts.js";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { parseTranscript, type Transcript } from "../transcript.js";

export interface TranscriptAsset {
  clip: ResolvedTranscriptClip;
  path: string;
  bytes: number;
  transcript: Transcript;
}

export interface TranscriptInspection {
  assets: TranscriptAsset[];
  clips: Array<{
    src: string;
    language?: string;
    segments: number;
    words?: number;
    durationMs: number;
    bytes: number;
  }>;
  warnings: string[];
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function transcriptError(src: string, error: unknown): FrameyardError {
  if (isFrameyardError(error)) {
    return new FrameyardError(error.code, `Transcript "${src}": ${error.message}`, { cause: error });
  }
  return new FrameyardError(
    "TRANSCRIPT_INVALID",
    `Transcript "${src}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * Resolves transcript requirements declared by a composition, validates their
 * canonical JSON, and reports missing measured word timings when required.
 */
export async function inspectTranscriptClips(options: {
  projectRoot: string;
  clips: readonly ResolvedTranscriptClip[];
  signal?: AbortSignal;
}): Promise<TranscriptInspection> {
  const assets: TranscriptAsset[] = [];
  const warnings: string[] = [];

  for (const clip of options.clips) {
    if (options.signal?.aborted) {
      throw new FrameyardError("CANCELLED", "Operation cancelled.");
    }

    const absolutePath = path.resolve(options.projectRoot, clip.src);
    if (!contains(options.projectRoot, absolutePath)) {
      throw new FrameyardError(
        "TRANSCRIPT_INVALID",
        `Transcript source escapes the project root: ${clip.src}`,
      );
    }

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new FrameyardError("ASSET_NOT_FOUND", `Transcript source does not exist: ${clip.src}`);
    }
    if (!fileStat.isFile()) {
      throw new FrameyardError("ASSET_NOT_FOUND", `Transcript source is not a file: ${clip.src}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch (error) {
      throw transcriptError(clip.src, error);
    }

    let transcript: Transcript;
    try {
      transcript = parseTranscript(parsed, { requireWords: clip.words });
    } catch (error) {
      throw transcriptError(clip.src, error);
    }

    if (transcript.text.trim().length === 0) {
      warnings.push(`Transcript "${clip.src}" has no text.`);
    }
    if (transcript.segments.length === 0) {
      warnings.push(`Transcript "${clip.src}" has no timed segments.`);
    }

    assets.push({
      clip,
      path: absolutePath,
      bytes: fileStat.size,
      transcript,
    });
  }

  return {
    assets,
    clips: assets.map((asset) => {
      const clip: TranscriptInspection["clips"][number] = {
        src: asset.clip.src,
        segments: asset.transcript.segments.length,
        durationMs:
          asset.transcript.segments.at(-1)?.endMs ??
          asset.transcript.words?.at(-1)?.endMs ??
          0,
        bytes: asset.bytes,
      };
      if (asset.transcript.language !== undefined) {
        clip.language = asset.transcript.language;
      }
      if (asset.transcript.words !== undefined) {
        clip.words = asset.transcript.words.length;
      }
      return clip;
    }),
    warnings,
  };
}
