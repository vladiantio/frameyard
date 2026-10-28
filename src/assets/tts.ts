import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { FrameyardError } from "../errors.js";
import { probeMedia } from "../renderer/ffmpeg.js";
import { VERSION } from "../version.js";
import { assertReadableFile, requireExtension } from "./files.js";
import { resolveExecutable } from "./executable.js";
import {
  QWEN_TTS_COMMAND,
  QWEN_TTS_ENV,
  QWEN_TTS_INSTALL_HINT,
  QWEN_TTS_REFERENCE_REVISION,
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

export interface SynthesizeSpeechOptions {
  projectRoot: string;
  text: string;
  speaker: string;
  talkerModelPath: string;
  codecModelPath: string;
  outPath: string;
  style?: string;
  language?: string;
  executable?: string;
  manifestPath?: string;
  force: boolean;
  signal?: AbortSignal;
}

export interface SpeechResult {
  path: string;
  bytes: number;
  sha256: string;
  sampleRate: number;
  channels: number;
  speaker: string;
  language?: string;
  manifest: string;
  elapsedMs: number;
}

export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SpeechResult> {
  const startedAt = performance.now();
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

  const manifestPath = resolveManifestPath(options.projectRoot, options.manifestPath);
  const manifest = await readManifest(manifestPath);

  const talkerIdentity = await hashFile(talkerModelPath, {
    signal: options.signal,
    label: "talker GGUF model",
  });
  const codecIdentity = await hashFile(codecModelPath, {
    signal: options.signal,
    label: "codec GGUF model",
  });

  const tempOut = temporaryPath(outPath, "tts");

  try {
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
      tempOut,
    ];
    if (options.language !== undefined) {
      args.push("--lang", options.language);
    }
    if (options.style !== undefined) {
      args.push("--instruct", options.style);
    }

    await runChild(executable.path, args, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      stdin: text,
      errorCode: "TTS_FAILED",
      label: "qwen-tts",
      executableHint: QWEN_TTS_INSTALL_HINT,
      forwardOutput: true,
    });

    let info;
    try {
      info = await stat(tempOut);
    } catch {
      throw new FrameyardError("TTS_FAILED", `qwen-tts did not write the requested WAV file: ${outPath}`);
    }
    if (!info.isFile() || info.size === 0) {
      throw new FrameyardError("TTS_FAILED", `qwen-tts produced an empty WAV file: ${outPath}`);
    }

    const probe = await probeMedia(tempOut, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    const sampleRate = Number(audio?.sample_rate);
    const channels = Number(audio?.channels);
    const formatName = probe.format?.format_name ?? "";
    if (!audio || sampleRate !== 24_000 || channels !== 1 || !formatName.includes("wav")) {
      throw new FrameyardError(
        "TTS_FAILED",
        `qwen-tts must produce a 24 kHz mono WAV; received ${String(audio?.sample_rate ?? "unknown")} Hz, ${String(audio?.channels ?? "unknown")} channel(s), format "${formatName || "unknown"}".`,
      );
    }

    const artifactIdentity = await hashFile(tempOut, {
      signal: options.signal,
      label: "generated WAV",
    });

    const models: ManifestModel[] = [
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
    ];

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
        executable: executable.path,
        integration: "qwentts.cpp",
        referenceRevision: QWEN_TTS_REFERENCE_REVISION,
      },
      models,
      parameters: {
        speaker: options.speaker,
        language: options.language ?? null,
        style: options.style ?? null,
        format: "wav16",
        sampleRate: 24_000,
        channels: 1,
        textSha256: hashText(text),
        textBytes: Buffer.byteLength(text, "utf8"),
        textCharacters: text.length,
        talkerModelBytes: talkerBytes,
        codecModelBytes: codecBytes,
      },
    };

    const updatedManifest = upsertArtifact(manifest, artifact);
    const manifestTemp = await stageManifest(updatedManifest, manifestPath);
    try {
      await publishStagedFiles(
        [
          { tempPath: tempOut, path: outPath, label: "speech" },
          { tempPath: manifestTemp, path: manifestPath, label: "provenance manifest", overwrite: true },
        ],
        { force: options.force },
      );
    } finally {
      await rm(manifestTemp, { force: true });
    }

    const result: SpeechResult = {
      path: outPath,
      bytes: artifactIdentity.bytes,
      sha256: artifactIdentity.sha256,
      sampleRate: 24_000,
      channels: 1,
      speaker: options.speaker,
      manifest: manifestPath,
      elapsedMs: performance.now() - startedAt,
    };
    if (options.language !== undefined) {
      result.language = options.language;
    }
    return result;
  } finally {
    await rm(tempOut, { force: true });
  }
}
