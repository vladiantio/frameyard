import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { normalizeSpeechAudio, probeMedia } from "../renderer/ffmpeg.js";
import { VERSION } from "../version.js";
import { resolveExecutable, type ResolvedExecutable } from "./executable.js";
import { assertReadableFile, requireExtension } from "./files.js";
import {
  QWEN_TTS_COMMAND,
  QWEN_TTS_ENV,
  QWEN_TTS_INSTALL_HINT,
  QWEN_TTS_REFERENCE_REVISION,
  SHERPA_ONNX_TTS_COMMAND,
  SHERPA_ONNX_TTS_ENV,
  SHERPA_ONNX_TTS_INSTALL_HINT,
  SHERPA_ONNX_REFERENCE_REVISION,
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
  type ManifestModel,
} from "./provenance.js";
import {
  buildSupertonicArgs,
  parseSupertonicSpeaker,
  requireSupertonicLanguage,
  resolveSupertonicModelArchive,
  resolveSupertonicModelFiles,
} from "./tts-supertonic.js";

export type SpeechEngine = "qwen" | "supertonic";

interface SpeechOptionsBase {
  projectRoot: string;
  text: string;
  speaker: string;
  outPath: string;
  executable?: string;
  manifestPath?: string;
  force: boolean;
  signal?: AbortSignal;
}

export interface QwenSpeechOptions extends SpeechOptionsBase {
  engine?: "qwen";
  talkerModelPath: string;
  codecModelPath: string;
  style?: string;
  language?: string;
  device?: string;
}

export interface SupertonicSpeechOptions extends SpeechOptionsBase {
  engine: "supertonic";
  modelDir: string;
  language: string;
}

export type SynthesizeSpeechOptions = QwenSpeechOptions | SupertonicSpeechOptions;

export interface SpeechResult {
  engine: SpeechEngine;
  path: string;
  bytes: number;
  sha256: string;
  sampleRate: number;
  channels: number;
  speaker: string;
  language?: string;
  device?: string;
  manifest: string;
  elapsedMs: number;
}

interface EngineInvocation {
  executable: ResolvedExecutable;
  args: string[];
  stdin?: string;
  label: string;
  installHint: string;
  integration: "qwentts.cpp" | "sherpa-onnx";
  referenceRevision: string;
  models: ManifestModel[];
  parameters: Record<string, JsonValue>;
  normalize: boolean;
}

interface AudioProbe {
  sampleRate: number;
  channels: number;
  formatName: string;
}

function requireSpeechEngine(value: unknown): SpeechEngine {
  if (value === undefined || value === "qwen") {
    return "qwen";
  }
  if (value === "supertonic") {
    return "supertonic";
  }
  throw new FrameyardError("TTS_FAILED", `Unknown speech engine "${String(value)}".`);
}

async function probeAudio(filePath: string, signal?: AbortSignal): Promise<AudioProbe> {
  const probe = await probeMedia(filePath, signal !== undefined ? { signal } : {});
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  return {
    sampleRate: Number(audio?.sample_rate),
    channels: Number(audio?.channels),
    formatName: probe.format?.format_name ?? "",
  };
}

function speechTextParameters(text: string): {
  format: "wav16";
  sampleRate: number;
  channels: number;
  textSha256: string;
  textBytes: number;
  textCharacters: number;
} {
  return {
    format: "wav16",
    sampleRate: 24_000,
    channels: 1,
    textSha256: hashText(text),
    textBytes: Buffer.byteLength(text, "utf8"),
    textCharacters: text.length,
  };
}

async function prepareQwenInvocation(options: QwenSpeechOptions, rawOut: string): Promise<EngineInvocation> {
  if (typeof options.talkerModelPath !== "string" || typeof options.codecModelPath !== "string") {
    throw new FrameyardError("TTS_FAILED", "Qwen speech synthesis requires talker and codec model paths.");
  }

  const talkerModelPath = path.resolve(options.talkerModelPath);
  const codecModelPath = path.resolve(options.codecModelPath);
  const talkerBytes = await assertReadableFile(talkerModelPath, "Talker GGUF model");
  const codecBytes = await assertReadableFile(codecModelPath, "Codec GGUF model");

  const executable = await resolveExecutable({
    command: QWEN_TTS_COMMAND,
    ...(options.executable !== undefined ? { explicit: options.executable } : {}),
    envVar: QWEN_TTS_ENV,
    installHint: QWEN_TTS_INSTALL_HINT,
  });

  const talkerIdentity = await hashFile(talkerModelPath, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    label: "talker GGUF model",
  });
  const codecIdentity = await hashFile(codecModelPath, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    label: "codec GGUF model",
  });

  const args = [
    "--model",
    talkerModelPath,
    "--codec",
    codecModelPath,
    "--speaker",
    options.speaker,
    "--format",
    "wav16",
    "-o",
    rawOut,
  ];
  if (options.language !== undefined) {
    args.push("--lang", options.language);
  }
  if (options.style !== undefined) {
    args.push("--instruct", options.style);
  }
  if (options.device !== undefined) {
    args.push("--device", options.device);
  }

  return {
    executable,
    args,
    stdin: options.text,
    label: "qwen-tts",
    installHint: QWEN_TTS_INSTALL_HINT,
    integration: "qwentts.cpp",
    referenceRevision: QWEN_TTS_REFERENCE_REVISION,
    models: [
      {
        role: "talker",
        path: projectRelativePath(options.projectRoot, talkerModelPath),
        sha256: talkerIdentity.sha256,
        bytes: talkerIdentity.bytes,
      },
      {
        role: "codec",
        path: projectRelativePath(options.projectRoot, codecModelPath),
        sha256: codecIdentity.sha256,
        bytes: codecIdentity.bytes,
      },
    ],
    parameters: {
      ...speechTextParameters(options.text),
      engine: "qwen",
      speaker: options.speaker,
      language: options.language ?? null,
      style: options.style ?? null,
      device: options.device ?? null,
      talkerModelBytes: talkerBytes,
      codecModelBytes: codecBytes,
    },
    normalize: false,
  };
}

async function prepareSupertonicInvocation(
  options: SupertonicSpeechOptions,
  rawOut: string,
): Promise<EngineInvocation> {
  if (typeof options.modelDir !== "string" || options.modelDir.length === 0) {
    throw new FrameyardError("TTS_FAILED", "Supertonic synthesis requires a model directory.");
  }

  const language = requireSupertonicLanguage(options.language);
  const sid = parseSupertonicSpeaker(options.speaker);
  const modelFiles = await resolveSupertonicModelFiles(options.modelDir);

  const executable = await resolveExecutable({
    command: SHERPA_ONNX_TTS_COMMAND,
    ...(options.executable !== undefined ? { explicit: options.executable } : {}),
    envVar: SHERPA_ONNX_TTS_ENV,
    installHint: SHERPA_ONNX_TTS_INSTALL_HINT,
  });

  const models: ManifestModel[] = [];
  let modelBytes = 0;
  for (const file of modelFiles) {
    const identity = await hashFile(file.path, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      label: `Supertonic ${file.role} model`,
    });
    modelBytes += identity.bytes;
    models.push({
      role: file.role,
      path: projectRelativePath(options.projectRoot, file.path),
      sha256: identity.sha256,
      bytes: identity.bytes,
    });
  }

  return {
    executable,
    args: buildSupertonicArgs({
      files: modelFiles,
      sid,
      language,
      outputPath: rawOut,
      text: options.text,
    }),
    label: SHERPA_ONNX_TTS_COMMAND,
    installHint: SHERPA_ONNX_TTS_INSTALL_HINT,
    integration: "sherpa-onnx",
    referenceRevision: SHERPA_ONNX_REFERENCE_REVISION,
    models,
    parameters: {
      ...speechTextParameters(options.text),
      engine: "supertonic",
      speaker: options.speaker,
      language,
      modelFiles: modelFiles.length,
      modelBytes,
      modelArchive: resolveSupertonicModelArchive(modelFiles),
    },
    normalize: true,
  };
}

async function prepareInvocation(options: SynthesizeSpeechOptions, rawOut: string): Promise<EngineInvocation> {
  if (options.engine === "supertonic") {
    return prepareSupertonicInvocation(options, rawOut);
  }
  return prepareQwenInvocation(options, rawOut);
}

export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SpeechResult> {
  const startedAt = performance.now();
  const engine = requireSpeechEngine(options.engine);
  const text = options.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new FrameyardError("TTS_FAILED", "Speech synthesis requires non-empty text.");
  }
  if (typeof options.speaker !== "string" || options.speaker.trim().length === 0) {
    throw new FrameyardError("TTS_FAILED", "Speech synthesis requires a named speaker.");
  }

  requireExtension(options.outPath, ".wav", "Speech output");
  const outPath = path.resolve(options.outPath);
  await assertOutputAvailable([outPath], options.force);
  try {
    await mkdir(path.dirname(outPath), { recursive: true });
  } catch (error) {
    throw new FrameyardError(
      "OUTPUT_FAILED",
      `Could not create the speech output directory: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const rawOut = temporaryPath(outPath, "tts-raw");
  const finalOut = temporaryPath(outPath, "tts");

  try {
    const invocation = await prepareInvocation(options, rawOut);
    const manifestPath = resolveManifestPath(options.projectRoot, options.manifestPath);
    const manifest = await readManifest(manifestPath);

    await runChild(invocation.executable.path, invocation.args, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
      errorCode: "TTS_FAILED",
      label: invocation.label,
      executableHint: invocation.installHint,
      forwardOutput: true,
    });

    let info;
    try {
      info = await stat(rawOut);
    } catch {
      throw new FrameyardError("TTS_FAILED", `${invocation.label} did not write the requested WAV file: ${outPath}`);
    }
    if (!info.isFile() || info.size === 0) {
      throw new FrameyardError("TTS_FAILED", `${invocation.label} produced an empty WAV file: ${outPath}`);
    }

    const rawProbe = await probeAudio(rawOut, options.signal);
    if (!rawProbe.formatName.includes("wav")) {
      throw new FrameyardError("TTS_FAILED", `${invocation.label} did not produce a WAV file: ${outPath}`);
    }

    let artifactPath = rawOut;
    if (invocation.normalize) {
      await normalizeSpeechAudio({
        inputPath: rawOut,
        outputPath: finalOut,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      artifactPath = finalOut;
      invocation.parameters.sourceSampleRate = rawProbe.sampleRate;
      invocation.parameters.sourceChannels = rawProbe.channels;
    }

    const probe = await probeAudio(artifactPath, options.signal);
    if (probe.sampleRate !== 24_000 || probe.channels !== 1 || !probe.formatName.includes("wav")) {
      throw new FrameyardError(
        "TTS_FAILED",
        `${invocation.label} must produce a 24 kHz mono WAV; received ${String(probe.sampleRate || "unknown")} Hz, ${String(probe.channels || "unknown")} channel(s), format "${probe.formatName || "unknown"}".`,
      );
    }

    const artifactIdentity = await hashFile(artifactPath, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      label: "generated WAV",
    });

    const artifact: ManifestArtifact = {
      path: projectRelativePath(options.projectRoot, outPath),
      kind: "audio",
      operation: "tts",
      sha256: artifactIdentity.sha256,
      bytes: artifactIdentity.bytes,
      createdAt: new Date().toISOString(),
      generator: {
        name: "frameyard",
        version: VERSION,
        command: "tts",
        executable: invocation.executable.path,
        integration: invocation.integration,
        referenceRevision: invocation.referenceRevision,
      },
      models: invocation.models,
      parameters: invocation.parameters,
    };

    const updatedManifest = upsertArtifact(manifest, artifact);
    const manifestTemp = await stageManifest(updatedManifest, manifestPath);
    try {
      await publishStagedFiles(
        [
          { tempPath: artifactPath, path: outPath, label: "speech" },
          { tempPath: manifestTemp, path: manifestPath, label: "provenance manifest", overwrite: true },
        ],
        { force: options.force },
      );
    } finally {
      await rm(manifestTemp, { force: true });
    }

    const result: SpeechResult = {
      engine,
      path: outPath,
      bytes: artifactIdentity.bytes,
      sha256: artifactIdentity.sha256,
      sampleRate: 24_000,
      channels: 1,
      speaker: options.speaker,
      manifest: manifestPath,
      elapsedMs: performance.now() - startedAt,
    };
    if (options.engine === "supertonic") {
      result.language = options.language;
    } else {
      if (options.language !== undefined) {
        result.language = options.language;
      }
      if (options.device !== undefined) {
        result.device = options.device;
      }
    }
    return result;
  } finally {
    await rm(rawOut, { force: true });
    await rm(finalOut, { force: true });
  }
}
