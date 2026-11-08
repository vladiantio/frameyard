import { FrameyardError } from "../errors.js";

export const MIN_RENDER_SCALE = 0.25;
export const MAX_RENDER_SCALE = 1;

/** Validates the render scale flag and returns its normalized value. */
export function validateRenderScale(value: number | undefined): number {
  const scale = value ?? 1;
  if (!Number.isFinite(scale) || scale < MIN_RENDER_SCALE || scale > MAX_RENDER_SCALE) {
    throw new FrameyardError(
      "USAGE",
      `--scale must be between ${MIN_RENDER_SCALE} and ${MAX_RENDER_SCALE}; received ${String(value)}.`,
      { details: { min: MIN_RENDER_SCALE, max: MAX_RENDER_SCALE, value } },
    );
  }
  return scale;
}

/** Output dimensions for encoded video; both axes stay even for delivery codecs. */
export function scaledVideoDimensions(width: number, height: number, scale: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

/**
 * Capture dimensions for Chromium or a timeline stage. A scale of 1 keeps the
 * source size exactly; lower scales use the even-sized output dimensions so
 * captured PNGs and encoded segments never need a scale pass.
 */
export function scaledCaptureDimensions(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  return scale === 1 ? { width, height } : scaledVideoDimensions(width, height, scale);
}

/**
 * FFmpeg filter for media that has no capture stage, such as a full-frame video
 * re-encoded directly into a delivery segment. Composition and timeline
 * captures use `scaledCaptureDimensions` instead.
 */
export function renderScaleFilter(scale: number): string | undefined {
  if (scale === 1) {
    return undefined;
  }
  return `scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2`;
}
