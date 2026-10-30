import {
  assertJsonSerializable,
  isPlainObject,
  mergeProps,
  type CompositionDiagnostic,
  type CompositionDiagnosticDetails,
  type CompositionMetadata,
  type ControllerDeclaration,
  type Props,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import type { DocumentAdapter } from "./adapter.js";
import { attributeDetails, createDiagnostic, elementDetails, lineColumn, locationDetails } from "./diagnostics.js";
import { isLocalRelative } from "./paths.js";
import { findElements, getAttribute, type ElementMatch } from "./walk.js";

export interface CompositionDescriptor {
  metadata: CompositionMetadata | null;
  defaultProps: Readonly<Props>;
  controller: ControllerDeclaration | null;
}

export interface CompositionDescriptorResult<Node> {
  root: Node | null;
  descriptor: CompositionDescriptor;
  valid: boolean;
  diagnostics: CompositionDiagnostic[];
}

export interface ReadCompositionDescriptorOptions {
  /** Project-relative path to the composition document, used in diagnostics. */
  path: string;
  /**
   * Resolves an external controller's authoring `src` to a project-relative
   * path. The reader stays pure; the caller supplies the path world.
   */
  resolvePath(raw: string): string;
}

const METADATA_ATTRIBUTES = ["width", "height", "fps", "duration-in-frames"] as const;

function readRoot<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
): { root: Node | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const roots = findElements(adapter, (node) => adapter.tagName(node) === "fy-composition");

  if (roots.length === 0) {
    diagnostics.push(
      createDiagnostic("error", "COMPOSITION_INVALID", "Composition document must contain one <fy-composition> root.", {
        path,
      }),
    );
    return { root: null, diagnostics };
  }

  for (const extra of roots.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        "Composition document must contain exactly one <fy-composition> root.",
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const first = roots[0] as ElementMatch<Node>;
  if (!first.ancestors.some((ancestor) => adapter.tagName(ancestor) === "body")) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        "The <fy-composition> root must be inside <body>.",
        elementDetails(adapter, path, first.node),
      ),
    );
  }
  if (first.inTemplate) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        "The <fy-composition> root must not be inside a <template>.",
        elementDetails(adapter, path, first.node),
      ),
    );
  }

  return { root: first.node, diagnostics };
}

function readPositiveInteger<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  root: Node,
  attribute: string,
  diagnostics: CompositionDiagnostic[],
): number | null {
  const raw = getAttribute(adapter, root, attribute);
  if (raw === undefined) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        `Missing required "${attribute}" attribute on <fy-composition>.`,
        attributeDetails(adapter, path, root, attribute),
      ),
    );
    return null;
  }

  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value <= 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        `"${attribute}" must be a positive integer; received "${raw}".`,
        attributeDetails(adapter, path, root, attribute, { value: raw }),
      ),
    );
    return null;
  }
  return value;
}

function readPositiveNumber<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  root: Node,
  attribute: string,
  diagnostics: CompositionDiagnostic[],
): number | null {
  const raw = getAttribute(adapter, root, attribute);
  if (raw === undefined) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        `Missing required "${attribute}" attribute on <fy-composition>.`,
        attributeDetails(adapter, path, root, attribute),
      ),
    );
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        `"${attribute}" must be a positive number; received "${raw}".`,
        attributeDetails(adapter, path, root, attribute, { value: raw }),
      ),
    );
    return null;
  }
  return value;
}

function readMetadata<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  root: Node,
): { metadata: CompositionMetadata | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const values = new Map<(typeof METADATA_ATTRIBUTES)[number], number | null>();

  for (const attribute of METADATA_ATTRIBUTES) {
    values.set(
      attribute,
      attribute === "fps"
        ? readPositiveNumber(adapter, path, root, attribute, diagnostics)
        : readPositiveInteger(adapter, path, root, attribute, diagnostics),
    );
  }

  const width = values.get("width") ?? null;
  const height = values.get("height") ?? null;
  const fps = values.get("fps") ?? null;
  const durationInFrames = values.get("duration-in-frames") ?? null;

  return {
    metadata:
      width !== null && height !== null && fps !== null && durationInFrames !== null
        ? { width, height, fps, durationInFrames }
        : null,
    diagnostics,
  };
}

function readDefaultProps<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
): { defaultProps: Readonly<Props>; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const blocks = findElements(
    adapter,
    (node) =>
      adapter.tagName(node) === "script" &&
      getAttribute(adapter, node, "type")?.toLowerCase() === "application/json" &&
      getAttribute(adapter, node, "data-fy") === "props",
  );

  for (const extra of blocks.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_INVALID",
        'A composition may contain at most one data-fy="props" block.',
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const block = blocks[0];
  if (!block) {
    return { defaultProps: Object.freeze({}) as Readonly<Props>, diagnostics };
  }

  if (block.inTemplate) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_INVALID",
        'The data-fy="props" block must not be inside a <template>.',
        elementDetails(adapter, path, block.node),
      ),
    );
  }

  try {
    const parsed: unknown = JSON.parse(adapter.text(block.node));
    if (!isPlainObject(parsed)) {
      throw new Error('The data-fy="props" block must contain a JSON object.');
    }
    assertJsonSerializable(parsed, "defaultProps");
    return { defaultProps: mergeProps(parsed as Props, undefined), diagnostics };
  } catch (error) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_INVALID",
        `Invalid default props: ${errorMessage(error)}`,
        elementDetails(adapter, path, block.node),
      ),
    );
    return { defaultProps: Object.freeze({}) as Readonly<Props>, diagnostics };
  }
}

function readController<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  resolvePath: (raw: string) => string,
): { controller: ControllerDeclaration | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const blocks = findElements(
    adapter,
    (node) =>
      adapter.tagName(node) === "script" && getAttribute(adapter, node, "type")?.toLowerCase() === "text/fy-controller",
  );

  for (const extra of blocks.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "A composition may declare at most one controller.",
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const block = blocks[0];
  if (!block) {
    return { controller: null, diagnostics };
  }

  if (block.inTemplate) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "The controller block must not be inside a <template>.",
        elementDetails(adapter, path, block.node),
      ),
    );
  }

  const src = getAttribute(adapter, block.node, "src");
  const source = adapter.text(block.node);
  const hasSource = source.trim().length > 0;

  if (src !== undefined && hasSource) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "A controller must be either inline or external, not both.",
        attributeDetails(adapter, path, block.node, "src"),
      ),
    );
    return { controller: null, diagnostics };
  }

  if (src === undefined && !hasSource) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "A controller must contain inline source or reference an external module with src.",
        elementDetails(adapter, path, block.node),
      ),
    );
    return { controller: null, diagnostics };
  }

  if (src !== undefined) {
    const location = adapter.location(block.node, "src") ?? adapter.location(block.node);
    const pathDetails: CompositionDiagnosticDetails = {
      path,
      element: adapter.tagName(block.node),
      attribute: "src",
      ...locationDetails(location),
      value: src,
    };

    if (!isLocalRelative(src)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "CONTROLLER_INVALID",
          `Controller path must be a local project file, not "${src}".`,
          pathDetails,
        ),
      );
      return { controller: { kind: "external", rawSrc: src, ...lineColumn(location) }, diagnostics };
    }

    let resolved: string;
    try {
      resolved = resolvePath(src);
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "CONTROLLER_INVALID",
          `Could not resolve controller path "${src}": ${errorMessage(error)}`,
          pathDetails,
        ),
      );
      return { controller: { kind: "external", rawSrc: src, ...lineColumn(location) }, diagnostics };
    }

    return {
      controller: { kind: "external", rawSrc: src, src: resolved, ...lineColumn(location) },
      diagnostics,
    };
  }

  const textNode = adapter.children(block.node).find((child) => !adapter.isElement(child));
  const location = textNode ? adapter.location(textNode) : adapter.location(block.node);
  return {
    controller: { kind: "inline", source, ...lineColumn(location) },
    diagnostics,
  };
}

/**
 * Reads the fixed facts of an HTML composition: metadata, default props, and
 * the controller declaration. The reader is pure; the adapter supplies tree
 * access and source locations, and the caller supplies controller path
 * resolution.
 */
export function readCompositionDescriptor<Node>(
  adapter: DocumentAdapter<Node>,
  options: ReadCompositionDescriptorOptions,
): CompositionDescriptorResult<Node> {
  const rootRead = readRoot(adapter, options.path);
  const diagnostics = [...rootRead.diagnostics];

  let metadata: CompositionMetadata | null = null;
  if (rootRead.root) {
    const metadataRead = readMetadata(adapter, options.path, rootRead.root);
    metadata = metadataRead.metadata;
    diagnostics.push(...metadataRead.diagnostics);
  }

  const propsRead = readDefaultProps(adapter, options.path);
  diagnostics.push(...propsRead.diagnostics);

  const controllerRead = readController(adapter, options.path, options.resolvePath);
  diagnostics.push(...controllerRead.diagnostics);

  return {
    root: rootRead.root,
    descriptor: {
      metadata,
      defaultProps: propsRead.defaultProps,
      controller: controllerRead.controller,
    },
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}
