import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { FrameyardError } from "../errors.js";

const STDERR_LIMIT = 16 * 1024;

function captureTail(child: ChildProcessWithoutNullStreams): () => string {
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail += chunk.toString();
    if (tail.length > STDERR_LIMIT) {
      tail = tail.slice(-STDERR_LIMIT);
    }
  });
  return () => tail.trim();
}

function abortError(): FrameyardError {
  return new FrameyardError("RENDER_FAILED", "Operation cancelled.");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Fails early when the installed FFmpeg cannot produce the required output. */
export async function assertFfmpegCapabilities(signal?: AbortSignal, codec: VideoCodec = "h264"): Promise<void> {
  const required = codec === "vp9" ? ["libopus"] : codec === "hevc" ? ["aac"] : ["libx264", "aac"];
  const { stdout, stderr } = await runCaptured("ffmpeg", ["-hide_banner", "-encoders"], { signal });
  const encoders = `${stdout}\n${stderr}`;
  const missing = required.filter((name) => !new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(encoders));
  if (missing.length > 0) {
    throw new FrameyardError(
      "FFMPEG_FAILED",
      `FFmpeg is missing required encoder${missing.length === 1 ? "" : "s"} for ${codec.toUpperCase()}: ${missing.join(", ")}. Install a build with the matching video and audio encoders.`,
    );
  }
}

/** Output video codec. */
export type VideoCodec = "h264" | "hevc" | "vp9";

/** Delivery container. WebM is codec-constrained by design. */
export type VideoContainer = "mp4" | "mov" | "mkv" | "webm";

export const CONTAINER_EXTENSION: Readonly<Record<VideoContainer, string>> = {
  mp4: "mp4",
  mov: "mov",
  mkv: "mkv",
  webm: "webm",
};

const CONTAINER_MUXER: Readonly<Record<VideoContainer, string>> = {
  mp4: "mp4",
  mov: "mov",
  mkv: "matroska",
  webm: "webm",
};

const CODEC_LABEL: Readonly<Record<VideoCodec, string>> = {
  h264: "H.264",
  hevc: "HEVC",
  vp9: "VP9",
};

/** Encoders the renderer can drive, by codec and vendor. */
export type VideoEncoderName =
  | "libx264"
  | "libx265"
  | "libvpx-vp9"
  | "h264_nvenc"
  | "hevc_nvenc"
  | "h264_qsv"
  | "hevc_qsv";

/** CLI-facing encoder choice. `auto` probes hardware before falling back to software. */
export type VideoEncoderChoice = "auto" | "software" | "nvenc" | "qsv";

/** Software encoders are also CLI choices, so the resolver can default to them. */
type SoftwareEncoderName = Extract<VideoEncoderName, "libx264" | "libx265" | "libvpx-vp9">;

interface CodecEncoders {
  software: SoftwareEncoderName;
  /** `null` when the vendor has no encoder for this codec. */
  nvenc: VideoEncoderName | null;
  qsv: VideoEncoderName | null;
}

const CODEC_ENCODERS: Readonly<Record<VideoCodec, CodecEncoders>> = {
  h264: { software: "libx264", nvenc: "h264_nvenc", qsv: "h264_qsv" },
  hevc: { software: "libx265", nvenc: "hevc_nvenc", qsv: "hevc_qsv" },
  vp9: { software: "libvpx-vp9", nvenc: null, qsv: null },
};

/** Codecs each container accepts. WebM allows VP9 only. */
const CONTAINER_CODECS: Readonly<Record<VideoContainer, readonly VideoCodec[]>> = {
  mp4: ["h264", "hevc"],
  mov: ["h264", "hevc"],
  mkv: ["h264", "hevc", "vp9"],
  webm: ["vp9"],
};

/** Default codec for a container when the caller does not choose one. */
export function defaultCodecForContainer(container: VideoContainer): VideoCodec {
  return container === "webm" ? "vp9" : "h264";
}

/** Throws `USAGE` when a container cannot hold the requested codec. */
export function assertContainerCodec(container: VideoContainer, codec: VideoCodec): void {
  if (!CONTAINER_CODECS[container].includes(codec)) {
    const allowed = (Object.keys(CONTAINER_CODECS) as VideoContainer[]).filter((candidate) =>
      CONTAINER_CODECS[candidate].includes(codec),
    );
    throw new FrameyardError(
      "USAGE",
      `--container ${container} cannot hold ${CODEC_LABEL[codec]}; ${codec} is available in ${allowed.join(
        ", ",
      )}. Choose a compatible container or codec.`,
    );
  }
}

/**
 * Concurrent encode sessions per encoder. Consumer NVIDIA drivers allow eight
 * NVENC sessions per system; timeline workers map one session per segment.
 */
export const ENCODER_SESSION_LIMIT: Readonly<Record<VideoEncoderName, number>> = {
  libx264: Number.POSITIVE_INFINITY,
  libx265: Number.POSITIVE_INFINITY,
  "libvpx-vp9": Number.POSITIVE_INFINITY,
  h264_nvenc: 8,
  hevc_nvenc: 8,
  h264_qsv: Number.POSITIVE_INFINITY,
  hevc_qsv: Number.POSITIVE_INFINITY,
};

const probedEncoders = new Map<VideoEncoderName, boolean>();

/** Maps a concrete CLI choice to an encoder, rejecting codec/vendor mismatches. */
export function encoderNameFor(codec: VideoCodec, choice: Exclude<VideoEncoderChoice, "auto">): VideoEncoderName {
  const encoders = CODEC_ENCODERS[codec];
  if (choice === "software") {
    return encoders.software;
  }
  const encoder = encoders[choice];
  if (!encoder) {
    throw new FrameyardError("USAGE", `--codec ${codec} has no ${choice} encoder; use --encoder software or auto.`);
  }
  return encoder;
}

/**
 * Encoder arguments calibrated against `libx264 -crf 20` on the 60-second
 * representative timeline (1920x1080p30) and the 10-second clip gate. Hardware,
 * x265, and VP9 quality scales are not interchangeable with `crf`. Container
 * tags are added by the muxing call sites, not here.
 */
export function videoEncoderArgs(encoder: VideoEncoderName): string[] {
  switch (encoder) {
    case "h264_nvenc":
      return [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "26",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p",
      ];
    case "hevc_nvenc":
      return [
        "-c:v",
        "hevc_nvenc",
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "26",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p",
      ];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "16", "-pix_fmt", "nv12"];
    case "hevc_qsv":
      // Quick Sync's low-power HEVC path rejects constant-quality mode, so the
      // calibrated ICQ settings run on the standard path.
      return ["-c:v", "hevc_qsv", "-preset", "veryfast", "-global_quality", "20", "-pix_fmt", "nv12"];
    case "libx265":
      return ["-c:v", "libx265", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p"];
    case "libvpx-vp9":
      return ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-cpu-used", "4", "-pix_fmt", "yuv420p"];
    default:
      return ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"];
  }
}

/** Sample-entry tag for stream-copy steps. Only MP4/MOV carry `hvc1`. */
export function videoCodecTagArgs(codec: VideoCodec, container: VideoContainer): string[] {
  return codec === "hevc" && (container === "mp4" || container === "mov") ? ["-tag:v", "hvc1"] : [];
}

/** Audio codec for the delivery pair. WebM and VP9 use Opus. */
export function audioEncoderArgs(codec: VideoCodec): string[] {
  if (codec === "vp9") {
    return ["-c:a", "libopus", "-b:a", "160k", "-ar", "48000", "-ac", "2"];
  }
  return ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
}

/** Muxer selection for encode and copy steps. */
export function containerMuxerArgs(container: VideoContainer): string[] {
  return ["-f", CONTAINER_MUXER[container]];
}

/** MP4 and MOV support faststart; Matroska and WebM do not. */
export function containerMuxFlags(container: VideoContainer): string[] {
  return container === "mp4" || container === "mov" ? ["-movflags", "+faststart"] : [];
}

/**
 * An encoder can be listed by `ffmpeg -encoders` and still fail to open (old
 * drivers, missing devices), so `auto` proves it with a one-frame encode.
 */
export async function probeVideoEncoder(
  encoder: VideoEncoderName,
  signal?: AbortSignal,
): Promise<{ available: boolean; detail?: string }> {
  try {
    await runCaptured(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=30:d=0.1",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        encoder,
        "-f",
        "null",
        "-",
      ],
      { signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return { available: false, detail: encoderFailureDetail(error) };
  }
  return { available: true };
}

/** Collapses a failed probe into the first useful stderr line. */
function encoderFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^ffmpeg exited with code \d+:?$/.test(part));
  return line ?? message;
}

async function encoderAvailable(encoder: VideoEncoderName, signal?: AbortSignal): Promise<boolean> {
  const cached = probedEncoders.get(encoder);
  if (cached !== undefined) {
    return cached;
  }
  const probe = await probeVideoEncoder(encoder, signal);
  probedEncoders.set(encoder, probe.available);
  return probe.available;
}

/** Resolves a codec and CLI encoder choice to the FFmpeg encoder that will run. */
export async function resolveVideoEncoder(
  codec: VideoCodec = "h264",
  choice: VideoEncoderChoice = "auto",
  signal?: AbortSignal,
): Promise<VideoEncoderName> {
  const encoders = CODEC_ENCODERS[codec];

  if (choice === "auto") {
    for (const encoder of [encoders.nvenc, encoders.qsv]) {
      if (encoder !== null && (await encoderAvailable(encoder, signal))) {
        return encoder;
      }
    }
    if (codec === "h264") {
      return encoders.software;
    }
    if (await encoderAvailable(encoders.software, signal)) {
      return encoders.software;
    }
    throw new FrameyardError(
      "FFMPEG_FAILED",
      `${CODEC_LABEL[codec]} needs a hardware encoder or an FFmpeg build with ${encoders.software}. No ${CODEC_LABEL[codec]} encoder could be opened on this machine.`,
    );
  }

  const encoder = encoderNameFor(codec, choice);
  if (encoder === "libx264") {
    return encoder;
  }
  if (await encoderAvailable(encoder, signal)) {
    return encoder;
  }
  if (encoder === encoders.software) {
    throw new FrameyardError(
      "FFMPEG_FAILED",
      `FFmpeg does not provide the ${encoders.software} encoder. Install a build with ${CODEC_LABEL[codec]} support, or use --encoder auto with a hardware encoder.`,
    );
  }
  throw new FrameyardError(
    "FFMPEG_FAILED",
    `Encoder "${encoder}" is not available: FFmpeg could not start it on this machine. Try --encoder auto to probe hardware, or --encoder software.`,
  );
}

interface ProcessOptions {
  signal?: AbortSignal;
}

function runCaptured(
  command: "ffmpeg" | "ffprobe",
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error: NodeJS.ErrnoException) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (error.code === "ENOENT") {
        reject(
          new FrameyardError(
            command === "ffmpeg" ? "FFMPEG_FAILED" : "FFPROBE_FAILED",
            `${command === "ffmpeg" ? "FFmpeg" : "FFprobe"} was not found on PATH. Install FFmpeg and ensure both executables are available.`,
            { cause: error },
          ),
        );
        return;
      }
      reject(
        new FrameyardError(
          command === "ffmpeg" ? "FFMPEG_FAILED" : "FFPROBE_FAILED",
          `${command} could not start: ${error.message}`,
          { cause: error },
        ),
      );
    });

    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (code !== 0) {
        reject(
          new FrameyardError(
            command === "ffmpeg" ? "FFMPEG_FAILED" : "FFPROBE_FAILED",
            `${command} exited with code ${code}${stderr ? `:\n${stderr.trim()}` : "."}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  duration?: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

export async function probeMedia(filePath: string, options: ProcessOptions = {}): Promise<ProbeResult> {
  const { stdout } = await runCaptured(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath],
    options,
  );
  try {
    return JSON.parse(stdout) as ProbeResult;
  } catch (error) {
    throw new FrameyardError("FFPROBE_FAILED", `Could not parse ffprobe output for ${filePath}.`, { cause: error });
  }
}

export interface MixClip {
  path: string;
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
}

/** Normalizes any decodable source to the 16 kHz mono PCM WAV that whisper.cpp expects. */
export async function normalizeAudioForTranscription(options: {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  await runCaptured(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      options.inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      options.outputPath,
    ],
    { signal: options.signal },
  );
}

export async function mixAudioTimeline(options: {
  clips: MixClip[];
  fps: number;
  durationSeconds: number;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.clips.length === 0) {
    throw new FrameyardError("AUDIO_INVALID", "Cannot mix an empty audio timeline.");
  }

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const clip of options.clips) {
    args.push("-i", clip.path);
  }

  const filters: string[] = [];
  const labels: string[] = [];

  options.clips.forEach((clip, index) => {
    const trim: string[] = [`start=${formatNumber(clip.trimStart)}`];
    if (clip.trimDuration !== undefined) {
      trim.push(`duration=${formatNumber(clip.trimDuration)}`);
    }

    const delayMs = Math.round((clip.startFrame * 1000) / options.fps);
    const chain = [
      `atrim=${trim.join(":")}`,
      "asetpts=PTS-STARTPTS",
      `volume=${formatNumber(clip.volume)}`,
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      "apad",
    ];
    if (delayMs > 0) {
      chain.push(`adelay=${delayMs}|${delayMs}`);
    }

    const label = options.clips.length === 1 ? "audio" : `clip${index}`;
    filters.push(`[${index}:a]${chain.join(",")}[${label}]`);
    if (options.clips.length > 1) {
      labels.push(`[${label}]`);
    }
  });

  if (options.clips.length > 1) {
    filters.push(`${labels.join("")}amix=inputs=${options.clips.length}:duration=longest:normalize=0[audio]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[audio]",
    "-t",
    formatNumber(options.durationSeconds),
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    options.outputPath,
  );

  await runCaptured("ffmpeg", args, { signal: options.signal });
}

export interface VideoEncoder {
  writeFrame(png: Buffer): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export async function startVideoEncoder(options: {
  outputPath: string;
  durationSeconds: number;
  /** Exact number of frames that must be written. */
  frames: number;
  fps: number;
  audioPath?: string;
  /** Encoder; defaults to `libx264`. */
  encoder?: VideoEncoderName;
  /** Delivery codec; selects the audio codec and sample-entry tag. */
  codec?: VideoCodec;
  /** Delivery container; defaults to `mp4`. */
  container?: VideoContainer;
  signal?: AbortSignal;
}): Promise<VideoEncoder> {
  if (options.signal?.aborted) {
    throw abortError();
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    formatNumber(options.fps),
    "-i",
    "pipe:0",
  ];

  if (options.audioPath) {
    args.push("-i", options.audioPath);
  }

  args.push("-map", "0:v:0");
  if (options.audioPath) {
    args.push("-map", "1:a:0");
  }

  const codec = options.codec ?? "h264";
  const container = options.container ?? "mp4";

  args.push(
    ...videoEncoderArgs(options.encoder ?? "libx264"),
    ...videoCodecTagArgs(codec, container),
    "-r",
    formatNumber(options.fps),
    "-frames:v",
    String(options.frames),
    "-t",
    formatNumber(options.durationSeconds),
  );

  if (options.audioPath) {
    args.push(...audioEncoderArgs(codec));
  }

  args.push(...containerMuxFlags(container), ...containerMuxerArgs(container), options.outputPath);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw new FrameyardError("FFMPEG_FAILED", "Could not start FFmpeg.", { cause: error });
  }

  const stderrTail = captureTail(child);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new FrameyardError(
            "FFMPEG_FAILED",
            "FFmpeg was not found on PATH. Install FFmpeg and ensure it is available.",
            { cause: error },
          ),
        );
      } else {
        reject(new FrameyardError("FFMPEG_FAILED", `FFmpeg could not start: ${error.message}`, { cause: error }));
      }
    });
  });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  let finished = false;
  let framesWritten = 0;
  const onAbort = () => {
    child.stdin.destroy();
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function abort(): Promise<void> {
    if (finished) {
      return;
    }
    finished = true;
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed.catch(() => undefined);
  }

  return {
    async writeFrame(png: Buffer): Promise<void> {
      if (finished) {
        throw new FrameyardError("FFMPEG_FAILED", "Cannot write a frame after the encoder finished.");
      }
      if (options.signal?.aborted) {
        throw abortError();
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          child.stdin.off("error", onError);
          if (options.signal?.aborted) {
            reject(abortError());
          } else {
            reject(
              new FrameyardError("FFMPEG_FAILED", `FFmpeg stopped while accepting frames: ${error.message}`, {
                cause: error,
              }),
            );
          }
        };
        child.stdin.once("error", onError);
        child.stdin.write(png, (error) => {
          child.stdin.off("error", onError);
          if (error) {
            reject(
              new FrameyardError("FFMPEG_FAILED", `Could not write a frame to FFmpeg: ${error.message}`, {
                cause: error,
              }),
            );
          } else {
            framesWritten += 1;
            resolve();
          }
        });
      });
    },

    async finish(): Promise<void> {
      if (finished) {
        return;
      }
      finished = true;
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin.end();
      const { code, signal } = await closed;
      if (options.signal?.aborted) {
        throw abortError();
      }
      if (code !== 0) {
        const detail = stderrTail();
        throw new FrameyardError(
          "FFMPEG_FAILED",
          `FFmpeg encoding failed${signal ? ` (${signal})` : code === null ? "" : ` (exit ${code})`}${detail ? `:\n${detail}` : "."}`,
        );
      }
      if (framesWritten !== options.frames) {
        throw new FrameyardError(
          "FFMPEG_FAILED",
          `FFmpeg encoded ${framesWritten} frames but ${options.frames} were required.`,
        );
      }
    },

    abort,
  };
}

export interface TimelineCompositeLayer {
  kind: "composition" | "timeline" | "video" | "image";
  path: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Explicit clip box. Both fields are set together; otherwise the stage is the box. */
  width?: number;
  height?: number;
  fit: "contain" | "cover" | "stretch";
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** Absolute source frame at the segment start, for video inputs. */
  sourceStartFrame?: number;
}

function ffmpegBackgroundColor(value: string): string {
  if (value === "transparent") {
    return "black@0.0";
  }
  if (value === "black") {
    return "black";
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) {
    return `0x${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (long) {
    return `0x${long[1]}${long[2]}${long[3]}`;
  }
  const withAlpha = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (withAlpha) {
    const alpha = Number.parseInt(withAlpha[4] as string, 16) / 255;
    return `0x${withAlpha[1]}${withAlpha[2]}${withAlpha[3]}@${alpha.toFixed(3)}`;
  }
  if (/^[a-zA-Z]+$/.test(value)) {
    return value;
  }
  return "black";
}

function fitFilter(layer: TimelineCompositeLayer, stageWidth: number, stageHeight: number): string {
  const width = layer.width ?? stageWidth;
  const height = layer.height ?? stageHeight;
  const sourceWidth = Math.max(1, layer.sourceWidth);
  const sourceHeight = Math.max(1, layer.sourceHeight);
  if (layer.fit === "cover") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  if (layer.fit === "stretch") {
    return `scale=${width}:${height}`;
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = Math.max(1, Math.round(sourceWidth * scale));
  const fittedHeight = Math.max(1, Math.round(sourceHeight * scale));
  return `scale=${fittedWidth}:${fittedHeight},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
}

function layerFilter(layer: TimelineCompositeLayer, stageWidth: number, stageHeight: number, fps: number): string {
  const filters = [
    // Matroska and WebM timestamps can be quantized to milliseconds. Normalize
    // every timed layer to the project frame rate before overlay framesync so
    // it does not duplicate or drop frames. Still images are already static.
    ...(layer.kind === "image" ? [] : [`fps=${formatNumber(fps)}`]),
    fitFilter(layer, stageWidth, stageHeight),
    "format=rgba",
  ];
  if (layer.scale !== 1) {
    filters.push(`scale=iw*${formatNumber(layer.scale)}:ih*${formatNumber(layer.scale)}`);
  }
  if (layer.rotation !== 0) {
    filters.push(`rotate=angle=${formatNumber(layer.rotation)}*PI/180:fillcolor=black@0`);
  }
  if (layer.opacity < 1) {
    filters.push(`colorchannelmixer=aa=${formatNumber(layer.opacity)}`);
  }
  return filters.join(",");
}

/** Encode a numbered PNG sequence into a lossless alpha-preserving FFV1 file. */
export async function encodePngSequenceToFfv1(options: {
  pattern: string;
  outputPath: string;
  fps: number;
  signal?: AbortSignal;
}): Promise<void> {
  await runCaptured(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-framerate",
      formatNumber(options.fps),
      "-i",
      options.pattern,
      "-c:v",
      "ffv1",
      "-level",
      "3",
      "-pix_fmt",
      "bgra",
      options.outputPath,
    ],
    { signal: options.signal },
  );
}

/** Composites one timeline segment into H.264 or an alpha-preserving FFV1 file. */
export async function compositeTimelineSegment(options: {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** CSS color, "black", or "transparent" for nested timelines. */
  background: string;
  layers: readonly TimelineCompositeLayer[];
  /** Segment payload: lossless FFV1 intermediates or a delivery codec. */
  codec: VideoCodec | "ffv1";
  /** Encoder for delivery codecs; defaults to `libx264`. */
  encoder?: VideoEncoderName;
  /** Delivery container; defaults to `mp4` (FFV1 always uses Matroska). */
  container?: VideoContainer;
  signal?: AbortSignal;
}): Promise<void> {
  const durationSeconds = options.frames / options.fps;
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${ffmpegBackgroundColor(options.background)}:s=${options.width}x${options.height}:r=${formatNumber(options.fps)}:d=${formatNumber(durationSeconds)}`,
  ];
  const filters = [
    options.background === "transparent" ? "[0:v]format=rgba,colorchannelmixer=aa=0[base0]" : "[0:v]format=rgba[base0]",
  ];
  let current = "base0";
  let inputIndex = 0;
  let includedIndex = 0;

  for (const layer of options.layers) {
    if (layer.opacity <= 0 || layer.scale <= 0) {
      continue;
    }

    if (layer.kind === "video") {
      const startSeconds = (layer.sourceStartFrame ?? 0) / options.fps;
      args.push("-ss", formatNumber(startSeconds), "-t", formatNumber(durationSeconds), "-i", layer.path, "-an");
    } else if (layer.kind === "image") {
      args.push(
        "-loop",
        "1",
        "-framerate",
        formatNumber(options.fps),
        "-t",
        formatNumber(durationSeconds),
        "-i",
        layer.path,
        "-an",
      );
    } else {
      args.push("-i", layer.path);
    }

    inputIndex += 1;
    includedIndex += 1;
    filters.push(
      `[${inputIndex}:v]${layerFilter(layer, options.width, options.height, options.fps)}[l${includedIndex}]`,
    );
    filters.push(
      `[${current}][l${includedIndex}]overlay=x=(main_w-overlay_w)/2+${formatNumber(layer.x)}:y=(main_h-overlay_h)/2+${formatNumber(layer.y)}:format=auto[b${includedIndex}]`,
    );
    current = `b${includedIndex}`;
  }

  filters.push(`[${current}]format=${options.codec === "ffv1" ? "bgra" : "yuv420p"}[out]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    String(options.frames),
    "-r",
    formatNumber(options.fps),
    "-an",
  );
  if (options.codec === "ffv1") {
    args.push("-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", ...containerMuxerArgs("mkv"));
  } else {
    const container = options.container ?? "mp4";
    args.push(
      ...videoEncoderArgs(options.encoder ?? "libx264"),
      ...videoCodecTagArgs(options.codec, container),
      ...containerMuxerArgs(container),
    );
  }
  args.push(options.outputPath);

  await runCaptured("ffmpeg", args, { signal: options.signal });
}

/** Concatenates encoded timeline segments without re-encoding. */
export async function concatTimelineSegments(options: {
  segmentPaths: readonly string[];
  listPath: string;
  outputPath: string;
  /** Delivery codec of the segments; keeps the `hvc1` tag for MP4/MOV. */
  codec?: VideoCodec;
  /** Delivery container; defaults to `mp4`. */
  container?: VideoContainer;
  signal?: AbortSignal;
}): Promise<void> {
  const codec = options.codec ?? "h264";
  const container = options.container ?? "mp4";
  const list = options.segmentPaths.map((segmentPath) => `file '${segmentPath.replaceAll("'", "'\\''")}'`).join("\n");
  await writeFile(options.listPath, `${list}\n`);
  await runCaptured(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      options.listPath,
      "-c",
      "copy",
      ...videoCodecTagArgs(codec, container),
      ...containerMuxFlags(container),
      ...containerMuxerArgs(container),
      options.outputPath,
    ],
    { signal: options.signal },
  );
}

/** Muxes a mixed WAV into an already encoded video without re-encoding video. */
export async function muxVideoWithAudio(options: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  /** Delivery codec of the video; selects the audio codec and tag. */
  codec?: VideoCodec;
  /** Delivery container; defaults to `mp4`. */
  container?: VideoContainer;
  signal?: AbortSignal;
}): Promise<void> {
  const codec = options.codec ?? "h264";
  const container = options.container ?? "mp4";
  await runCaptured(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      options.videoPath,
      "-i",
      options.audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      ...videoCodecTagArgs(codec, container),
      ...audioEncoderArgs(codec),
      "-shortest",
      ...containerMuxFlags(container),
      ...containerMuxerArgs(container),
      options.outputPath,
    ],
    { signal: options.signal },
  );
}

/** Composites one timeline frame to a PNG without encoding a segment. */
export async function compositeTimelineFrame(options: {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  layers: readonly TimelineCompositeLayer[];
  signal?: AbortSignal;
}): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${ffmpegBackgroundColor(options.background)}:s=${options.width}x${options.height}:r=${formatNumber(options.fps)}:d=${formatNumber(1 / options.fps)}`,
  ];
  const filters = [
    options.background === "transparent" ? "[0:v]format=rgba,colorchannelmixer=aa=0[base0]" : "[0:v]format=rgba[base0]",
  ];
  let current = "base0";
  let inputIndex = 0;
  let includedIndex = 0;

  for (const layer of options.layers) {
    if (layer.opacity <= 0 || layer.scale <= 0) {
      continue;
    }

    if (layer.kind === "video") {
      args.push("-ss", formatNumber((layer.sourceStartFrame ?? 0) / options.fps), "-i", layer.path, "-an");
    } else {
      args.push("-i", layer.path);
    }

    inputIndex += 1;
    includedIndex += 1;
    filters.push(
      `[${inputIndex}:v]${layerFilter(layer, options.width, options.height, options.fps)}[l${includedIndex}]`,
    );
    filters.push(
      `[${current}][l${includedIndex}]overlay=x=(main_w-overlay_w)/2+${formatNumber(layer.x)}:y=(main_h-overlay_h)/2+${formatNumber(layer.y)}:format=auto[b${includedIndex}]`,
    );
    current = `b${includedIndex}`;
  }

  filters.push(`[${current}]format=rgba[out]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "-c:v",
    "png",
    "-pix_fmt",
    "rgba",
    options.outputPath,
  );

  await runCaptured("ffmpeg", args, { signal: options.signal });
}
