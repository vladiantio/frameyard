export type FrameyardErrorCode =
  | "USAGE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "COMPOSITION_NOT_FOUND"
  | "COMPOSITION_INVALID"
  | "COMPOSITION_UPDATE_ASYNC"
  | "COMPOSITION_ERROR"
  | "PROPS_INVALID"
  | "FRAME_OUT_OF_RANGE"
  | "AUDIO_INVALID"
  | "ASSET_NOT_FOUND"
  | "OUTPUT_EXISTS"
  | "FFMPEG_FAILED"
  | "FFPROBE_FAILED"
  | "BROWSER_FAILED"
  | "RENDER_FAILED"
  | "CANCELLED"
  | "INTERNAL";

export class FrameyardError extends Error {
  readonly code: FrameyardErrorCode;

  constructor(code: FrameyardErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FrameyardError";
    this.code = code;
  }
}

export function isFrameyardError(error: unknown): error is FrameyardError {
  return error instanceof FrameyardError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
