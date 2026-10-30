import { resolveBindingPath } from "../bindings.js";
import { normalizeAudioClip, type CompositionDiagnostic, type Props, type ResolvedAudioClip } from "../contracts.js";
import { errorMessage, isFrameyardError } from "../errors.js";
import type { DocumentAdapter } from "./adapter.js";
import { isMediaAttribute } from "./attributes.js";
import { attributeDetails, createDiagnostic, elementDetails } from "./diagnostics.js";
import { isLocalRelative, normalizeLocalPath } from "./paths.js";
import { findElements, getAttribute, hasAttribute } from "./walk.js";

export interface MediaDeclaration<Node> {
  clip: ResolvedAudioClip;
  element: Node;
}

export interface MediaDeclarations<Node> {
  audio: MediaDeclaration<Node>[];
  embedded: MediaDeclaration<Node>[];
  diagnostics: CompositionDiagnostic[];
}

export interface ReadMediaDeclarationsOptions {
  path: string;
  includeTemplateContent: boolean;
  props: Readonly<Props>;
  /** True after the host has applied bindings; the resolved src wins over the binding attribute. */
  bindingsApplied?: boolean;
}

export interface MediaSpec {
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
}

export function readMediaSpec<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  element: Node,
  diagnostics: CompositionDiagnostic[],
  defaultVolume = 1,
): MediaSpec | null {
  let valid = true;

  const startRaw = getAttribute(adapter, element, "data-fy-start");
  let startFrame = 0;
  if (startRaw !== undefined) {
    const value = Number(startRaw);
    if (!/^\d+$/.test(startRaw.trim()) || !Number.isInteger(value) || value < 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "MEDIA_INVALID",
          "data-fy-start must be a non-negative integer frame.",
          attributeDetails(adapter, path, element, "data-fy-start", { value: startRaw }),
        ),
      );
      valid = false;
    } else {
      startFrame = value;
    }
  }

  const trimRaw = getAttribute(adapter, element, "data-fy-trim");
  let trimStart = 0;
  if (trimRaw !== undefined) {
    const value = Number(trimRaw);
    if (!Number.isFinite(value) || value < 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "MEDIA_INVALID",
          "data-fy-trim must be a non-negative number of seconds.",
          attributeDetails(adapter, path, element, "data-fy-trim", { value: trimRaw }),
        ),
      );
      valid = false;
    } else {
      trimStart = value;
    }
  }

  const durationRaw = getAttribute(adapter, element, "data-fy-duration");
  let trimDuration: number | undefined;
  if (durationRaw !== undefined) {
    const value = Number(durationRaw);
    if (!Number.isFinite(value) || value <= 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "MEDIA_INVALID",
          "data-fy-duration must be a positive number of seconds.",
          attributeDetails(adapter, path, element, "data-fy-duration", { value: durationRaw }),
        ),
      );
      valid = false;
    } else {
      trimDuration = value;
    }
  }

  const audio = getAttribute(adapter, element, "data-fy-audio");
  if (audio !== undefined && (adapter.tagName(element) !== "video" || audio !== "off")) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "MEDIA_INVALID",
        'data-fy-audio is only valid on <video> with the value "off".',
        attributeDetails(adapter, path, element, "data-fy-audio", { value: audio }),
      ),
    );
    valid = false;
  }

  const volumeRaw = getAttribute(adapter, element, "data-fy-volume");
  let volume = hasAttribute(adapter, element, "muted") ? 0 : defaultVolume;
  if (volumeRaw !== undefined) {
    const value = Number(volumeRaw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "MEDIA_INVALID",
          "data-fy-volume must be between 0 and 1.",
          attributeDetails(adapter, path, element, "data-fy-volume", { value: volumeRaw }),
        ),
      );
      valid = false;
    } else if (!hasAttribute(adapter, element, "muted")) {
      volume = value;
    }
  }

  if (!valid) {
    return null;
  }
  return {
    startFrame,
    trimStart,
    ...(trimDuration !== undefined ? { trimDuration } : {}),
    volume,
  };
}

function resolveMediaSource<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  element: Node,
  props: Readonly<Props>,
  bindingsApplied: boolean,
  diagnostics: CompositionDiagnostic[],
): string | null {
  const literal = getAttribute(adapter, element, "src");
  const bound = getAttribute(adapter, element, "data-fy-attr-src");

  if (bindingsApplied && literal !== undefined) {
    return literal;
  }

  if (literal !== undefined && bound !== undefined) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "MEDIA_INVALID",
        `Use either src or data-fy-attr-src on <${adapter.tagName(element)}>, not both.`,
        elementDetails(adapter, path, element),
      ),
    );
    return null;
  }

  if (literal === undefined && bound === undefined) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "MEDIA_INVALID",
        `<${adapter.tagName(element)}> requires a src attribute or data-fy-attr-src binding.`,
        elementDetails(adapter, path, element),
      ),
    );
    return null;
  }

  if (literal !== undefined) {
    return literal;
  }

  const root = (bound as string).split(".")[0];
  if (root === "item" || root === "index") {
    return null;
  }

  const resolved = resolveBindingPath({ props }, bound as string);
  if (!resolved.found) {
    return null;
  }
  if (typeof resolved.value !== "string" || resolved.value.length === 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "MEDIA_INVALID",
        `Media binding "${bound}" must resolve to a non-empty local path.`,
        elementDetails(adapter, path, element, { value: bound as string }),
      ),
    );
    return null;
  }
  return resolved.value;
}

export function readMediaDeclarations<Node>(
  adapter: DocumentAdapter<Node>,
  options: ReadMediaDeclarationsOptions,
): MediaDeclarations<Node> {
  const diagnostics: CompositionDiagnostic[] = [];
  const audio: MediaDeclaration<Node>[] = [];
  const embedded: MediaDeclaration<Node>[] = [];
  const candidates = findElements(
    adapter,
    (node) => {
      const tag = adapter.tagName(node);
      return (
        tag === "audio" ||
        tag === "video" ||
        adapter.attributes(node).some((attribute) => isMediaAttribute(attribute.name))
      );
    },
    options.includeTemplateContent,
  );

  let index = 0;
  for (const candidate of candidates) {
    const tag = adapter.tagName(candidate.node);
    const attributes = adapter.attributes(candidate.node).filter((attribute) => isMediaAttribute(attribute.name));

    if (tag !== "audio" && tag !== "video") {
      for (const attribute of attributes) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "MEDIA_INVALID",
            `${attribute.name} is only valid on <audio> or <video>.`,
            attributeDetails(adapter, options.path, candidate.node, attribute.name),
          ),
        );
      }
      continue;
    }

    const spec = readMediaSpec(adapter, options.path, candidate.node, diagnostics);
    if (!spec) {
      continue;
    }

    const source = resolveMediaSource(
      adapter,
      options.path,
      candidate.node,
      options.props,
      options.bindingsApplied === true,
      diagnostics,
    );
    if (source === null) {
      continue;
    }

    if (!isLocalRelative(source)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "MEDIA_INVALID",
          `Media path must be a local project file, not "${source}".`,
          elementDetails(adapter, options.path, candidate.node, { value: source }),
        ),
      );
      continue;
    }

    let clip: ResolvedAudioClip;
    try {
      clip = normalizeAudioClip(
        {
          src: normalizeLocalPath(source),
          startFrame: spec.startFrame,
          trimStart: spec.trimStart,
          ...(spec.trimDuration !== undefined ? { trimDuration: spec.trimDuration } : {}),
          volume: spec.volume,
        },
        index,
      );
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          "error",
          isFrameyardError(error) ? error.code : "MEDIA_INVALID",
          errorMessage(error),
          elementDetails(adapter, options.path, candidate.node),
        ),
      );
      continue;
    }

    index += 1;
    const declaration = { clip, element: candidate.node };
    if (tag === "audio") {
      audio.push(declaration);
    } else if (
      !hasAttribute(adapter, candidate.node, "muted") &&
      getAttribute(adapter, candidate.node, "data-fy-audio") !== "off"
    ) {
      embedded.push(declaration);
    }
  }

  return { audio, embedded, diagnostics };
}
