import {
  assertJsonSerializable,
  isPlainObject,
  mergeProps,
  type CompositionDiagnostic,
  type CompositionDiagnosticDetails,
  type ControllerDeclaration,
  type DeclaredCompositionMetadata,
  type Props,
  type PropsSchema,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import { parsePropsSchema } from "../props-schema.js";
import type { DocumentAdapter } from "./adapter.js";
import { attributeDetails, createDiagnostic, elementDetails, lineColumn, locationDetails } from "./diagnostics.js";
import { isLocalRelative } from "./paths.js";
import { findElements, getAttribute, type ElementMatch } from "./walk.js";

export interface CompositionDescriptor {
  /**
   * Declared metadata before format resolution. Null when the source declares
   * invalid time metadata, declares only one of `width` and `height`, or
   * declares `fps` without `duration-in-frames`. A composition that declares
   * neither `duration-in-frames` nor `fps` is static and resolves with a null
   * `durationInFrames`.
   */
  metadata: DeclaredCompositionMetadata | null;
  defaultProps: Readonly<Props>;
  /** Parsed optional props schema; null when absent or invalid. */
  propsSchema: PropsSchema | null;
  controller: ControllerDeclaration | null;
}

export interface CompositionDescriptorResult<Node> {
  root: Node | null;
  descriptor: CompositionDescriptor;
  valid: boolean;
  diagnostics: CompositionDiagnostic[];
}

export type CompositionRootScope = "document" | "fragment";

export interface ReadCompositionDescriptorOptions {
  /** Project-relative path to the composition source, used in diagnostics. */
  path: string;
  /**
   * Resolves an external controller's authoring `src` to a project-relative
   * path. The reader stays pure; the caller supplies the path world.
   */
  resolvePath(raw: string): string;
  /**
   * Whether the reader is looking at a served HTML document or an authoring
   * fragment. Document mode requires the root inside `<body>`; fragment mode
   * requires the root and metadata blocks at the top level.
   */
  rootScope?: CompositionRootScope;
}

function readRoot<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  rootScope: CompositionRootScope,
): { root: Node | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const roots = findElements(adapter, (node) => adapter.tagName(node) === "fy-composition");

  if (roots.length === 0) {
    diagnostics.push(
      createDiagnostic("error", "COMPOSITION_INVALID", "Composition must contain one <fy-composition> root.", {
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
        "Composition must contain exactly one <fy-composition> root.",
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const first = roots[0] as ElementMatch<Node>;
  if (first.inTemplate) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        "The <fy-composition> root must not be inside a <template>.",
        elementDetails(adapter, path, first.node),
      ),
    );
  } else if (rootScope === "fragment") {
    if (first.ancestors.length > 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "COMPOSITION_INVALID",
          "The <fy-composition> root must be a top-level element in the composition fragment.",
          elementDetails(adapter, path, first.node),
        ),
      );
    }
  } else if (!first.ancestors.some((ancestor) => adapter.tagName(ancestor) === "body")) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        "The <fy-composition> root must be inside <body>.",
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
  required: boolean,
): number | null {
  const raw = getAttribute(adapter, root, attribute);
  if (raw === undefined) {
    if (required) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "COMPOSITION_INVALID",
          `Missing required "${attribute}" attribute on <fy-composition>.`,
          attributeDetails(adapter, path, root, attribute),
        ),
      );
    }
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
  required: boolean,
): number | null {
  const raw = getAttribute(adapter, root, attribute);
  if (raw === undefined) {
    if (required) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "COMPOSITION_INVALID",
          `Missing required "${attribute}" attribute on <fy-composition>.`,
          attributeDetails(adapter, path, root, attribute),
        ),
      );
    }
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
): { metadata: DeclaredCompositionMetadata | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const hasDuration = getAttribute(adapter, root, "duration-in-frames") !== undefined;
  const hasFps = getAttribute(adapter, root, "fps") !== undefined;
  const width = readPositiveInteger(adapter, path, root, "width", diagnostics, false);
  const height = readPositiveInteger(adapter, path, root, "height", diagnostics, false);
  const fps = readPositiveNumber(adapter, path, root, "fps", diagnostics, false);
  const durationInFrames = readPositiveInteger(adapter, path, root, "duration-in-frames", diagnostics, false);

  if (!hasDuration && hasFps) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        '"duration-in-frames" is required when "fps" is declared on <fy-composition>.',
        attributeDetails(adapter, path, root, "fps"),
      ),
    );
  }

  const hasWidth = getAttribute(adapter, root, "width") !== undefined;
  const hasHeight = getAttribute(adapter, root, "height") !== undefined;
  let paired = true;
  if (hasWidth !== hasHeight) {
    paired = false;
    diagnostics.push(
      createDiagnostic(
        "error",
        "COMPOSITION_INVALID",
        '"width" and "height" must be declared together on <fy-composition>.',
        attributeDetails(adapter, path, root, hasWidth ? "width" : "height"),
      ),
    );
  }

  const isStatic = !hasDuration && !hasFps;
  const usable = isStatic || durationInFrames !== null;
  return {
    metadata:
      paired && usable && diagnostics.length === 0
        ? { format: { width, height, fps }, durationInFrames: isStatic ? null : durationInFrames }
        : null,
    diagnostics,
  };
}

function readDefaultProps<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  rootScope: CompositionRootScope,
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
  } else if (rootScope === "fragment" && block.ancestors.length > 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_INVALID",
        'The data-fy="props" block must be a top-level element in the composition fragment.',
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

function readPropsSchema<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  rootScope: CompositionRootScope,
): { propsSchema: PropsSchema | null; diagnostics: CompositionDiagnostic[] } {
  const diagnostics: CompositionDiagnostic[] = [];
  const blocks = findElements(
    adapter,
    (node) =>
      adapter.tagName(node) === "script" &&
      getAttribute(adapter, node, "type")?.toLowerCase() === "application/json" &&
      getAttribute(adapter, node, "data-fy") === "props-schema",
  );

  for (const extra of blocks.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_SCHEMA_INVALID_SCHEMA",
        'A composition may contain at most one data-fy="props-schema" block.',
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const block = blocks[0];
  if (!block) {
    return { propsSchema: null, diagnostics };
  }

  if (block.inTemplate) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_SCHEMA_INVALID_SCHEMA",
        'The data-fy="props-schema" block must not be inside a <template>.',
        elementDetails(adapter, path, block.node),
      ),
    );
  } else if (rootScope === "fragment" && block.ancestors.length > 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_SCHEMA_INVALID_SCHEMA",
        'The data-fy="props-schema" block must be a top-level element in the composition fragment.',
        elementDetails(adapter, path, block.node),
      ),
    );
  }

  try {
    const parsed: unknown = JSON.parse(adapter.text(block.node));
    return { propsSchema: parsePropsSchema(parsed), diagnostics };
  } catch (error) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_SCHEMA_INVALID_SCHEMA",
        `Invalid props schema: ${errorMessage(error)}`,
        elementDetails(adapter, path, block.node),
      ),
    );
    return { propsSchema: null, diagnostics };
  }
}

function readController<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  resolvePath: (raw: string) => string,
  rootScope: CompositionRootScope,
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
  } else if (rootScope === "fragment" && block.ancestors.length > 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "The controller block must be a top-level element in the composition fragment.",
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
  const rootScope = options.rootScope ?? "document";
  const rootRead = readRoot(adapter, options.path, rootScope);
  const diagnostics = [...rootRead.diagnostics];

  let metadata: DeclaredCompositionMetadata | null = null;
  if (rootRead.root) {
    const metadataRead = readMetadata(adapter, options.path, rootRead.root);
    metadata = metadataRead.metadata;
    diagnostics.push(...metadataRead.diagnostics);
  }

  const propsRead = readDefaultProps(adapter, options.path, rootScope);
  diagnostics.push(...propsRead.diagnostics);

  const schemaRead = readPropsSchema(adapter, options.path, rootScope);
  diagnostics.push(...schemaRead.diagnostics);

  const controllerRead = readController(adapter, options.path, options.resolvePath, rootScope);
  diagnostics.push(...controllerRead.diagnostics);

  return {
    root: rootRead.root,
    descriptor: {
      metadata,
      defaultProps: propsRead.defaultProps,
      propsSchema: schemaRead.propsSchema,
      controller: controllerRead.controller,
    },
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}
