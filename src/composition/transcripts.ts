import { resolveBindingPath } from "../bindings.js";
import {
  normalizeTranscriptClip,
  type CompositionDiagnostic,
  type Props,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import { errorMessage, isFrameyardError } from "../errors.js";
import type { DocumentAdapter } from "./adapter.js";
import { createDiagnostic, elementDetails } from "./diagnostics.js";
import { isLocalRelative, normalizeLocalPath } from "./paths.js";
import { findElements, getAttribute, hasAttribute } from "./walk.js";

export interface TranscriptDeclaration<Node> {
  clip: ResolvedTranscriptClip;
  element: Node;
}

export interface TranscriptDeclarations<Node> {
  declarations: TranscriptDeclaration<Node>[];
  diagnostics: CompositionDiagnostic[];
}

export interface ReadTranscriptDeclarationsOptions {
  path: string;
  includeTemplateContent: boolean;
  props: Readonly<Props>;
  /** True after the host has applied bindings; the resolved src wins over the binding attribute. */
  bindingsApplied?: boolean;
}

export function readTranscriptDeclarations<Node>(
  adapter: DocumentAdapter<Node>,
  options: ReadTranscriptDeclarationsOptions,
): TranscriptDeclarations<Node> {
  const diagnostics: CompositionDiagnostic[] = [];
  const declarations: TranscriptDeclaration<Node>[] = [];
  const candidates = findElements(
    adapter,
    (node) => adapter.tagName(node) === "fy-transcript",
    options.includeTemplateContent,
  );

  let index = 0;
  for (const candidate of candidates) {
    const literal = getAttribute(adapter, candidate.node, "src");
    const bound = getAttribute(adapter, candidate.node, "data-fy-attr-src");

    if (!(options.bindingsApplied === true && literal !== undefined) && literal !== undefined && bound !== undefined) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "TRANSCRIPT_INVALID",
          "Use either src or data-fy-attr-src on <fy-transcript>, not both.",
          elementDetails(adapter, options.path, candidate.node),
        ),
      );
      continue;
    }

    if (literal === undefined && bound === undefined) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "TRANSCRIPT_INVALID",
          "<fy-transcript> requires a src attribute or data-fy-attr-src binding.",
          elementDetails(adapter, options.path, candidate.node),
        ),
      );
      continue;
    }

    let source: string | null = literal ?? null;
    if (source === null && bound !== undefined) {
      const root = bound.split(".")[0];
      if (root === "item" || root === "index") {
        continue;
      }
      const resolved = resolveBindingPath({ props: options.props }, bound);
      if (!resolved.found) {
        continue;
      }
      if (typeof resolved.value !== "string" || resolved.value.length === 0) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "TRANSCRIPT_INVALID",
            `Transcript binding "${bound}" must resolve to a non-empty local path.`,
            elementDetails(adapter, options.path, candidate.node, { value: bound }),
          ),
        );
        continue;
      }
      source = resolved.value;
    }

    if (source === null) {
      continue;
    }

    if (!isLocalRelative(source)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "TRANSCRIPT_INVALID",
          `Transcript path must be a local project file, not "${source}".`,
          elementDetails(adapter, options.path, candidate.node, { value: source }),
        ),
      );
      continue;
    }

    try {
      const clip = normalizeTranscriptClip(
        { src: normalizeLocalPath(source), words: hasAttribute(adapter, candidate.node, "words") },
        index,
      );
      index += 1;
      declarations.push({ clip, element: candidate.node });
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          "error",
          isFrameyardError(error) ? error.code : "TRANSCRIPT_INVALID",
          errorMessage(error),
          elementDetails(adapter, options.path, candidate.node),
        ),
      );
    }
  }

  return { declarations, diagnostics };
}
