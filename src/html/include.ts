import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultTreeAdapter, serialize } from "parse5";
import { type CompositionDiagnostic, type CompositionDiagnosticDetails } from "../contracts.js";
import { parseIncludeProps, readPartialDescriptor } from "../composition/partial.js";
import { createDiagnostic, attributeDetails, elementDetails } from "../composition/diagnostics.js";
import { getAttribute } from "../composition/walk.js";
import { createParse5Adapter } from "./document-adapter.js";
import {
  findElements,
  getDocumentDoctype,
  getElementLocation,
  isElement,
  isTemplate,
  parseHtml,
  parseHtmlFragment,
  walk,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  type HtmlRoot,
} from "./parse.js";

const MAX_INCLUDE_DEPTH = 32;
const BINDING_ATTRIBUTES = ["data-fy-text", "data-fy-if", "data-fy-repeat"] as const;
const BINDING_PREFIXES = ["data-fy-attr-", "data-fy-class-"] as const;

export interface ExpandCompositionIncludesOptions {
  projectRoot: string;
  /** Project-relative entry path. */
  entry: string;
  /** Parsed entry fragment. */
  fragment: HtmlRoot;
}

export interface ExpandedComposition {
  fragment: HtmlRoot;
  /** Serialized expanded fragment, ready for the document shell. */
  expandedFragment: string;
  /** Source path for every expanded node; the entry path is the default. */
  origins: WeakMap<HtmlNode, string>;
  diagnostics: CompositionDiagnostic[];
}

interface ExpandedInclude {
  root: HtmlElement;
  targetPath: string;
}

type ContainerKind = "composition" | "partial";

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function setAttribute(element: HtmlElement, name: string, value: string): void {
  const existing = element.attrs.find((attribute) => attribute.name === name);
  if (existing) {
    existing.value = value;
    return;
  }
  element.attrs.push({ name, value });
}

function isBindingElement(element: HtmlElement): boolean {
  return element.attrs.some(
    (attribute) =>
      (BINDING_ATTRIBUTES as readonly string[]).includes(attribute.name) ||
      BINDING_PREFIXES.some((prefix) => attribute.name.startsWith(prefix)),
  );
}

function replaceNode(parent: HtmlNode, oldNode: HtmlNode, newNode: HtmlNode): void {
  if (!("childNodes" in parent)) {
    return;
  }
  const index = parent.childNodes.indexOf(oldNode as never);
  if (index === -1) {
    return;
  }
  parent.childNodes[index] = newNode as never;
  (newNode as { parentNode?: HtmlNode | null }).parentNode = parent;
  (oldNode as { parentNode?: HtmlNode | null }).parentNode = null;
}

function removeNode(parent: HtmlNode, node: HtmlNode): void {
  if (!("childNodes" in parent)) {
    return;
  }
  const index = parent.childNodes.indexOf(node as never);
  if (index !== -1) {
    parent.childNodes.splice(index, 1);
  }
  (node as { parentNode?: HtmlNode | null }).parentNode = null;
}

function isNonWhitespaceText(node: HtmlNode, text: string): boolean {
  return !isElement(node) && node.nodeName === "#text" && text.trim().length > 0;
}

function findUnsupportedAtRule(css: string): string | undefined {
  let cleaned = "";
  let comment = false;
  let quote: string | null = null;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index] as string;
    const next = css[index + 1];
    if (comment) {
      if (character === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    cleaned += character;
  }
  const match = /@(font-face|property|import|namespace|charset)\b/i.exec(cleaned);
  return match?.[1]?.toLowerCase();
}

function styleDetails(
  adapter: ReturnType<typeof createParse5Adapter>,
  pathName: string,
  element: HtmlElement,
  includeChain: string[],
): CompositionDiagnosticDetails {
  return {
    ...elementDetails(adapter, pathName, element),
    includeChain,
  };
}

function detectPartialShell(document: HtmlDocument, pathName: string, includeChain: string[]): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = [];
  const doctype = getDocumentDoctype(document);
  if (doctype) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "INCLUDE_INVALID",
        "Partial files are fragments; remove the <!doctype html> declaration.",
        {
          path: pathName,
          element: "!doctype",
          ...(doctype.sourceCodeLocation
            ? {
                line: doctype.sourceCodeLocation.startLine,
                column: doctype.sourceCodeLocation.startCol,
                endLine: doctype.sourceCodeLocation.endLine,
                endColumn: doctype.sourceCodeLocation.endCol,
              }
            : {}),
          includeChain,
        },
      ),
    );
  }

  for (const tag of ["html", "head", "body", "title", "meta"] as const) {
    const explicit = findElements(
      document,
      (element) => element.tagName === tag && element.sourceCodeLocation?.startTag !== undefined,
    )[0];
    if (!explicit) {
      continue;
    }
    const location = getElementLocation(explicit);
    diagnostics.push(
      createDiagnostic("error", "INCLUDE_INVALID", `Partial files are fragments; remove the <${tag}> element.`, {
        path: pathName,
        element: tag,
        ...(location
          ? {
              line: location.startLine,
              column: location.startCol,
              endLine: location.endLine,
              endColumn: location.endCol,
            }
          : {}),
        includeChain,
      }),
    );
  }

  return diagnostics;
}

/**
 * Expands every `<fy-include>` in an entry fragment into a `<fy-partial>` root.
 * The resolver is Node-only; the browser host receives the expanded document.
 */
/** Reads an inline controller from a partial file for the preview server route. */
export async function readInlinePartialController(options: {
  projectRoot: string;
  entry: string;
}): Promise<string | null> {
  const projectRoot = path.resolve(options.projectRoot);
  const entry = normalizeRelative(options.entry);
  const absolute = path.resolve(projectRoot, entry);
  if (absolute !== projectRoot && !absolute.startsWith(projectRoot + path.sep)) {
    return null;
  }
  if (path.extname(absolute).toLowerCase() !== ".html") {
    return null;
  }

  let html: string;
  try {
    html = await readFile(absolute, "utf8");
  } catch {
    return null;
  }

  let fragment: HtmlRoot;
  try {
    fragment = parseHtmlFragment(html);
  } catch {
    return null;
  }

  const roots = findElements(fragment, (element) => element.tagName === "fy-partial");
  if (roots.length !== 1) {
    return null;
  }
  const root = roots[0] as HtmlElement;
  if (!fragment.childNodes.includes(root)) {
    return null;
  }

  const read = readPartialDescriptor(createParse5Adapter(root), {
    path: entry,
    root,
    resolvePath: (raw) => {
      const resolved = path.resolve(path.dirname(absolute), raw);
      if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
        throw new Error(`Controller path escapes the project root: "${raw}".`);
      }
      return path.relative(projectRoot, resolved).split(path.sep).join("/");
    },
  });
  const controller = read.descriptor.controller;
  return controller?.kind === "inline" && controller.source !== undefined ? controller.source : null;
}

export async function expandCompositionIncludes(
  options: ExpandCompositionIncludesOptions,
): Promise<ExpandedComposition> {
  const projectRoot = path.resolve(options.projectRoot);
  const entry = normalizeRelative(options.entry);
  const adapter = createParse5Adapter(options.fragment);
  const origins = new WeakMap<HtmlNode, string>();
  const diagnostics: CompositionDiagnostic[] = [];
  const fileCache = new Map<string, string>();
  let scopeCounter = 0;

  const readPartialFile = async (absolute: string): Promise<string> => {
    const cached = fileCache.get(absolute);
    if (cached !== undefined) {
      return cached;
    }
    const html = await readFile(absolute, "utf8");
    fileCache.set(absolute, html);
    return html;
  };

  const resolveIncludePath = (
    raw: string,
    parentPath: string,
  ): { ok: true; absolute: string; relative: string } | { ok: false; message: string; suggestion?: string } => {
    if (raw.length === 0) {
      return { ok: false, message: "<fy-include> requires a src attribute." };
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//")) {
      return {
        ok: false,
        message: `Include src must be a local file path, not a URL: "${raw}".`,
        suggestion: "Use a project path such as ./partials/card.html.",
      };
    }
    if (raw.includes("?") || raw.includes("#")) {
      return {
        ok: false,
        message: `Include src cannot contain a query string or fragment: "${raw}".`,
        suggestion: "Remove the query or fragment from src.",
      };
    }
    const normalized = raw.replaceAll("\\", "/");
    const base = normalized.startsWith("/") ? projectRoot : path.dirname(path.resolve(projectRoot, parentPath));
    const absolute = path.resolve(base, normalized.startsWith("/") ? `.${normalized}` : normalized);
    if (absolute !== projectRoot && !absolute.startsWith(projectRoot + path.sep)) {
      return {
        ok: false,
        message: `Include path escapes the project root: "${raw}".`,
        suggestion: "Keep the include inside the project root.",
      };
    }
    if (path.extname(absolute).toLowerCase() !== ".html") {
      return {
        ok: false,
        message: `Include src must point to a .html file: "${raw}".`,
        suggestion: "Use a partial with a .html extension.",
      };
    }
    return {
      ok: true,
      absolute,
      relative: path.relative(projectRoot, absolute).split(path.sep).join("/"),
    };
  };

  const expandInclude = async (
    element: HtmlElement,
    stack: string[],
    chain: string[],
    ancestors: readonly HtmlNode[],
    container: ContainerKind,
  ): Promise<ExpandedInclude | null> => {
    const parentPath = stack[stack.length - 1] ?? entry;
    const placement = ancestors.some((ancestor) =>
      ["template", "fy-transcript", "fy-include"].includes(adapter.tagName(ancestor)),
    );
    const insideContainer = ancestors.some(
      (ancestor) => adapter.tagName(ancestor) === (container === "composition" ? "fy-composition" : "fy-partial"),
    );
    if (placement || !insideContainer) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          "Includes must be inside the rendered content of a composition or partial and cannot be inside <template>, <fy-transcript>, or another include.",
          {
            ...attributeDetails(adapter, parentPath, element, "src", {
              includeChain: [...chain],
            }),
          },
        ),
      );
      return null;
    }

    const children = adapter.children(element);
    if (children.some((child) => adapter.isElement(child) || isNonWhitespaceText(child, adapter.text(child)))) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          "<fy-include> must be empty; move fallback or nested content into the partial.",
          {
            ...elementDetails(adapter, parentPath, element, {
              includeChain: [...chain],
            }),
          },
        ),
      );
      return null;
    }

    const rawSrc = getAttribute(adapter, element, "src");
    if (rawSrc === undefined || rawSrc.trim().length === 0) {
      diagnostics.push(
        createDiagnostic("error", "INCLUDE_INVALID", "<fy-include> requires a src attribute.", {
          ...attributeDetails(adapter, parentPath, element, "src", {
            includeChain: [...chain],
          }),
        }),
      );
      return null;
    }

    const resolved = resolveIncludePath(rawSrc.trim(), parentPath);
    if (!resolved.ok) {
      diagnostics.push(
        createDiagnostic("error", "INCLUDE_INVALID", resolved.message, {
          ...attributeDetails(adapter, parentPath, element, "src", {
            value: rawSrc,
            includeChain: [...chain],
            ...(resolved.suggestion !== undefined ? { suggestion: resolved.suggestion } : {}),
          }),
        }),
      );
      return null;
    }

    const targetChain = [...chain, resolved.relative];
    if (stack.length >= MAX_INCLUDE_DEPTH) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_DEPTH_EXCEEDED",
          `Include chain exceeds ${MAX_INCLUDE_DEPTH} files: ${targetChain.join(" → ")}.`,
          {
            ...attributeDetails(adapter, parentPath, element, "src", {
              value: rawSrc,
              includeChain: targetChain,
            }),
          },
        ),
      );
      return null;
    }
    if (stack.includes(resolved.relative)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_CYCLE",
          `Include cycle detected: ${[...stack, resolved.relative].join(" → ")}.`,
          {
            ...attributeDetails(adapter, parentPath, element, "src", {
              value: rawSrc,
              includeChain: targetChain,
            }),
          },
        ),
      );
      return null;
    }

    let html: string;
    try {
      html = await readPartialFile(resolved.absolute);
    } catch {
      diagnostics.push(
        createDiagnostic("error", "INCLUDE_NOT_FOUND", `Included partial does not exist: "${resolved.relative}".`, {
          ...attributeDetails(adapter, parentPath, element, "src", {
            value: rawSrc,
            includeChain: targetChain,
          }),
        }),
      );
      return null;
    }

    let document: HtmlDocument;
    let fragment: HtmlRoot;
    try {
      document = parseHtml(html);
      fragment = parseHtmlFragment(html);
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          `Could not parse included partial "${resolved.relative}": ${error instanceof Error ? error.message : String(error)}`,
          {
            path: resolved.relative,
            includeChain: targetChain,
          },
        ),
      );
      return null;
    }

    const shellDiagnostics = detectPartialShell(document, resolved.relative, targetChain);
    if (shellDiagnostics.length > 0) {
      diagnostics.push(...shellDiagnostics);
      return null;
    }

    const partialRoots = findElements(fragment, (candidate) => candidate.tagName === "fy-partial");
    if (partialRoots.length !== 1) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          partialRoots.length === 0
            ? `Included partial "${resolved.relative}" must contain one <fy-partial> root.`
            : `Included partial "${resolved.relative}" must contain exactly one <fy-partial> root.`,
          {
            path: resolved.relative,
            includeChain: targetChain,
          },
        ),
      );
      return null;
    }

    const root = partialRoots[0] as HtmlElement;
    if (!fragment.childNodes.includes(root)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          `The <fy-partial> root in "${resolved.relative}" must be a top-level element.`,
          {
            ...elementDetails(createParse5Adapter(fragment), resolved.relative, root, {
              includeChain: targetChain,
            }),
          },
        ),
      );
      return null;
    }

    const outside = fragment.childNodes.filter(
      (node) => node !== root && (adapter.isElement(node) || isNonWhitespaceText(node, adapter.text(node))),
    );
    if (outside.length > 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          `Included partial "${resolved.relative}" must contain only one <fy-partial> root.`,
          {
            path: resolved.relative,
            includeChain: targetChain,
          },
        ),
      );
      return null;
    }

    const rootAdapter = createParse5Adapter(root);
    if (root.attrs.length > 0) {
      for (const attribute of root.attrs) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "INCLUDE_INVALID",
            `The <fy-partial> root cannot declare attributes; put host attributes on <fy-include>.`,
            {
              ...attributeDetails(rootAdapter, resolved.relative, root, attribute.name, {
                value: attribute.value,
                includeChain: targetChain,
              }),
            },
          ),
        );
      }
    }

    const descriptor = readPartialDescriptor(rootAdapter, {
      path: resolved.relative,
      root,
      resolvePath: (raw) => {
        const absolute = path.resolve(path.dirname(path.resolve(projectRoot, resolved.relative)), raw);
        if (absolute !== projectRoot && !absolute.startsWith(projectRoot + path.sep)) {
          throw new Error(`Controller path escapes the project root: "${raw}".`);
        }
        return path.relative(projectRoot, absolute).split(path.sep).join("/");
      },
    });
    for (const diagnostic of descriptor.diagnostics) {
      diagnostic.details = {
        ...diagnostic.details,
        includeChain: targetChain,
      };
      diagnostics.push(diagnostic);
    }

    const partialController = descriptor.descriptor.controller;
    if (partialController?.kind === "external" && partialController.src !== undefined) {
      const controllerScript = rootAdapter
        .children(root)
        .find(
          (child) =>
            isElement(child) &&
            rootAdapter.tagName(child) === "script" &&
            getAttribute(rootAdapter, child, "type")?.toLowerCase() === "text/fy-controller",
        );
      if (controllerScript !== undefined && isElement(controllerScript)) {
        setAttribute(controllerScript, "data-fy-controller-path", partialController.src);
      }

      try {
        const controllerStat = await stat(path.resolve(projectRoot, partialController.src));
        if (!controllerStat.isFile()) {
          throw new Error("not a file");
        }
      } catch {
        diagnostics.push(
          createDiagnostic(
            "error",
            "CONTROLLER_INVALID",
            `Included controller file does not exist: "${partialController.src}".`,
            {
              path: resolved.relative,
              includeChain: targetChain,
              ...(partialController.line !== undefined ? { line: partialController.line } : {}),
              ...(partialController.column !== undefined ? { column: partialController.column } : {}),
              ...(partialController.rawSrc !== undefined ? { value: partialController.rawSrc } : {}),
            },
          ),
        );
      }
    }

    const rawProps = getAttribute(adapter, element, "props");
    const parsedProps = parseIncludeProps(rawProps);
    if (!parsedProps.ok) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "PROPS_INVALID",
          `Invalid include props: ${parsedProps.error ?? "props must be a JSON object."}`,
          {
            ...attributeDetails(adapter, parentPath, element, "props", {
              value: rawProps,
              includeChain: targetChain,
            }),
          },
        ),
      );
    }

    for (const attribute of adapter.attributes(element)) {
      if (attribute.name === "src" || attribute.name === "props") {
        continue;
      }
      if (attribute.name.startsWith("data-fy-")) {
        diagnostics.push(
          createDiagnostic("error", "INCLUDE_INVALID", `"${attribute.name}" is reserved on <fy-include>.`, {
            ...attributeDetails(adapter, parentPath, element, attribute.name, {
              value: attribute.value,
              includeChain: targetChain,
            }),
          }),
        );
        continue;
      }
      if (
        attribute.name === "class" ||
        attribute.name === "style" ||
        attribute.name === "id" ||
        attribute.name.startsWith("data-")
      ) {
        setAttribute(root, attribute.name, attribute.value);
        continue;
      }
      diagnostics.push(
        createDiagnostic(
          "error",
          "INCLUDE_INVALID",
          `Unsupported attribute "${attribute.name}" on <fy-include>; use class, style, id, or data-*.`,
          {
            ...attributeDetails(adapter, parentPath, element, attribute.name, {
              value: attribute.value,
              includeChain: targetChain,
            }),
          },
        ),
      );
    }

    scopeCounter += 1;
    const scopeId = `include-${scopeCounter}`;
    setAttribute(root, "data-fy-include", scopeId);
    setAttribute(root, "data-fy-include-src", resolved.relative);
    if (rawProps !== undefined) {
      setAttribute(root, "data-fy-props", JSON.stringify(parsedProps.value));
    }

    walk(root, (node) => {
      origins.set(node, resolved.relative);
      if (!isElement(node) || !isBindingElement(node)) {
        return;
      }
      const line = getElementLocation(node)?.startLine;
      if (line !== undefined) {
        setAttribute(node, "data-fy-source-line", String(line));
      }
    });

    for (const child of rootAdapter.children(root)) {
      if (!isElement(child) || child.tagName !== "style") {
        continue;
      }
      const css = rootAdapter.text(child);
      const unsupported = findUnsupportedAtRule(css);
      if (unsupported !== undefined) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "INCLUDE_INVALID",
            `@${unsupported} is not allowed in an included partial; keep global at-rules in the composition.`,
            styleDetails(rootAdapter, resolved.relative, child, targetChain),
          ),
        );
      }
      const wrapped = `@scope ([data-fy-include="${scopeId}"]) to ([data-fy-include]) {\n${css}\n}`;
      const text = defaultTreeAdapter.createTextNode(wrapped);
      (text as { parentNode?: HtmlNode | null }).parentNode = child;
      child.childNodes = [text as never];
    }

    return { root, targetPath: resolved.relative };
  };

  const expandChildren = async (
    parent: HtmlNode,
    stack: string[],
    chain: string[],
    ancestors: readonly HtmlNode[],
    container: ContainerKind,
  ): Promise<void> => {
    for (const child of Array.from(adapter.children(parent))) {
      if (!isElement(child)) {
        continue;
      }
      if (child.tagName === "fy-include") {
        const expanded = await expandInclude(child, stack, chain, ancestors, container);
        if (expanded === null) {
          removeNode(parent, child);
          continue;
        }
        replaceNode(parent, child, expanded.root);
        await expandChildren(
          expanded.root,
          [...stack, expanded.targetPath],
          [...chain, expanded.targetPath],
          [...ancestors, expanded.root],
          "partial",
        );
        continue;
      }
      if (isTemplate(child)) {
        const content = defaultTreeAdapter.getTemplateContent(child);
        await expandChildren(content, stack, chain, [...ancestors, child], container);
        continue;
      }
      await expandChildren(child, stack, chain, [...ancestors, child], container);
    }
  };

  await expandChildren(options.fragment, [entry], [entry], [], "composition");

  return {
    fragment: options.fragment,
    expandedFragment: serialize(options.fragment),
    origins,
    diagnostics,
  };
}
