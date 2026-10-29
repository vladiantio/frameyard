import { stat } from "node:fs/promises";
import path from "node:path";
import type { ResolvedAudioClip } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { probeMedia } from "./ffmpeg.js";

export interface AudioAsset {
  clip: ResolvedAudioClip;
  path: string;
  sourceDurationSeconds: number;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
}

export interface AudioInspection {
  assets: AudioAsset[];
  clips: Array<{
    src: string;
    startFrame: number;
    startSeconds: number;
    endSeconds: number;
    sourceDurationSeconds: number;
    trimStart: number;
    trimDuration?: number;
    volume: number;
  }>;
  warnings: string[];
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Resolves local audio files, probes durations, and reports timeline overruns. */
export async function inspectTimelineAudio(options: {
  projectRoot: string;
  clips: readonly ResolvedAudioClip[];
  fps: number;
  durationInFrames: number;
  signal?: AbortSignal;
}): Promise<AudioInspection> {
  const compositionDuration = options.durationInFrames / options.fps;
  const assets: AudioAsset[] = [];
  const warnings: string[] = [];

  for (const [clipIndex, clip] of options.clips.entries()) {
    if (options.signal?.aborted) {
      throw new FrameyardError("RENDER_FAILED", "Operation cancelled.");
    }

    const absolutePath = path.resolve(options.projectRoot, clip.src);
    if (!contains(options.projectRoot, absolutePath)) {
      throw new FrameyardError(
        "AUDIO_INVALID",
        `Audio clip ${clipIndex + 1} source escapes the project root: ${clip.src}`,
      );
    }

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new FrameyardError("ASSET_NOT_FOUND", `Audio clip ${clipIndex + 1} source does not exist: ${clip.src}`);
    }
    if (!fileStat.isFile()) {
      throw new FrameyardError("ASSET_NOT_FOUND", `Audio clip ${clipIndex + 1} source is not a file: ${clip.src}`);
    }

    const probe = await probeMedia(absolutePath, { signal: options.signal });
    if (!probe.streams.some((stream) => stream.codec_type === "audio")) {
      throw new FrameyardError("AUDIO_INVALID", `Audio clip ${clipIndex + 1} source has no audio stream: ${clip.src}`);
    }

    const rawDuration = Number(probe.format?.duration);
    const streamDuration = Math.max(
      0,
      ...probe.streams
        .filter((stream) => stream.codec_type === "audio")
        .map((stream) => Number(stream.duration))
        .filter((value) => Number.isFinite(value)),
    );
    const sourceDurationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : streamDuration;

    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
      throw new FrameyardError(
        "AUDIO_INVALID",
        `Audio clip ${clipIndex + 1} source duration could not be determined: ${clip.src}`,
      );
    }

    if (clip.trimStart >= sourceDurationSeconds) {
      warnings.push(
        `Audio clip ${clipIndex + 1} (${clip.src}) trimStart ${clip.trimStart}s is at or beyond the source duration ${sourceDurationSeconds.toFixed(2)}s.`,
      );
    }
    if (clip.trimDuration !== undefined && clip.trimStart + clip.trimDuration > sourceDurationSeconds + 0.001) {
      warnings.push(
        `Audio clip ${clipIndex + 1} (${clip.src}) trim range ends at ${(clip.trimStart + clip.trimDuration).toFixed(2)}s, beyond the source duration ${sourceDurationSeconds.toFixed(2)}s.`,
      );
    }

    const timelineStartSeconds = clip.startFrame / options.fps;
    const usedDuration = clip.trimDuration ?? Math.max(0, sourceDurationSeconds - clip.trimStart);
    const timelineEndSeconds = timelineStartSeconds + usedDuration;

    if (timelineStartSeconds >= compositionDuration) {
      warnings.push(
        `Audio clip ${clipIndex + 1} (${clip.src}) starts at ${timelineStartSeconds.toFixed(2)}s, after the composition ends at ${compositionDuration.toFixed(2)}s.`,
      );
    } else if (timelineEndSeconds > compositionDuration + 0.001) {
      warnings.push(
        `Audio clip ${clipIndex + 1} (${clip.src}) ends at ${timelineEndSeconds.toFixed(2)}s, beyond the composition duration ${compositionDuration.toFixed(2)}s.`,
      );
    }

    assets.push({
      clip,
      path: absolutePath,
      sourceDurationSeconds,
      timelineStartSeconds,
      timelineEndSeconds,
    });
  }

  return {
    assets,
    clips: assets.map((asset) => {
      const clip = asset.clip;
      const result: AudioInspection["clips"][number] = {
        src: clip.src,
        startFrame: clip.startFrame,
        startSeconds: asset.timelineStartSeconds,
        endSeconds: asset.timelineEndSeconds,
        sourceDurationSeconds: asset.sourceDurationSeconds,
        trimStart: clip.trimStart,
        volume: clip.volume,
      };
      if (clip.trimDuration !== undefined) {
        result.trimDuration = clip.trimDuration;
      }
      return result;
    }),
    warnings,
  };
}
