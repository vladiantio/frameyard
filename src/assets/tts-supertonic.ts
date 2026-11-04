import path from "node:path";
import { FrameyardError, isFrameyardError } from "../errors.js";
import { assertReadableFile } from "./files.js";

/** The pinned sherpa-onnx Supertonic 3 archive this wrapper targets. */
export const SUPERTONIC_MODEL_ARCHIVE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";

/** The language codes accepted by the sherpa-onnx Supertonic 3 CLI. */
export const SUPERTONIC_LANGUAGES = [
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "tr",
  "uk",
  "vi",
] as const;

const SUPERTONIC_LANGUAGE_SET: ReadonlySet<string> = new Set(SUPERTONIC_LANGUAGES);

export function isSupertonicLanguage(value: string): boolean {
  return SUPERTONIC_LANGUAGE_SET.has(value);
}

interface SupertonicModelSpec {
  role: string;
  names: readonly string[];
  flag: string;
}

const SUPERTONIC_MODEL_SPECS: readonly SupertonicModelSpec[] = [
  {
    role: "duration-predictor",
    names: ["duration_predictor.int8.onnx", "duration_predictor.onnx"],
    flag: "--supertonic-duration-predictor",
  },
  {
    role: "text-encoder",
    names: ["text_encoder.int8.onnx", "text_encoder.onnx"],
    flag: "--supertonic-text-encoder",
  },
  {
    role: "vector-estimator",
    names: ["vector_estimator.int8.onnx", "vector_estimator.onnx"],
    flag: "--supertonic-vector-estimator",
  },
  {
    role: "vocoder",
    names: ["vocoder.int8.onnx", "vocoder.onnx"],
    flag: "--supertonic-vocoder",
  },
  {
    role: "tts-json",
    names: ["tts.json"],
    flag: "--supertonic-tts-json",
  },
  {
    role: "unicode-indexer",
    names: ["unicode_indexer.bin"],
    flag: "--supertonic-unicode-indexer",
  },
  {
    role: "voice-style",
    names: ["voice.bin"],
    flag: "--supertonic-voice-style",
  },
];

/** The sherpa-onnx CLI flags the wrapper requires for Supertonic synthesis. */
export const SUPERTONIC_CLI_FLAGS: readonly string[] = [
  ...SUPERTONIC_MODEL_SPECS.map((spec) => spec.flag),
  "--sid",
  "--lang",
  "--output-filename",
];

export interface SupertonicModelFile {
  role: string;
  path: string;
  bytes: number;
  flag: string;
  variant?: "int8" | "fp32";
}

async function resolveSupertonicModelFile(modelDir: string, spec: SupertonicModelSpec): Promise<SupertonicModelFile> {
  const candidates = spec.names.map((name) => path.join(modelDir, name));
  const isOnnx = spec.names.some((name) => name.endsWith(".onnx"));
  for (const candidate of candidates) {
    try {
      const bytes = await assertReadableFile(candidate, `Supertonic ${spec.role} model`);
      const variant: "int8" | "fp32" = candidate.endsWith(".int8.onnx") ? "int8" : "fp32";
      return {
        role: spec.role,
        path: candidate,
        bytes,
        flag: spec.flag,
        ...(isOnnx ? { variant } : {}),
      };
    } catch (error) {
      if (isFrameyardError(error) && error.code === "ASSET_NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }
  throw new FrameyardError(
    "ASSET_NOT_FOUND",
    `Supertonic model file is missing: ${candidates.join(" or ")}. Download ${SUPERTONIC_MODEL_ARCHIVE} and pass its directory with --model-dir.`,
  );
}

/** Resolves every model file the sherpa-onnx Supertonic CLI needs from one directory. */
export async function resolveSupertonicModelFiles(modelDir: string): Promise<SupertonicModelFile[]> {
  const absolute = path.resolve(modelDir);
  const files: SupertonicModelFile[] = [];
  for (const spec of SUPERTONIC_MODEL_SPECS) {
    files.push(await resolveSupertonicModelFile(absolute, spec));
  }
  return files;
}

/** Names the pinned archive only when every ONNX file is the pinned int8 variant. */
export function resolveSupertonicModelArchive(files: readonly SupertonicModelFile[]): string {
  return files.every((file) => file.variant === undefined || file.variant === "int8")
    ? SUPERTONIC_MODEL_ARCHIVE
    : "custom";
}

export function parseSupertonicSpeaker(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new FrameyardError("TTS_FAILED", `Supertonic speakers are numeric ids; received "${value}".`);
  }
  const sid = Number(value);
  if (!Number.isSafeInteger(sid) || sid > 2_147_483_647) {
    throw new FrameyardError("TTS_FAILED", `Supertonic speaker id is out of range: ${value}.`);
  }
  return sid;
}

export function requireSupertonicLanguage(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new FrameyardError("TTS_FAILED", "Supertonic synthesis requires a language code.");
  }
  if (!isSupertonicLanguage(value)) {
    throw new FrameyardError(
      "TTS_FAILED",
      `Unsupported Supertonic language "${value}". Supported codes: ${SUPERTONIC_LANGUAGES.join(", ")}.`,
    );
  }
  return value;
}

export function buildSupertonicArgs(options: {
  files: readonly SupertonicModelFile[];
  sid: number;
  language: string;
  outputPath: string;
  text: string;
}): string[] {
  return [
    ...options.files.map((file) => `${file.flag}=${file.path}`),
    `--sid=${options.sid}`,
    `--lang=${options.language}`,
    `--output-filename=${options.outputPath}`,
    "--",
    options.text,
  ];
}
