import {
  assertJsonSerializable,
  isPlainObject,
  mergeProps,
  type CompositionDiagnostic,
  type Props,
  type PropsSchema,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import {
  applyPropsSchemaDefaults,
  parsePropsSchema,
  validatePropsAgainstSchema,
  type PropsSchemaIssue,
} from "../props-schema.js";
import type { DocumentAdapter } from "./adapter.js";
import { createDiagnostic, elementDetails } from "./diagnostics.js";
import { getAttribute } from "./walk.js";

export interface PartialDescriptor {
  defaultProps: Readonly<Props>;
  propsSchema: PropsSchema | null;
}

export interface PartialDescriptorResult<Node> {
  root: Node;
  descriptor: PartialDescriptor;
  valid: boolean;
  diagnostics: CompositionDiagnostic[];
}

export interface ReadPartialDescriptorOptions<Node> {
  /** Project-relative path to the partial source, used in diagnostics. */
  path: string;
  /** The `<fy-partial>` root. The adapter may be rooted at this node. */
  root: Node;
}

export interface ParsedIncludeProps {
  ok: boolean;
  value: Readonly<Props>;
  error?: string;
}

export interface ResolvedPartialProps {
  props: Readonly<Props>;
  issues: PropsSchemaIssue[];
}

interface Collected<Node> {
  node: Node;
  parent: Node;
  inTemplate: boolean;
}

function isPropsBlock<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  return (
    adapter.tagName(node) === "script" &&
    getAttribute(adapter, node, "type")?.toLowerCase() === "application/json" &&
    getAttribute(adapter, node, "data-fy") === "props"
  );
}

function isSchemaBlock<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  return (
    adapter.tagName(node) === "script" &&
    getAttribute(adapter, node, "type")?.toLowerCase() === "application/json" &&
    getAttribute(adapter, node, "data-fy") === "props-schema"
  );
}

function isControllerBlock<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  return (
    adapter.tagName(node) === "script" && getAttribute(adapter, node, "type")?.toLowerCase() === "text/fy-controller"
  );
}

function isImportMap<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  return adapter.tagName(node) === "script" && getAttribute(adapter, node, "type")?.toLowerCase() === "importmap";
}

function isStyleSheetLink<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  if (adapter.tagName(node) !== "link") {
    return false;
  }
  const rel = getAttribute(adapter, node, "rel")?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return rel.includes("stylesheet");
}

function isExpandedPartial<Node>(adapter: DocumentAdapter<Node>, node: Node): boolean {
  return adapter.tagName(node) === "fy-partial" && getAttribute(adapter, node, "data-fy-include") !== undefined;
}

function collectElements<Node>(adapter: DocumentAdapter<Node>, root: Node): Collected<Node>[] {
  const collected: Collected<Node>[] = [];
  const visit = (parent: Node, inTemplate: boolean): void => {
    for (const child of adapter.children(parent)) {
      if (!adapter.isElement(child)) {
        continue;
      }
      collected.push({ node: child, parent, inTemplate });
      // An expanded nested include is its own partial scope. Its own reader
      // validates it; the outer partial must not inspect its blocks or styles.
      if (isExpandedPartial(adapter, child)) {
        continue;
      }
      // An authored nested <fy-partial> is invalid. Report the element and
      // stop descending to avoid cascading diagnostics from its contents.
      if (adapter.tagName(child) === "fy-partial") {
        continue;
      }
      if (adapter.tagName(child) === "template") {
        for (const content of adapter.templateContent(child) ?? []) {
          visit(content, true);
        }
        continue;
      }
      visit(child, inTemplate);
    }
  };
  visit(root, false);
  return collected;
}

function readPropsBlock<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  block: Node,
  diagnostics: CompositionDiagnostic[],
): Readonly<Props> {
  try {
    const parsed: unknown = JSON.parse(adapter.text(block));
    if (!isPlainObject(parsed)) {
      throw new Error('The data-fy="props" block must contain a JSON object.');
    }
    assertJsonSerializable(parsed, "defaultProps");
    return mergeProps(parsed as Props, undefined);
  } catch (error) {
    diagnostics.push(
      createDiagnostic("error", "PROPS_INVALID", `Invalid partial default props: ${errorMessage(error)}`, {
        ...elementDetails(adapter, path, block),
      }),
    );
    return Object.freeze({}) as Readonly<Props>;
  }
}

function readSchemaBlock<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  block: Node,
  diagnostics: CompositionDiagnostic[],
): PropsSchema | null {
  try {
    return parsePropsSchema(JSON.parse(adapter.text(block)));
  } catch (error) {
    diagnostics.push(
      createDiagnostic("error", "PROPS_SCHEMA_INVALID_SCHEMA", `Invalid partial props schema: ${errorMessage(error)}`, {
        ...elementDetails(adapter, path, block),
      }),
    );
    return null;
  }
}

/**
 * Reads the fixed facts of a `<fy-partial>`: its direct props and schema
 * blocks, and the shape restrictions around them. The adapter may be rooted at
 * the partial itself; source and expanded partials share this reader.
 *
 * Controllers are parsed as an invalid declaration until the controller slice
 * lands: static includes must reject them rather than silently ignore them.
 */
export function readPartialDescriptor<Node>(
  adapter: DocumentAdapter<Node>,
  options: ReadPartialDescriptorOptions<Node>,
): PartialDescriptorResult<Node> {
  const path = options.path.replaceAll("\\", "/");
  const root = options.root;
  const diagnostics: CompositionDiagnostic[] = [];
  const collected = collectElements(adapter, root);

  const checkNested = (
    match: Collected<Node>,
    message: string,
    code: "PROPS_INVALID" | "PROPS_SCHEMA_INVALID_SCHEMA",
  ) => {
    if (match.parent !== root || match.inTemplate) {
      diagnostics.push(createDiagnostic("error", code, message, elementDetails(adapter, path, match.node)));
    }
  };

  const propsBlocks = collected.filter((match) => isPropsBlock(adapter, match.node));
  for (const match of propsBlocks) {
    checkNested(match, 'The data-fy="props" block must be a direct child of <fy-partial>.', "PROPS_INVALID");
  }
  const directProps = propsBlocks.filter((match) => match.parent === root && !match.inTemplate);
  for (const extra of directProps.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_INVALID",
        'A partial may contain at most one data-fy="props" block.',
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const schemaBlocks = collected.filter((match) => isSchemaBlock(adapter, match.node));
  for (const match of schemaBlocks) {
    checkNested(
      match,
      'The data-fy="props-schema" block must be a direct child of <fy-partial>.',
      "PROPS_SCHEMA_INVALID_SCHEMA",
    );
  }
  const directSchemas = schemaBlocks.filter((match) => match.parent === root && !match.inTemplate);
  for (const extra of directSchemas.slice(1)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "PROPS_SCHEMA_INVALID_SCHEMA",
        'A partial may contain at most one data-fy="props-schema" block.',
        elementDetails(adapter, path, extra.node),
      ),
    );
  }

  const defaultProps =
    directProps[0] === undefined
      ? (Object.freeze({}) as Readonly<Props>)
      : readPropsBlock(adapter, path, directProps[0].node, diagnostics);
  const propsSchema =
    directSchemas[0] === undefined ? null : readSchemaBlock(adapter, path, directSchemas[0].node, diagnostics);

  for (const match of collected.filter((candidate) => adapter.tagName(candidate.node) === "fy-partial")) {
    if (isExpandedPartial(adapter, match.node)) {
      continue;
    }
    diagnostics.push(
      createDiagnostic(
        "error",
        "INCLUDE_INVALID",
        "A partial cannot contain another <fy-partial>; use <fy-include> instead.",
        elementDetails(adapter, path, match.node),
      ),
    );
  }

  for (const match of collected.filter((candidate) => adapter.tagName(candidate.node) === "fy-composition")) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "INCLUDE_INVALID",
        "A partial cannot contain <fy-composition>; include a partial or make the content a composition.",
        elementDetails(adapter, path, match.node),
      ),
    );
  }

  for (const match of collected.filter((candidate) => isControllerBlock(adapter, candidate.node))) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "CONTROLLER_INVALID",
        "Controllers in included partials are not supported yet; remove the controller or inline the partial.",
        elementDetails(adapter, path, match.node),
      ),
    );
  }

  for (const match of collected.filter((candidate) => isStyleSheetLink(adapter, candidate.node))) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "INCLUDE_INVALID",
        'Included partials must use inline <style> elements; <link rel="stylesheet"> is not supported.',
        elementDetails(adapter, path, match.node),
      ),
    );
  }

  for (const match of collected.filter((candidate) => isImportMap(adapter, candidate.node))) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "INCLUDE_INVALID",
        "Import maps are not supported inside an included partial; declare the map in the composition.",
        elementDetails(adapter, path, match.node),
      ),
    );
  }

  for (const match of collected.filter((candidate) => adapter.tagName(candidate.node) === "style")) {
    if (match.parent !== root || match.inTemplate) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          "Partial styles must be direct children of <fy-partial>.",
          elementDetails(adapter, path, match.node),
        ),
      );
    }
  }

  return {
    root,
    descriptor: { defaultProps, propsSchema },
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}

/** Parses the literal JSON object carried by `<fy-include props="...">`. */
export function parseIncludeProps(raw: string | undefined): ParsedIncludeProps {
  if (raw === undefined) {
    return { ok: true, value: Object.freeze({}) as Readonly<Props> };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error("props must be a JSON object.");
    }
    assertJsonSerializable(parsed, "props");
    return { ok: true, value: parsed as Readonly<Props> };
  } catch (error) {
    return {
      ok: false,
      value: Object.freeze({}) as Readonly<Props>,
      error: errorMessage(error),
    };
  }
}

/** Applies the partial schema defaults, defaults, and include overrides. */
export function resolvePartialProps(
  descriptor: PartialDescriptor,
  overrides: Readonly<Props> | undefined,
): ResolvedPartialProps {
  let props = mergeProps(descriptor.defaultProps, overrides);
  if (descriptor.propsSchema !== null) {
    props = mergeProps(applyPropsSchemaDefaults(descriptor.propsSchema, props), undefined);
    return { props, issues: validatePropsAgainstSchema(descriptor.propsSchema, props) };
  }
  return { props, issues: [] };
}
