export type FrameyardErrorCode =
  | "USAGE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "COMPOSITION_NOT_FOUND"
  | "COMPOSITION_INVALID"
  | "COMPOSITION_DOCUMENT_SHELL"
  | "IMPORT_MAP_INVALID"
  | "COMPOSITION_FORMAT_UNRESOLVED"
  | "TIMELINE_NOT_FOUND"
  | "TIMELINE_INVALID"
  | "TIMELINE_TRACK_INVALID"
  | "TIMELINE_CLIP_INVALID"
  | "TIMELINE_CLIP_OVERLAP"
  | "TIMELINE_CLIP_OUT_OF_RANGE"
  | "TIMELINE_TRANSITION_INVALID"
  | "TIMELINE_TRANSITION_UNKNOWN_CLIP"
  | "TIMELINE_TRANSITION_WRONG_TRACK"
  | "TIMELINE_TRANSITION_AUDIO_TRACK"
  | "TIMELINE_TRANSITION_VIDEO_TRACK"
  | "TIMELINE_TRANSITION_NOT_OVERLAPPING"
  | "TIMELINE_TRANSITION_GEOMETRY"
  | "TIMELINE_TRANSITION_DUPLICATE"
  | "TIMELINE_TRANSITION_KIND"
  | "TIMELINE_DURATION_INVALID"
  | "TIMELINE_REFERENCE_NOT_FOUND"
  | "TIMELINE_CYCLE"
  | "TIMELINE_FPS_MISMATCH"
  | "TIMELINE_MEDIA_INVALID"
  | "TIMELINE_WARNING"
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
  | "STATIC_ANIMATION_UNSUPPORTED"
  | "STATIC_ANIMATION_PAUSED"
  | "STATIC_MEDIA_UNSUPPORTED"
  | "STATIC_UPDATE_IGNORED"
  | "DETERMINISM_WARNING"
  | "SCRIPT_NOT_ALLOWED"
  | "EVENT_HANDLER_NOT_ALLOWED"
  | "URL_NOT_ALLOWED"
  | "ELEMENT_NOT_SUPPORTED"
  | "ELEMENT_UNKNOWN"
  | "CONTENT_OUTSIDE_ROOT"
  | "PROPS_INVALID"
  | "PROPS_SCHEMA_INVALID"
  | "PROPS_SCHEMA_INVALID_SCHEMA"
  | "FRAME_OUT_OF_RANGE"
  | "AUDIO_INVALID"
  | "AUDIO_WARNING"
  | "MEDIA_INVALID"
  | "MEDIA_SEEK_FAILED"
  | "ASSET_NOT_FOUND"
  | "FONT_MANIFEST_INVALID"
  | "FONT_FILE_MISSING"
  | "FONT_FILE_INVALID"
  | "FONT_HASH_MISMATCH"
  | "FONT_LICENSE_MISSING"
  | "FONT_ORPHANED"
  | "FONT_LOAD_FAILED"
  | "FONT_REMOTE"
  | "FONT_NOT_FOUND"
  | "FONT_PROVIDER_UNAVAILABLE"
  | "FONT_DOWNLOAD_FAILED"
  | "OUTPUT_EXISTS"
  | "OUTPUT_FAILED"
  | "FFMPEG_FAILED"
  | "ENCODER_WARNING"
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
  | "IMAGE_INVALID"
  | "POLICY_INVALID"
  | "RESOURCE_POLICY_BLOCKED"
  | "RESOURCE_POLICY_LIMIT"
  | "RESOURCE_PROFILE_CONFLICT"
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
