import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FrameyardError } from "../errors.js";
import { normalizeAudioForTranscription } from "../renderer/ffmpeg.js";
import {
  parseTranscript,
  transcriptToSrt,
  transcriptToVtt,
  type Transcript,
  type TranscriptSegment,
  type WordTiming,
} from "../transcript.js";
import { VERSION } from "../version.js";
import { assertReadableFile, requireExtension } from "./files.js";
import { resolveExecutable } from "./executable.js";
import {
  WHISPER_CLI_COMMAND,
  WHISPER_CLI_ENV,
  WHISPER_CLI_INSTALL_HINT,
  WHISPER_CPP_REFERENCE_REVISION,
} from "./integrations.js";
import { runChild } from "./process.js";
import {
  assertOutputAvailable,
  hashFile,
  hashText,
  projectRelativePath,
  publishStagedFiles,
  readManifest,
  resolveManifestPath,
  stageManifest,
  temporaryPath,
  upsertArtifact,
  type ManifestArtifact,
  type ManifestDerived,
  type ManifestModel,
  type StagedFile,
} from "./provenance.js";

export type SubtitleFormat = "srt" | "vtt";

export interface TranscribeOptions {
  projectRoot: string;
  sourcePath: string;
  outPath: string;
  modelPath: string;
  words: boolean;
  exports: SubtitleFormat[];
  language?: string;
  executable?: string;
  manifestPath?: string;
  force: boolean;
  signal?: AbortSignal;
}

export interface ExportResult {
  format: SubtitleFormat;
  path: string;
  bytes: number;
  sha256: string;
}

export interface TranscriptionResult {
  path: string;
  bytes: number;
  sha256: string;
  source: {
    path: string;
    sha256: string;
    bytes: number;
  };
  language?: string;
  segments: number;
  words: number;
  exports: ExportResult[];
  manifest: string;
  elapsedMs: number;
}

interface WhisperOffsets {
  from?: unknown;
  to?: unknown;
}

interface WhisperToken {
  text?: unknown;
  offsets?: WhisperOffsets;
}

interface WhisperSegment {
  text?: unknown;
  offsets?: WhisperOffsets;
  tokens?: unknown;
}

interface WhisperOutput {
  result?: { language?: unknown };
  params?: { language?: unknown };
  transcription?: unknown;
}

function whisperError(message: string): never {
  throw new FrameyardError("TRANSCRIBE_FAILED", message);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function milliseconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    whisperError(`whisper.cpp produced an invalid ${label} timestamp: ${String(value)}.`);
  }
  return Math.round(value);
}

function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  return /^\[_.*\]$/.test(trimmed) || /^<\|.*\|>$/.test(trimmed);
}

function hasWordCharacter(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function deriveWords(segments: WhisperSegment[]): { words: WordTiming[]; complete: boolean } {
  const words: WordTiming[] = [];
  let complete = true;

  for (const segment of segments) {
    if (!Array.isArray(segment.tokens)) {
      if (hasWordCharacter(normalizeText(segment.text))) {
        complete = false;
      }
      continue;
    }

    let current: WordTiming | undefined;
    const flush = (): void => {
      if (current) {
        words.push(current);
        current = undefined;
      }
    };

    for (const rawToken of segment.tokens) {
      if (typeof rawToken !== "object" || rawToken === null) {
        continue;
      }
      const token = rawToken as WhisperToken;
      const text = typeof token.text === "string" ? token.text : "";
      if (text.length === 0 || isSpecialToken(text)) {
        continue;
      }
      if (text.trim().length === 0) {
        flush();
        continue;
      }

      const rawFrom = token.offsets?.from;
      const rawTo = token.offsets?.to;
      if (
        typeof rawFrom !== "number" ||
        !Number.isFinite(rawFrom) ||
        rawFrom < 0 ||
        typeof rawTo !== "number" ||
        !Number.isFinite(rawTo) ||
        rawTo < 0
      ) {
        // Without measured token offsets there is no word timing to report.
        if (hasWordCharacter(text)) {
          complete = false;
        }
        continue;
      }
      const from = Math.round(rawFrom);
      const to = Math.round(rawTo);

      let index = 0;
      while (index < text.length) {
        if (/\s/.test(text[index] as string)) {
          flush();
          index += 1;
          continue;
        }

        let end = index;
        while (end < text.length && !/\s/.test(text[end] as string)) {
          end += 1;
        }
        const run = text.slice(index, end);
        if (run.length > 0) {
          if (current) {
            current.text += run;
            current.endMs = Math.max(current.endMs, to);
          } else {
            current = { startMs: from, endMs: Math.max(from, to), text: run };
          }
        }
        index = end;
      }
    }

    flush();
  }

  return { words, complete };
}

function whisperLanguage(output: WhisperOutput): string | undefined {
  const detected = output.result?.language;
  if (typeof detected === "string" && detected.length > 0 && detected !== "auto") {
    return detected;
  }
  const requested = output.params?.language;
  if (typeof requested === "string" && requested.length > 0 && requested !== "auto") {
    return requested;
  }
  return undefined;
}

function convertWhisperOutput(
  value: unknown,
  source: { path: string; sha256: string; bytes: number },
  options: { words: boolean },
): Transcript {
  if (typeof value !== "object" || value === null) {
    whisperError("whisper.cpp output must be a JSON object.");
  }
  const output = value as WhisperOutput;
  if (!Array.isArray(output.transcription)) {
    whisperError("whisper.cpp output has no transcription array.");
  }

  const rawSegments = output.transcription as WhisperSegment[];
  const segments: TranscriptSegment[] = [];
  for (const [index, raw] of rawSegments.entries()) {
    if (typeof raw !== "object" || raw === null) {
      whisperError(`whisper.cpp transcription segment ${index} is not an object.`);
    }
    const text = normalizeText(raw.text);
    if (text.length === 0) {
      continue;
    }
    const startMs = milliseconds(raw.offsets?.from, `segment ${index} start`);
    const endMs = milliseconds(raw.offsets?.to, `segment ${index} end`);
    segments.push({
      startMs,
      endMs: Math.max(startMs, endMs),
      text,
    });
  }

  const text = segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();
  const language = whisperLanguage(output);
  const transcript: Transcript = {
    schemaVersion: 1,
    text,
    source,
    segments,
  };
  if (language !== undefined) {
    transcript.language = language;
  }
  if (options.words) {
    const derived = deriveWords(rawSegments);
    if (!derived.complete || derived.words.length === 0) {
      throw new FrameyardError(
        "TRANSCRIPT_WORDS_UNAVAILABLE",
        "whisper.cpp did not return complete measured word timings. Re-run without --words for a segment-only transcript.",
      );
    }
    transcript.words = derived.words;
  }

  return parseTranscript(transcript, { requireWords: options.words });
}

function exportPaths(
  outPath: string,
  formats: readonly SubtitleFormat[],
): Array<{ format: SubtitleFormat; path: string }> {
  const stem = outPath.toLowerCase().endsWith(".json") ? outPath.slice(0, -5) : outPath;
  return formats.map((format) => ({ format, path: `${stem}.${format}` }));
}

export async function transcribeAudio(options: TranscribeOptions): Promise<TranscriptionResult> {
  const startedAt = performance.now();
  const outPath = path.resolve(options.outPath);
  requireExtension(outPath, ".json", "Transcript output");

  const sourcePath = path.resolve(options.sourcePath);
  const modelPath = path.resolve(options.modelPath);
  const formats = [...new Set(options.exports)];
  const exports = exportPaths(outPath, formats);
  await assertOutputAvailable([outPath, ...exports.map((entry) => entry.path)], options.force);
  for (const destination of [outPath, ...exports.map((entry) => entry.path)]) {
    try {
      await mkdir(path.dirname(destination), { recursive: true });
    } catch (error) {
      throw new FrameyardError(
        "OUTPUT_FAILED",
        `Could not create an output directory for ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const sourceBytes = await assertReadableFile(sourcePath, "Transcription source");
  const modelBytes = await assertReadableFile(modelPath, "Whisper GGML model");

  const executable = await resolveExecutable({
    command: WHISPER_CLI_COMMAND,
    ...(options.executable !== undefined ? { explicit: options.executable } : {}),
    envVar: WHISPER_CLI_ENV,
    installHint: WHISPER_CLI_INSTALL_HINT,
  });

  const manifestPath = resolveManifestPath(options.projectRoot, options.manifestPath);
  if (path.resolve(manifestPath) === outPath) {
    throw new FrameyardError(
      "OUTPUT_FAILED",
      "The provenance manifest cannot also be the canonical transcript output path.",
    );
  }
  const manifest = await readManifest(manifestPath);

  const sourceIdentity = await hashFile(sourcePath, {
    signal: options.signal,
    label: "transcription source",
  });
  const modelIdentity = await hashFile(modelPath, {
    signal: options.signal,
    label: "Whisper GGML model",
  });

  const scratchDir = await mkdtemp(path.join(tmpdir(), "frameyard-transcribe-"));
  const normalizedPath = path.join(scratchDir, "source-16k-mono.wav");
  const whisperBase = path.join(scratchDir, "transcript");
  const whisperJsonPath = `${whisperBase}.json`;
  const transcriptTemp = temporaryPath(outPath, "transcript");
  const exportTemps = exports.map((entry) => temporaryPath(entry.path, entry.format));
  let manifestTemp: string | undefined;

  try {
    if (options.signal?.aborted) {
      throw new FrameyardError("CANCELLED", "Operation cancelled.");
    }

    await normalizeAudioForTranscription({
      inputPath: sourcePath,
      outputPath: normalizedPath,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const args = [
      "-m",
      modelPath,
      "-f",
      normalizedPath,
      "-ojf",
      "-of",
      whisperBase,
      "-l",
      options.language ?? "auto",
      "-np",
    ];

    await runChild(executable.path, args, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      errorCode: "TRANSCRIBE_FAILED",
      label: "whisper-cli",
      executableHint: WHISPER_CLI_INSTALL_HINT,
      forwardOutput: true,
    });

    let raw: string;
    try {
      raw = await readFile(whisperJsonPath, "utf8");
    } catch {
      throw new FrameyardError("TRANSCRIBE_FAILED", `whisper-cli did not write its JSON output at ${whisperJsonPath}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new FrameyardError(
        "TRANSCRIBE_FAILED",
        `whisper-cli produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const source = {
      path: projectRelativePath(options.projectRoot, sourcePath),
      sha256: sourceIdentity.sha256,
      bytes: sourceIdentity.bytes,
    };
    const transcript = convertWhisperOutput(parsed, source, { words: options.words });

    const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
    await writeFile(transcriptTemp, transcriptText, "utf8");

    const derived: ManifestDerived[] = [];
    const exportResults: ExportResult[] = [];
    for (const [index, entry] of exports.entries()) {
      const content = entry.format === "srt" ? transcriptToSrt(transcript) : transcriptToVtt(transcript);
      const tempPath = exportTemps[index] as string;
      await writeFile(tempPath, content, "utf8");
      const sha256 = hashText(content);
      const bytes = Buffer.byteLength(content, "utf8");
      const relative = projectRelativePath(options.projectRoot, entry.path);
      derived.push({ path: relative, format: entry.format, sha256, bytes });
      exportResults.push({ format: entry.format, path: entry.path, bytes, sha256 });
    }

    const models: ManifestModel[] = [
      {
        role: "whisper",
        path: projectRelativePath(options.projectRoot, modelPath),
        sha256: modelIdentity.sha256,
        bytes: modelIdentity.bytes,
      },
    ];

    const artifact: ManifestArtifact = {
      path: projectRelativePath(options.projectRoot, outPath),
      kind: "transcript",
      operation: "transcribe",
      sha256: hashText(transcriptText),
      bytes: Buffer.byteLength(transcriptText, "utf8"),
      createdAt: new Date().toISOString(),
      generator: {
        name: "frameyard",
        version: VERSION,
        command: "transcribe",
        executable: executable.path,
        integration: "whisper.cpp",
        referenceRevision: WHISPER_CPP_REFERENCE_REVISION,
      },
      models,
      parameters: {
        words: options.words,
        language: options.language ?? "auto",
        normalization: {
          sampleRate: 16_000,
          channels: 1,
          codec: "pcm_s16le",
        },
        exports: [...formats],
        sourceBytes: sourceBytes,
        modelBytes: modelBytes,
      },
      source,
    };
    if (derived.length > 0) {
      artifact.derived = derived;
    }

    const updatedManifest = upsertArtifact(manifest, artifact);
    manifestTemp = await stageManifest(updatedManifest, manifestPath);

    const staged: StagedFile[] = [{ tempPath: transcriptTemp, path: outPath, label: "transcript" }];
    for (const [index, entry] of exports.entries()) {
      staged.push({
        tempPath: exportTemps[index] as string,
        path: entry.path,
        label: entry.format,
      });
    }
    staged.push({ tempPath: manifestTemp, path: manifestPath, label: "provenance manifest", overwrite: true });
    await publishStagedFiles(staged, { force: options.force });

    const result: TranscriptionResult = {
      path: outPath,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      source,
      segments: transcript.segments.length,
      words: transcript.words?.length ?? 0,
      exports: exportResults,
      manifest: manifestPath,
      elapsedMs: performance.now() - startedAt,
    };
    if (transcript.language !== undefined) {
      result.language = transcript.language;
    }
    return result;
  } finally {
    await rm(transcriptTemp, { force: true });
    for (const tempPath of exportTemps) {
      await rm(tempPath, { force: true });
    }
    if (manifestTemp) {
      await rm(manifestTemp, { force: true });
    }
    await rm(scratchDir, { recursive: true, force: true });
  }
}
