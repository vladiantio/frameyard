import { isPlainObject } from "./contracts.js";
import { FrameyardError } from "./errors.js";

export const TRANSCRIPT_SCHEMA_VERSION = 1;

export interface TranscriptSource {
  /** Project-relative path when the source is inside the project; otherwise an absolute path. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface TranscriptSegment {
  /** Integer milliseconds from the start of the source audio. */
  startMs: number;
  /** Integer milliseconds from the start of the source audio. */
  endMs: number;
  text: string;
}

export interface WordTiming {
  /** Integer milliseconds from the start of the source audio. */
  startMs: number;
  /** Integer milliseconds from the start of the source audio. */
  endMs: number;
  text: string;
}

export interface Transcript {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  text: string;
  language?: string;
  source: TranscriptSource;
  segments: TranscriptSegment[];
  /** Measured word timings. Never interpolated from segment timings. */
  words?: WordTiming[];
}

export interface ParseTranscriptOptions {
  /** Fail when the transcript has no actual word timings. */
  requireWords?: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/i;

function invalid(message: string): never {
  throw new FrameyardError("TRANSCRIPT_INVALID", message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireMilliseconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${label} must be an integer milliseconds value greater than or equal to zero.`);
  }
  return value;
}

function parseTimedText(value: unknown, label: string): TranscriptSegment {
  if (!isPlainObject(value)) {
    invalid(`${label} must be a plain object.`);
  }

  const startMs = requireMilliseconds(value.startMs, `${label}.startMs`);
  const endMs = requireMilliseconds(value.endMs, `${label}.endMs`);
  if (endMs < startMs) {
    invalid(`${label}.endMs must be greater than or equal to ${label}.startMs.`);
  }

  return {
    startMs,
    endMs,
    text: requireString(value.text, `${label}.text`),
  };
}

function parseTimedTextList(value: unknown, label: string): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    invalid(`${label} must be an array.`);
  }

  const result: TranscriptSegment[] = [];
  let previousStart = -1;
  for (const [index, item] of value.entries()) {
    const parsed = parseTimedText(item, `${label}[${index}]`);
    if (parsed.startMs < previousStart) {
      invalid(`${label} must be ordered by startMs.`);
    }
    previousStart = parsed.startMs;
    result.push(parsed);
  }
  return result;
}

/**
 * Validates a canonical Frameyard transcript and returns a normalized copy.
 * Timestamps stay in integer milliseconds relative to the source audio.
 */
export function parseTranscript(value: unknown, options: ParseTranscriptOptions = {}): Transcript {
  if (!isPlainObject(value)) {
    invalid("A transcript must be a plain JSON object.");
  }

  if (value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
    invalid(`Transcript schemaVersion must be ${TRANSCRIPT_SCHEMA_VERSION}; received ${String(value.schemaVersion)}.`);
  }

  if (typeof value.text !== "string") {
    invalid("Transcript text must be a string.");
  }

  const source = value.source;
  if (!isPlainObject(source)) {
    invalid("Transcript source must be a plain object.");
  }

  const sourcePath = requireString(source.path, "Transcript source.path");
  const sourceSha256 = requireString(source.sha256, "Transcript source.sha256");
  if (!SHA256.test(sourceSha256)) {
    invalid("Transcript source.sha256 must be a 64-character SHA-256 hex digest.");
  }
  const sourceBytes = source.bytes;
  if (typeof sourceBytes !== "number" || !Number.isInteger(sourceBytes) || sourceBytes < 0) {
    invalid("Transcript source.bytes must be a non-negative integer.");
  }

  const transcript: Transcript = {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    text: value.text,
    source: {
      path: sourcePath,
      sha256: sourceSha256,
      bytes: sourceBytes,
    },
    segments: parseTimedTextList(value.segments, "Transcript segments"),
  };

  if (value.language !== undefined) {
    transcript.language = requireString(value.language, "Transcript language");
  }

  if (value.words !== undefined) {
    const words = parseTimedTextList(value.words, "Transcript words");
    for (const [index, word] of words.entries()) {
      if (word.text.trim().length === 0) {
        invalid(`Transcript words[${index}].text must be a non-empty string.`);
      }
    }
    transcript.words = words;
  }

  if (options.requireWords && (transcript.words === undefined || transcript.words.length === 0)) {
    throw new FrameyardError(
      "TRANSCRIPT_WORDS_UNAVAILABLE",
      "This transcript has no measured word timings. Karaoke highlighting requires word timings; re-run `frameyard transcribe --words` against the source audio.",
    );
  }

  return Object.freeze(transcript);
}

function timestamp(milliseconds: number, separator: "," | "."): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const ms = milliseconds % 1000;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(ms, 3)}`;
}

/** Renders the canonical transcript's segment timings as SRT. */
export function transcriptToSrt(transcript: Transcript): string {
  if (transcript.segments.length === 0) {
    return "";
  }

  return `${transcript.segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.startMs, ",")} --> ${timestamp(segment.endMs, ",")}\n${segment.text}`,
    )
    .join("\n\n")}\n`;
}

/** Renders the canonical transcript's segment timings as WebVTT. */
export function transcriptToVtt(transcript: Transcript): string {
  const cues = transcript.segments
    .map((segment) => `${timestamp(segment.startMs, ".")} --> ${timestamp(segment.endMs, ".")}\n${segment.text}`)
    .join("\n\n");

  return cues.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${cues}\n`;
}
