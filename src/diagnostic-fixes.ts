import { ANIMATION_PRESETS } from "./animation-presets.js";
import { KNOWN_DATA_FY_ATTRIBUTES } from "./composition/attributes.js";
import type { DiagnosticFix, FrameyardErrorCode } from "./errors.js";

const DOCS = {
  bindings: "skills/frameyard/references/bindings.md",
  commonMistakes: "skills/frameyard/references/common-mistakes.md",
  controllers: "skills/frameyard/references/controllers.md",
  deterministic: "skills/frameyard/references/deterministic-authoring.md",
  diagnostics: "skills/frameyard/references/diagnostics.md",
  failureRecovery: "skills/frameyard/references/failure-recovery.md",
  fonts: "skills/frameyard/references/fonts.md",
  includes: "skills/frameyard/references/includes.md",
  timelines: "skills/frameyard/references/timelines.md",
  audio: "skills/frameyard/references/audio-assets.md",
  subtitles: "skills/frameyard/references/subtitles-karaoke.md",
} as const;

function detailString(details: unknown, key: string): string | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] as number) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (previous[rightIndex] as number) + 1,
        (current[rightIndex - 1] as number) + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] as number;
}

function closestDataFyAttribute(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_DATA_FY_ATTRIBUTES) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 3 ? best : undefined;
}

/**
 * Returns an actionable correction for a stable diagnostic code. The mapping is
 * intentionally conservative: unknown codes have no fix, and fixes never apply
 * themselves.
 */
export function diagnosticFix(code: FrameyardErrorCode, details?: unknown, message = ""): DiagnosticFix | undefined {
  switch (code) {
    case "BINDING_INVALID": {
      const attribute = detailString(details, "attribute");
      if (attribute !== undefined && attribute.startsWith("data-fy-") && /Unknown Frameyard attribute/i.test(message)) {
        const to = closestDataFyAttribute(attribute);
        return {
          kind: "attribute",
          message:
            to === undefined
              ? `Use a documented data-fy-* attribute instead of "${attribute}".`
              : `Use "${to}" instead of "${attribute}".`,
          from: attribute,
          ...(to !== undefined ? { to } : {}),
          docs: DOCS.bindings,
        };
      }
      const value = detailString(details, "value");
      if (value !== undefined && /path/i.test(message)) {
        return {
          kind: "path",
          message: `Fix the binding path "${value}".`,
          from: value,
          docs: DOCS.bindings,
        };
      }
      return {
        kind: "docs",
        message: "Review the binding syntax and supported attributes.",
        docs: DOCS.bindings,
      };
    }
    case "BINDING_PATH_MISSING": {
      const path = detailString(details, "value");
      const suggestion = detailString(details, "suggestion");
      return {
        kind: "path",
        message:
          path === undefined
            ? "Add the missing prop or correct the binding path."
            : suggestion === undefined
              ? `Add "${path}" to the composition defaults or correct the binding path.`
              : `Replace "${path}" with "${suggestion}", or add "${path}" to the defaults.`,
        ...(path !== undefined ? { from: path } : {}),
        ...(suggestion !== undefined ? { to: suggestion } : {}),
        docs: DOCS.bindings,
      };
    }
    case "BINDING_REPEAT_INVALID":
    case "BINDING_TARGET_INVALID":
      return {
        kind: "docs",
        message: "Review repeat, text, and attribute binding placement.",
        docs: DOCS.bindings,
      };
    case "ANIMATION_INVALID": {
      const attribute = detailString(details, "attribute");
      const value = detailString(details, "value");
      if (attribute === "data-fy-anim-preset") {
        return {
          kind: "value",
          message: `Use one of: ${ANIMATION_PRESETS.join(", ")}.`,
          ...(value !== undefined ? { from: value } : {}),
          docs: DOCS.deterministic,
        };
      }
      return {
        kind: "value",
        message: "Use a valid data-fy-anim-* value or remove the animation attribute.",
        docs: DOCS.deterministic,
      };
    }
    case "STATIC_ANIMATION_UNSUPPORTED":
      return {
        kind: "docs",
        message: "Remove the animation or declare duration-in-frames; static compositions are timeless.",
        docs: DOCS.deterministic,
      };
    case "INCLUDE_NOT_FOUND": {
      const value = detailString(details, "value");
      return {
        kind: "path",
        message:
          value === undefined
            ? "Create the missing partial or correct the include src."
            : `Create "${value}" or correct the include src.`,
        ...(value !== undefined ? { from: value } : {}),
        docs: DOCS.includes,
      };
    }
    case "INCLUDE_CYCLE":
      return {
        kind: "docs",
        message: "Break the include cycle; a partial cannot include itself directly or through another partial.",
        docs: DOCS.includes,
      };
    case "INCLUDE_INVALID":
      return {
        kind: "docs",
        message: "Use one top-level <fy-partial> root with direct props, schema, style, and content children.",
        docs: DOCS.includes,
      };
    case "INCLUDE_DEPTH_EXCEEDED":
      return {
        kind: "docs",
        message: "Flatten the include chain; the maximum depth is 32 files.",
        docs: DOCS.includes,
      };
    case "CONTROLLER_INVALID":
      return {
        kind: "docs",
        message: "Use exactly one inline or external controller and export at least one supported hook.",
        docs: DOCS.controllers,
      };
    case "STATIC_MEDIA_UNSUPPORTED":
      return {
        kind: "docs",
        message: "Move video, audio, or transcripts to a timeline track; static compositions are visual-only.",
        docs: DOCS.timelines,
      };
    case "ASSET_NOT_FOUND": {
      const value = detailString(details, "value");
      return {
        kind: "path",
        message:
          value === undefined
            ? "Create the missing local asset or correct its project-relative path."
            : `Create "${value}" or correct its project-relative path.`,
        ...(value !== undefined ? { from: value } : {}),
        docs: DOCS.commonMistakes,
      };
    }
    case "ASSET_URL_INVALID":
      return {
        kind: "value",
        message: "Use an HTTPS URL; loopback HTTP is allowed only for tests.",
        docs: DOCS.audio,
      };
    case "ASSET_PATH_INVALID":
      return {
        kind: "path",
        message: "Use a project-relative media path with a supported image, video, or audio extension.",
        docs: DOCS.commonMistakes,
      };
    case "ASSET_HASH_MISMATCH":
      return {
        kind: "value",
        message: "Remove --sha256, download again, or verify the expected hash.",
        docs: DOCS.audio,
      };
    case "ASSET_DOWNLOAD_FAILED":
      return {
        kind: "docs",
        message: "Check the URL, network access, and HTTP status, then retry.",
        docs: DOCS.failureRecovery,
      };
    case "MEDIA_INVALID":
      return {
        kind: "docs",
        message: "Use a local project video/audio file and supported data-fy-* media attributes.",
        docs: DOCS.audio,
      };
    case "TRANSCRIPT_INVALID":
      return {
        kind: "docs",
        message: "Use a canonical transcript JSON file and valid fy-transcript attributes.",
        docs: DOCS.subtitles,
      };
    case "TIMELINE_CLIP_OVERLAP":
      return {
        kind: "value",
        message: "Move or shorten one clip, or declare a transition for the overlap window.",
        docs: DOCS.timelines,
      };
    case "TIMELINE_TRANSITION_GEOMETRY":
      return {
        kind: "value",
        message: "Adjust clip starts and durations so from.start < to.start < from.end < to.end.",
        docs: DOCS.timelines,
      };
    case "FONT_LOAD_FAILED":
      return {
        kind: "command",
        message: "Verify the installed font manifest and files.",
        command: "npx frameyard font verify --json",
        docs: DOCS.fonts,
      };
    case "FONT_FILE_MISSING":
    case "FONT_HASH_MISMATCH":
      return {
        kind: "command",
        message: "Reinstall or verify the vendored font files.",
        command: "npx frameyard font verify --json",
        docs: DOCS.fonts,
      };
    case "OUTPUT_EXISTS":
      return {
        kind: "value",
        message: "Choose a new output path or pass --overwrite when replacement is intended.",
        patch: { overwrite: true },
        docs: DOCS.failureRecovery,
      };
    case "PROPS_SCHEMA_INVALID": {
      const path = detailString(details, "path");
      const suggestion = detailString(details, "suggestion");
      return {
        kind: "path",
        message: suggestion ?? (path === undefined ? "Add or correct the prop." : `Add or correct "${path}".`),
        ...(path !== undefined ? { from: path } : {}),
        docs: `${DOCS.bindings}#props-schema`,
      };
    }
    case "PROPS_SCHEMA_INVALID_SCHEMA":
      return {
        kind: "docs",
        message: "Use the supported props-schema subset and keep the block top-level.",
        docs: `${DOCS.bindings}#props-schema`,
      };
    case "DETERMINISM_WARNING":
      return {
        kind: "docs",
        message: "Use frame-derived values instead of clocks, timers, or Math.random().",
        docs: DOCS.deterministic,
      };
    case "RESOURCE_POLICY_BLOCKED":
      return {
        kind: "command",
        message: "Preview the handoff plan with --dry-run or ask for the full tier.",
        command: "npx frameyard render <id> --dry-run --json",
        docs: DOCS.failureRecovery,
      };
    case "CANCELLED":
      return {
        kind: "docs",
        message: "Rerun the command when ready.",
        docs: DOCS.failureRecovery,
      };
    default:
      return undefined;
  }
}
