import { FrameyardError } from "../errors.js";

/** Converts an integer frame number to milliseconds from the start of the composition. */
export function frameToMilliseconds(frame: number, fps: number): number {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new FrameyardError("FRAME_OUT_OF_RANGE", `Frame must be a non-negative integer; received ${frame}.`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new FrameyardError("COMPOSITION_INVALID", `Frame rate must be a positive finite number; received ${fps}.`);
  }
  return (frame * 1000) / fps;
}

/** Converts an integer frame number to seconds from the start of the composition. */
export function frameToSeconds(frame: number, fps: number): number {
  return frameToMilliseconds(frame, fps) / 1000;
}
