import type { CompositionDiagnostic } from "../contracts.js";
import type { DocumentAdapter } from "./adapter.js";
import { isAnimationAttribute } from "./attributes.js";
import { attributeDetails, createDiagnostic } from "./diagnostics.js";
import { findElements, getAttribute } from "./walk.js";

export interface AnimationDeclaration<Node> {
  element: Node;
  startFrame?: number;
  durationInFrames?: number;
  easing?: string;
  attributes: readonly string[];
}

export interface ReadAnimationDeclarationsOptions {
  path: string;
  includeTemplateContent: boolean;
}

export interface AnimationDeclarations<Node> {
  entries: AnimationDeclaration<Node>[];
  diagnostics: CompositionDiagnostic[];
}

export function readAnimationDeclarations<Node>(
  adapter: DocumentAdapter<Node>,
  options: ReadAnimationDeclarationsOptions,
): AnimationDeclarations<Node> {
  const diagnostics: CompositionDiagnostic[] = [];
  const entries: AnimationDeclaration<Node>[] = [];
  const targets = findElements(
    adapter,
    (node) => adapter.attributes(node).some((attribute) => isAnimationAttribute(attribute.name)),
    options.includeTemplateContent,
  );

  for (const target of targets) {
    const attributes = adapter
      .attributes(target.node)
      .filter((attribute) => isAnimationAttribute(attribute.name))
      .map((attribute) => attribute.name);
    let startFrame: number | undefined;
    let durationInFrames: number | undefined;
    let easing: string | undefined;

    const start = getAttribute(adapter, target.node, "data-fy-anim-start");
    if (start !== undefined) {
      const value = Number(start);
      if (!/^\d+$/.test(start.trim()) || !Number.isInteger(value) || value < 0) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "ANIMATION_INVALID",
            "data-fy-anim-start must be a non-negative integer frame count.",
            attributeDetails(adapter, options.path, target.node, "data-fy-anim-start", { value: start }),
          ),
        );
      } else {
        startFrame = value;
      }
    }

    const duration = getAttribute(adapter, target.node, "data-fy-anim-duration");
    if (duration !== undefined) {
      const value = Number(duration);
      if (!/^\d+$/.test(duration.trim()) || !Number.isInteger(value) || value <= 0) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "ANIMATION_INVALID",
            "data-fy-anim-duration must be a positive integer frame count.",
            attributeDetails(adapter, options.path, target.node, "data-fy-anim-duration", { value: duration }),
          ),
        );
      } else {
        durationInFrames = value;
      }
    }

    const easingValue = getAttribute(adapter, target.node, "data-fy-anim-easing");
    if (easingValue !== undefined) {
      if (easingValue.trim().length === 0) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "ANIMATION_INVALID",
            "data-fy-anim-easing must not be empty.",
            attributeDetails(adapter, options.path, target.node, "data-fy-anim-easing"),
          ),
        );
      } else {
        easing = easingValue;
      }
    }

    entries.push({
      element: target.node,
      ...(startFrame !== undefined ? { startFrame } : {}),
      ...(durationInFrames !== undefined ? { durationInFrames } : {}),
      ...(easing !== undefined ? { easing } : {}),
      attributes,
    });
  }

  return { entries, diagnostics };
}
