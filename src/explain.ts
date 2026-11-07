import type { FrameyardErrorCode } from "./errors.js";

export interface DiagnosticExamples {
  failing: string;
  corrected: string;
}

export interface DiagnosticExplanation {
  code: FrameyardErrorCode;
  message: string;
  docs?: string;
  examples?: DiagnosticExamples;
}

interface ExplanationEntry {
  message: string;
  docs?: string;
  examples?: DiagnosticExamples;
}

const DOCS = {
  bindings: "skills/frameyard/references/bindings.md",
  commonMistakes: "skills/frameyard/references/common-mistakes.md",
  controllers: "skills/frameyard/references/controllers.md",
  deterministic: "skills/frameyard/references/deterministic-authoring.md",
  diagnostics: "skills/frameyard/references/diagnostics.md",
  failureRecovery: "skills/frameyard/references/failure-recovery.md",
  fonts: "skills/frameyard/references/fonts.md",
  jsonResults: "skills/frameyard/references/json-results.md",
  timelines: "skills/frameyard/references/timelines.md",
  audio: "skills/frameyard/references/audio-assets.md",
  subtitles: "skills/frameyard/references/subtitles-karaoke.md",
  reference: "README.md",
} as const;

const entry = (message: string, docs?: string, examples?: DiagnosticExamples): ExplanationEntry => ({
  message,
  ...(docs !== undefined ? { docs } : {}),
  ...(examples !== undefined ? { examples } : {}),
});

const EXPLANATIONS: Record<FrameyardErrorCode, ExplanationEntry> = {
  USAGE: entry("The command line or argument combination is invalid.", DOCS.reference),
  CONFIG_NOT_FOUND: entry("No fy.config.js was found from the working directory or --project.", DOCS.reference),
  CONFIG_INVALID: entry("fy.config.js or a project identifier is invalid.", DOCS.reference),
  COMPOSITION_NOT_FOUND: entry("The requested composition id is not registered in fy.config.js.", DOCS.reference),
  COMPOSITION_INVALID: entry("The composition fragment is missing or has invalid structure.", DOCS.reference),
  COMPOSITION_DOCUMENT_SHELL: entry("Compositions are fragments; remove the document shell.", DOCS.commonMistakes),
  IMPORT_MAP_INVALID: entry("The import map is invalid or uses a reserved specifier.", DOCS.controllers),
  COMPOSITION_FORMAT_UNRESOLVED: entry("Declare width and height or add a project format.", DOCS.reference),
  TIMELINE_NOT_FOUND: entry("The requested timeline id is not registered in fy.config.js.", DOCS.timelines),
  TIMELINE_INVALID: entry("The timeline JSON document is invalid.", DOCS.timelines),
  TIMELINE_TRACK_INVALID: entry("A timeline track is invalid or duplicated.", DOCS.timelines),
  TIMELINE_CLIP_INVALID: entry("A timeline clip has invalid fields or values.", DOCS.timelines),
  TIMELINE_CLIP_OVERLAP: entry("Two clips overlap without a declared transition.", DOCS.timelines),
  TIMELINE_CLIP_OUT_OF_RANGE: entry("A clip extends outside its source or timeline bounds.", DOCS.timelines),
  TIMELINE_TRANSITION_INVALID: entry("A transition has invalid fields or easing.", DOCS.timelines),
  TIMELINE_TRANSITION_UNKNOWN_CLIP: entry("A transition names a missing or self clip.", DOCS.timelines),
  TIMELINE_TRANSITION_WRONG_TRACK: entry("A transition connects clips on different tracks.", DOCS.timelines),
  TIMELINE_TRANSITION_AUDIO_TRACK: entry("Use crossfade for an audio-track transition.", DOCS.timelines),
  TIMELINE_TRANSITION_VIDEO_TRACK: entry("Use dissolve for a video-track transition.", DOCS.timelines),
  TIMELINE_TRANSITION_NOT_OVERLAPPING: entry("A declared transition has no overlap window.", DOCS.timelines),
  TIMELINE_TRANSITION_GEOMETRY: entry(
    "Transition geometry must satisfy from.start < to.start < from.end < to.end.",
    DOCS.timelines,
  ),
  TIMELINE_TRANSITION_DUPLICATE: entry("A clip is used twice on the same transition side.", DOCS.timelines),
  TIMELINE_TRANSITION_KIND: entry("A transition kind is missing or unsupported.", DOCS.timelines),
  TIMELINE_DURATION_INVALID: entry("The timeline duration is invalid or shorter than its clips.", DOCS.timelines),
  TIMELINE_REFERENCE_NOT_FOUND: entry(
    "A timeline source references a missing composition or timeline.",
    DOCS.timelines,
  ),
  TIMELINE_CYCLE: entry("Nested timelines form a cycle.", DOCS.timelines),
  TIMELINE_FPS_MISMATCH: entry("A composition clip fps differs from the timeline fps.", DOCS.timelines),
  TIMELINE_MEDIA_INVALID: entry("A timeline media source is invalid or missing.", DOCS.timelines),
  TIMELINE_WARNING: entry("A non-fatal timeline issue was detected.", DOCS.timelines),
  COMPOSITION_UPDATE_ASYNC: entry("update() must be synchronous and seek-safe.", DOCS.controllers),
  COMPOSITION_ERROR: entry("The composition failed during loading or frame production.", DOCS.failureRecovery),
  COMPOSITION_NOT_READY: entry("Call load() before seek() or settle().", DOCS.controllers),
  COMPOSITION_DISPOSED: entry("The composition host was disposed and cannot be reused.", DOCS.controllers),
  CONTROLLER_INVALID: entry("Use exactly one inline or external controller with supported exports.", DOCS.controllers),
  BINDING_INVALID: entry("A data-fy-* attribute or binding path is invalid.", DOCS.bindings, {
    failing: '<h1 data-fy-txt="title"></h1>',
    corrected: '<h1 data-fy-text="title"></h1>',
  }),
  BINDING_PATH_MISSING: entry("A binding path is not present in the resolved props.", DOCS.bindings, {
    failing: '<h1 data-fy-text="titel"></h1>',
    corrected: '<h1 data-fy-text="title"></h1>',
  }),
  BINDING_VALUE_INVALID: entry("A text, attribute, or class binding resolved to an object or array.", DOCS.bindings),
  BINDING_REPEAT_INVALID: entry("data-fy-repeat must be on a template and reference an array.", DOCS.bindings),
  BINDING_REPEAT_NESTED: entry("Nested repeats are not supported; use a controller.", DOCS.bindings),
  BINDING_TARGET_INVALID: entry("The binding target or placement is invalid.", DOCS.bindings),
  ANIMATION_INVALID: entry("A data-fy-anim-* value is invalid.", DOCS.deterministic),
  ANIMATION_NOT_FOUND: entry("A scheduled element has no CSS animation.", DOCS.deterministic),
  ANIMATION_MULTIPLE: entry("A scheduled element has multiple animations.", DOCS.deterministic),
  STATIC_ANIMATION_UNSUPPORTED: entry("Static compositions cannot schedule animations.", DOCS.deterministic),
  STATIC_ANIMATION_PAUSED: entry("Static compositions pause CSS animations at time 0.", DOCS.deterministic),
  STATIC_MEDIA_UNSUPPORTED: entry("Static compositions are visual-only; move media to a timeline.", DOCS.timelines),
  STATIC_UPDATE_IGNORED: entry("Static compositions do not run update(); use mount().", DOCS.controllers),
  DETERMINISM_WARNING: entry(
    "Avoid clocks, timers, CSS transitions, and Math.random() in frame code.",
    DOCS.deterministic,
  ),
  SCRIPT_NOT_ALLOWED: entry("The controller is the only executable script.", DOCS.controllers),
  EVENT_HANDLER_NOT_ALLOWED: entry("Inline event handlers are not allowed.", DOCS.controllers),
  URL_NOT_ALLOWED: entry("javascript: URLs are not allowed.", DOCS.controllers),
  ELEMENT_NOT_SUPPORTED: entry("The element is not supported in a composition.", DOCS.commonMistakes),
  ELEMENT_UNKNOWN: entry("Unknown fy-* elements are ignored; check for a typo.", DOCS.commonMistakes),
  CONTENT_OUTSIDE_ROOT: entry("Visual content outside <fy-composition> is not captured.", DOCS.commonMistakes),
  PROPS_INVALID: entry("Props or controller validateProps() failed.", `${DOCS.bindings}#props-schema`),
  PROPS_SCHEMA_INVALID: entry(
    "Resolved props do not match the declared props schema.",
    `${DOCS.bindings}#props-schema`,
  ),
  PROPS_SCHEMA_INVALID_SCHEMA: entry(
    "The props schema is malformed or uses an unsupported keyword.",
    `${DOCS.bindings}#props-schema`,
  ),
  FRAME_OUT_OF_RANGE: entry("The requested frame is outside the composition or timeline duration.", DOCS.reference),
  AUDIO_INVALID: entry("An audio clip is invalid or missing.", DOCS.audio),
  AUDIO_WARNING: entry("Audio overrun or silent embedded media was detected.", DOCS.audio),
  MEDIA_INVALID: entry("A video or audio source is invalid or missing.", DOCS.audio),
  MEDIA_SEEK_FAILED: entry("Chromium could not seek embedded media to the requested frame.", DOCS.timelines),
  ASSET_NOT_FOUND: entry("A local asset is missing or outside the project root.", DOCS.commonMistakes),
  ASSET_URL_INVALID: entry("Asset URLs must use HTTPS; loopback HTTP is allowed for tests.", DOCS.audio),
  ASSET_PATH_INVALID: entry(
    "The asset destination or extension is outside the supported project media path.",
    DOCS.commonMistakes,
  ),
  ASSET_HASH_MISMATCH: entry("The downloaded asset does not match the expected SHA-256.", DOCS.audio),
  ASSET_DOWNLOAD_FAILED: entry("The remote asset could not be downloaded.", DOCS.failureRecovery),
  FONT_MANIFEST_INVALID: entry("fy.fonts.json is invalid.", DOCS.fonts),
  FONT_FILE_MISSING: entry("A font file in the manifest is missing.", DOCS.fonts),
  FONT_FILE_INVALID: entry("A font file has the wrong extension, signature, or path.", DOCS.fonts),
  FONT_HASH_MISMATCH: entry("A vendored font changed size or SHA-256.", DOCS.fonts),
  FONT_LICENSE_MISSING: entry("A font license type or file is missing.", DOCS.fonts),
  FONT_ORPHANED: entry("A font directory is not referenced by fy.fonts.json.", DOCS.fonts),
  FONT_LOAD_FAILED: entry("Chromium failed to load a used @font-face.", DOCS.fonts),
  FONT_REMOTE: entry("Remote fonts are not reproducible; vendor them with font add.", DOCS.fonts),
  FONT_NOT_FOUND: entry("The requested font id is not installed.", DOCS.fonts),
  FONT_PROVIDER_UNAVAILABLE: entry("The Fontsource API or CDN is unavailable.", DOCS.fonts),
  FONT_DOWNLOAD_FAILED: entry("A font response was not a valid font file.", DOCS.fonts),
  OUTPUT_EXISTS: entry("The output or project entry already exists.", DOCS.failureRecovery),
  OUTPUT_FAILED: entry("Frameyard could not write the output atomically.", DOCS.failureRecovery),
  FFMPEG_FAILED: entry("FFmpeg failed while encoding or compositing.", DOCS.failureRecovery),
  ENCODER_WARNING: entry("The selected encoder has a limitation or fallback.", DOCS.failureRecovery),
  FFPROBE_FAILED: entry("FFprobe could not inspect the media or output.", DOCS.failureRecovery),
  BROWSER_FAILED: entry("Chromium failed to launch or navigate.", DOCS.failureRecovery),
  RENDER_FAILED: entry("The render failed before publishing an output.", DOCS.failureRecovery),
  EXECUTABLE_NOT_FOUND: entry("A required external executable was not found.", DOCS.failureRecovery),
  TTS_FAILED: entry("Speech synthesis failed.", DOCS.audio),
  TRANSCRIBE_FAILED: entry("Transcription failed.", DOCS.audio),
  TRANSCRIPT_INVALID: entry("A transcript file is invalid or missing.", DOCS.subtitles),
  TRANSCRIPT_WORDS_UNAVAILABLE: entry("The transcript has no measured word timings.", DOCS.subtitles),
  TRANSCRIPT_WARNING: entry("The transcript has no text or timed segments.", DOCS.subtitles),
  MANIFEST_INVALID: entry("A generated-asset manifest is invalid.", DOCS.audio),
  IMAGE_INVALID: entry("An image input is missing, unreadable, or incompatible.", DOCS.reference),
  POLICY_INVALID: entry("fy.policy.json or FRAMEYARD_POLICY is invalid.", DOCS.failureRecovery),
  RESOURCE_POLICY_BLOCKED: entry("The active resource tier blocks this operation.", DOCS.failureRecovery),
  RESOURCE_POLICY_LIMIT: entry("The request exceeds the active resource tier limit.", DOCS.failureRecovery),
  RESOURCE_PROFILE_CONFLICT: entry(
    "A requested worker or concurrency value exceeds the active profile.",
    DOCS.failureRecovery,
  ),
  CANCELLED: entry("The operation was cancelled.", DOCS.failureRecovery),
  INTERNAL: entry("An unexpected internal error occurred.", DOCS.failureRecovery),
};

export function explainDiagnosticCode(code: string): DiagnosticExplanation | undefined {
  if (!Object.hasOwn(EXPLANATIONS, code)) {
    return undefined;
  }
  const key = code as FrameyardErrorCode;
  const explanation = EXPLANATIONS[key];
  return {
    code: key,
    message: explanation.message,
    ...(explanation.docs !== undefined ? { docs: explanation.docs } : {}),
    ...(explanation.examples !== undefined ? { examples: explanation.examples } : {}),
  };
}

export function listDiagnosticExplanations(): Array<{ code: FrameyardErrorCode; summary: string }> {
  return (Object.keys(EXPLANATIONS) as FrameyardErrorCode[]).map((code) => ({
    code,
    summary: EXPLANATIONS[code].message,
  }));
}
