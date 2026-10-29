import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { FrameyardError, isFrameyardError } from "./errors.js";
import { resolveExecutable, type ResolvedExecutable } from "./assets/executable.js";
import {
  QWEN_TTS_COMMAND,
  QWEN_TTS_ENV,
  QWEN_TTS_INSTALL_HINT,
  QWEN_TTS_REFERENCE_REVISION,
  WHISPER_CLI_COMMAND,
  WHISPER_CLI_ENV,
  WHISPER_CLI_INSTALL_HINT,
  WHISPER_CPP_REFERENCE_REVISION,
} from "./assets/integrations.js";
import { runChild } from "./assets/process.js";
import { hashFile, readManifest } from "./assets/provenance.js";

export type DoctorStatus = "ok" | "error";

export interface DoctorCheck {
  name: string;
  required: boolean;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorIntegration {
  name: string;
  status: "ok" | "missing" | "incompatible";
  requested: boolean;
  executable?: string;
  source?: ResolvedExecutable["source"];
  version?: string;
  capabilities?: string[];
  detail?: string;
  referenceRevision: string;
}

export interface DoctorManifest {
  path: string;
  exists: boolean;
  valid: boolean;
  artifacts: number;
  detail?: string;
}

export interface DoctorModel {
  role: "talker" | "codec" | "whisper";
  path: string;
  status: "ok" | "error";
  bytes?: number;
  sha256?: string;
  detail?: string;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
  integrations: {
    tts: DoctorIntegration;
    transcribe: DoctorIntegration;
  };
  manifest: DoctorManifest;
  models: DoctorModel[];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a - b;
    }
  }
  return 0;
}

async function probeCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; executable?: string; allowFailure?: boolean } = {},
): Promise<{ ok: true; stdout: string; stderr: string; code: number } | { ok: false; detail: string }> {
  try {
    const result = await runChild(options.executable ?? command, args, {
      signal: options.signal,
      forwardOutput: false,
      errorCode: "INTERNAL",
      label: path.basename(options.executable ?? command),
      allowFailure: options.allowFailure === true,
    });
    return { ok: true, ...result };
  } catch (error) {
    if (isFrameyardError(error) && error.code === "CANCELLED") {
      throw error;
    }
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

async function checkChromium(): Promise<DoctorCheck> {
  try {
    const executable = chromium.executablePath();
    const info = await stat(executable);
    if (!info.isFile()) {
      return {
        name: "chromium",
        required: true,
        status: "error",
        detail: `Playwright Chromium is not a file: ${executable}`,
      };
    }
    await access(executable, constants.X_OK);
    return { name: "chromium", required: true, status: "ok", detail: executable };
  } catch (error) {
    return {
      name: "chromium",
      required: true,
      status: "error",
      detail: `Playwright Chromium is unavailable. Run "npx playwright install chromium". ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function inspectManifest(
  manifestPath: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<{ manifest: DoctorManifest; check: DoctorCheck }> {
  if (signal?.aborted) {
    throw new FrameyardError("CANCELLED", "Operation cancelled.");
  }
  let info;
  try {
    info = await stat(manifestPath);
  } catch {
    return {
      manifest: { path: manifestPath, exists: false, valid: true, artifacts: 0 },
      check: {
        name: "manifest",
        required: false,
        status: "ok",
        detail: "No provenance manifest yet.",
      },
    };
  }

  if (!info.isFile()) {
    return {
      manifest: {
        path: manifestPath,
        exists: true,
        valid: false,
        artifacts: 0,
        detail: "Manifest path is not a regular file.",
      },
      check: {
        name: "manifest",
        required: false,
        status: "error",
        detail: `${manifestPath} is not a regular file.`,
      },
    };
  }

  let manifest;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    return {
      manifest: {
        path: manifestPath,
        exists: true,
        valid: false,
        artifacts: 0,
        detail: error instanceof Error ? error.message : String(error),
      },
      check: {
        name: "manifest",
        required: false,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const problems: string[] = [];

  const verifyIdentity = async (
    identity: { path: string; sha256: string; bytes: number },
    label: string,
  ): Promise<void> => {
    const artifactPath = path.isAbsolute(identity.path) ? identity.path : path.resolve(projectRoot, identity.path);
    try {
      const artifactInfo = await stat(artifactPath);
      if (!artifactInfo.isFile()) {
        problems.push(`${label} (${identity.path}): not a file`);
        return;
      }
      if (artifactInfo.size !== identity.bytes) {
        problems.push(
          `${label} (${identity.path}): size changed (${artifactInfo.size} bytes, expected ${identity.bytes})`,
        );
        return;
      }
      if (signal?.aborted) {
        throw new FrameyardError("CANCELLED", "Operation cancelled.");
      }
      const actual = await hashFile(artifactPath, { signal });
      if (actual.sha256 !== identity.sha256) {
        problems.push(`${label} (${identity.path}): content hash does not match the manifest`);
      }
    } catch (error) {
      if (error instanceof FrameyardError && error.code === "CANCELLED") {
        throw error;
      }
      problems.push(`${label} (${identity.path}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const artifact of manifest.artifacts) {
    if (signal?.aborted) {
      throw new FrameyardError("CANCELLED", "Operation cancelled.");
    }
    await verifyIdentity(artifact, "artifact");
    if (artifact.source) {
      await verifyIdentity(artifact.source, "source");
    }
    for (const model of artifact.models) {
      await verifyIdentity(model, `model ${model.role}`);
    }
    for (const derived of artifact.derived ?? []) {
      await verifyIdentity(derived, `derived ${derived.format}`);
    }
  }

  const valid = problems.length === 0;
  return {
    manifest: {
      path: manifestPath,
      exists: true,
      valid,
      artifacts: manifest.artifacts.length,
      ...(valid ? {} : { detail: problems.join("; ") }),
    },
    check: {
      name: "manifest",
      required: false,
      status: valid ? "ok" : "error",
      detail: valid
        ? `${manifest.artifacts.length} artifact${manifest.artifacts.length === 1 ? "" : "s"} verified.`
        : problems.join("; "),
    },
  };
}

function integrationFlags(help: string, flags: string[]): string[] {
  return flags.filter((flag) =>
    new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|,|$)`, "m").test(help),
  );
}

async function inspectTts(explicit: string | undefined, signal?: AbortSignal): Promise<DoctorIntegration> {
  const requested = explicit !== undefined || process.env[QWEN_TTS_ENV] !== undefined;
  let executable: ResolvedExecutable;
  try {
    executable = await resolveExecutable({
      command: QWEN_TTS_COMMAND,
      ...(explicit !== undefined ? { explicit } : {}),
      envVar: QWEN_TTS_ENV,
      installHint: QWEN_TTS_INSTALL_HINT,
    });
  } catch (error) {
    return {
      name: QWEN_TTS_COMMAND,
      status: "missing",
      requested,
      detail: error instanceof Error ? error.message : String(error),
      referenceRevision: QWEN_TTS_REFERENCE_REVISION,
    };
  }

  const help = await probeCommand(executable.path, ["--help"], {
    signal,
    allowFailure: true,
  });
  if (!help.ok) {
    return {
      name: QWEN_TTS_COMMAND,
      status: "incompatible",
      requested,
      executable: executable.path,
      source: executable.source,
      detail: help.detail,
      referenceRevision: QWEN_TTS_REFERENCE_REVISION,
    };
  }

  const text = `${help.stdout}\n${help.stderr}`;
  const capabilities = integrationFlags(text, [
    "--model",
    "--codec",
    "--speaker",
    "--lang",
    "--instruct",
    "--format",
    "--device",
    "-o",
  ]);
  const missing = ["--model", "--codec", "--speaker", "--lang", "--format", "-o"].filter(
    (flag) => !capabilities.includes(flag),
  );
  const banner = /qwentts\.cpp\s+([0-9a-f]+)\s+\(([^)]+)\)/i.exec(text);
  const result: DoctorIntegration = {
    name: QWEN_TTS_COMMAND,
    status: missing.length === 0 && banner !== null ? "ok" : "incompatible",
    requested,
    executable: executable.path,
    source: executable.source,
    capabilities,
    referenceRevision: QWEN_TTS_REFERENCE_REVISION,
  };
  if (banner) {
    result.version = `${banner[1]} (${banner[2]})`;
  }
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`Missing required CLI capabilities: ${missing.join(", ")}.`);
  }
  if (banner === null) {
    problems.push("qwen-tts did not report a qwentts.cpp revision banner.");
  }
  if (problems.length > 0) {
    result.detail = problems.join(" ");
  }
  return result;
}

async function inspectWhisper(explicit: string | undefined, signal?: AbortSignal): Promise<DoctorIntegration> {
  const requested = explicit !== undefined || process.env[WHISPER_CLI_ENV] !== undefined;
  let executable: ResolvedExecutable;
  try {
    executable = await resolveExecutable({
      command: WHISPER_CLI_COMMAND,
      ...(explicit !== undefined ? { explicit } : {}),
      envVar: WHISPER_CLI_ENV,
      installHint: WHISPER_CLI_INSTALL_HINT,
    });
  } catch (error) {
    return {
      name: WHISPER_CLI_COMMAND,
      status: "missing",
      requested,
      detail: error instanceof Error ? error.message : String(error),
      referenceRevision: WHISPER_CPP_REFERENCE_REVISION,
    };
  }

  const versionProbe = await probeCommand(executable.path, ["--version"], {
    signal,
    allowFailure: true,
  });
  const help = await probeCommand(executable.path, ["--help"], {
    signal,
    allowFailure: true,
  });
  if (!help.ok) {
    return {
      name: WHISPER_CLI_COMMAND,
      status: "incompatible",
      requested,
      executable: executable.path,
      source: executable.source,
      detail: help.detail,
      referenceRevision: WHISPER_CPP_REFERENCE_REVISION,
    };
  }

  const text = `${help.stdout}\n${help.stderr}`;
  const capabilities = integrationFlags(text, [
    "--model",
    "--file",
    "--output-json-full",
    "--output-file",
    "--language",
    "--no-prints",
  ]);
  const missing = ["--model", "--file", "--output-json-full", "--output-file", "--language", "--no-prints"].filter(
    (flag) => !capabilities.includes(flag),
  );
  const versionText = versionProbe.ok ? firstLine(`${versionProbe.stdout}\n${versionProbe.stderr}`) : "";
  const versionOk = /^whisper\.cpp version:\s*\S+/.test(versionText);
  const result: DoctorIntegration = {
    name: WHISPER_CLI_COMMAND,
    status: missing.length === 0 && versionOk ? "ok" : "incompatible",
    requested,
    executable: executable.path,
    source: executable.source,
    capabilities,
    referenceRevision: WHISPER_CPP_REFERENCE_REVISION,
  };
  if (versionText.length > 0) {
    result.version = versionText;
  }
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`Missing required CLI capabilities: ${missing.join(", ")}.`);
  }
  if (!versionOk) {
    problems.push("whisper-cli did not report a supported version string.");
  }
  if (problems.length > 0) {
    result.detail = problems.join(" ");
  }
  return result;
}

async function inspectModel(
  role: DoctorModel["role"],
  requestedPath: string,
  signal?: AbortSignal,
): Promise<DoctorModel> {
  const absolutePath = path.resolve(requestedPath);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return { role, path: absolutePath, status: "error", detail: "Model path is not a regular file." };
    }
    await access(absolutePath, constants.R_OK);
    const identity = await hashFile(absolutePath, {
      signal,
      label: `${role} GGUF model`,
    });
    return {
      role,
      path: absolutePath,
      status: "ok",
      bytes: identity.bytes,
      sha256: identity.sha256,
    };
  } catch (error) {
    if (error instanceof FrameyardError && error.code === "CANCELLED") {
      throw error;
    }
    return {
      role,
      path: absolutePath,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Inspects core requirements, optional integrations, and manifest integrity. */
export async function runDoctor(options: {
  projectRoot: string;
  manifestPath: string;
  qwenTts?: string;
  whisperCli?: string;
  talkerModel?: string;
  codecModel?: string;
  whisperModel?: string;
  signal?: AbortSignal;
}): Promise<DoctorResult> {
  if (options.signal?.aborted) {
    throw new FrameyardError("CANCELLED", "Operation cancelled.");
  }
  const nodeVersion = process.versions.node;
  const checks: DoctorCheck[] = [
    compareVersions(nodeVersion, "22.12.0") >= 0
      ? { name: "node", required: true, status: "ok", detail: `v${nodeVersion}` }
      : {
          name: "node",
          required: true,
          status: "error",
          detail: `v${nodeVersion} is older than the required v22.12.0.`,
        },
  ];

  const ffmpegVersion = await probeCommand("ffmpeg", ["-hide_banner", "-version"], {
    signal: options.signal,
  });
  if (!ffmpegVersion.ok) {
    checks.push({
      name: "ffmpeg",
      required: true,
      status: "error",
      detail: ffmpegVersion.detail,
    });
    checks.push({
      name: "ffmpeg-encoders",
      required: true,
      status: "error",
      detail: "FFmpeg is unavailable, so libx264 and AAC could not be inspected.",
    });
  } else {
    const version = firstLine(ffmpegVersion.stdout || ffmpegVersion.stderr);
    checks.push({ name: "ffmpeg", required: true, status: "ok", detail: version });
    const encoders = await probeCommand("ffmpeg", ["-hide_banner", "-encoders"], {
      signal: options.signal,
    });
    if (!encoders.ok) {
      checks.push({
        name: "ffmpeg-encoders",
        required: true,
        status: "error",
        detail: encoders.detail,
      });
    } else {
      const listing = `${encoders.stdout}\n${encoders.stderr}`;
      const missing = ["libx264", "aac"].filter((name) => !new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(listing));
      checks.push({
        name: "ffmpeg-encoders",
        required: true,
        status: missing.length === 0 ? "ok" : "error",
        detail:
          missing.length === 0 ? "libx264 and aac are available." : `Missing required encoders: ${missing.join(", ")}.`,
      });
    }
  }

  const ffprobe = await probeCommand("ffprobe", ["-hide_banner", "-version"], {
    signal: options.signal,
  });
  checks.push(
    ffprobe.ok
      ? {
          name: "ffprobe",
          required: true,
          status: "ok",
          detail: firstLine(ffprobe.stdout || ffprobe.stderr),
        }
      : { name: "ffprobe", required: true, status: "error", detail: ffprobe.detail },
  );

  checks.push(await checkChromium());

  const manifestResult = await inspectManifest(options.manifestPath, options.projectRoot, options.signal);
  checks.push(manifestResult.check);

  const tts = await inspectTts(options.qwenTts, options.signal);
  const transcribe = await inspectWhisper(options.whisperCli, options.signal);

  const models: DoctorModel[] = [];
  if (options.talkerModel !== undefined) {
    models.push(await inspectModel("talker", options.talkerModel, options.signal));
  }
  if (options.codecModel !== undefined) {
    models.push(await inspectModel("codec", options.codecModel, options.signal));
  }
  if (options.whisperModel !== undefined) {
    models.push(await inspectModel("whisper", options.whisperModel, options.signal));
  }

  if (options.signal?.aborted) {
    throw new FrameyardError("CANCELLED", "Operation cancelled.");
  }

  const requiredOk = checks.every((check) => !check.required || check.status === "ok");
  const manifestOk = manifestResult.manifest.valid;
  const requestedOk =
    tts.status !== "incompatible" &&
    transcribe.status !== "incompatible" &&
    (!tts.requested || tts.status === "ok") &&
    (!transcribe.requested || transcribe.status === "ok");
  const modelsOk = models.every((model) => model.status === "ok");

  return {
    healthy: requiredOk && manifestOk && requestedOk && modelsOk,
    checks,
    integrations: { tts, transcribe },
    manifest: manifestResult.manifest,
    models,
  };
}
