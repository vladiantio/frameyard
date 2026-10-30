export type FrameyardErrorCode =
  | "USAGE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "COMPOSITION_NOT_FOUND"
  | "COMPOSITION_INVALID"
  | "COMPOSITION_UPDATE_ASYNC"
  | "COMPOSITION_ERROR"
  | "COMPOSITION_NOT_READY"
  | "COMPOSITION_DISPOSED"
  | "CONTROLLER_INVALID"
  | "BINDING_INVALID"
  | "BINDING_PATH_MISSING"
  | "BINDING_VALUE_INVALID"
  | "BINDING_REPEAT_INVALID"
  | "BINDING_REPEAT_NESTED"
  | "BINDING_TARGET_INVALID"
  | "ANIMATION_INVALID"
  | "ANIMATION_NOT_FOUND"
  | "ANIMATION_MULTIPLE"
  | "DETERMINISM_WARNING"
  | "SCRIPT_NOT_ALLOWED"
  | "EVENT_HANDLER_NOT_ALLOWED"
  | "URL_NOT_ALLOWED"
  | "ELEMENT_NOT_SUPPORTED"
  | "ELEMENT_UNKNOWN"
  | "CONTENT_OUTSIDE_ROOT"
  | "PROPS_INVALID"
  | "FRAME_OUT_OF_RANGE"
  | "AUDIO_INVALID"
  | "AUDIO_WARNING"
  | "MEDIA_INVALID"
  | "MEDIA_SEEK_FAILED"
  | "ASSET_NOT_FOUND"
  | "OUTPUT_EXISTS"
  | "OUTPUT_FAILED"
  | "FFMPEG_FAILED"
  | "FFPROBE_FAILED"
  | "BROWSER_FAILED"
  | "RENDER_FAILED"
  | "EXECUTABLE_NOT_FOUND"
  | "TTS_FAILED"
  | "TRANSCRIBE_FAILED"
  | "TRANSCRIPT_INVALID"
  | "TRANSCRIPT_WORDS_UNAVAILABLE"
  | "TRANSCRIPT_WARNING"
  | "MANIFEST_INVALID"
  | "CANCELLED"
  | "INTERNAL";

export interface FrameyardDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  details?: unknown;
}

export interface FrameyardErrorOptions {
  cause?: unknown;
  details?: unknown;
  diagnostics?: FrameyardDiagnostic[];
}

export class FrameyardError extends Error {
  readonly code: FrameyardErrorCode;
  readonly details?: unknown;
  readonly diagnostics?: FrameyardDiagnostic[];

  constructor(code: FrameyardErrorCode, message: string, options?: FrameyardErrorOptions) {
    super(message, options);
    this.name = "FrameyardError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    if (options?.diagnostics !== undefined) {
      this.diagnostics = options.diagnostics;
    }
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
