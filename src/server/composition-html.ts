import { defaultTreeAdapter, html, parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import type { CompositionFormat } from "../contracts.js";
import { getAttribute, getElementByTagName, isElement, parseHtmlFragment, type HtmlElement } from "../html/parse.js";

export const FRAMEWORK_IMPORT_MAP = {
  frameyard: "/__frameyard/framework/index.js",
  "frameyard/runtime": "/__frameyard/framework/runtime/index.js",
} as const;

export const COMPOSITION_HOST_SCRIPT_URL = "/__frameyard/framework/runtime/host.js";

export const COMPOSITION_HOST_STYLE =
  "html, body { margin: 0; width: 100%; height: 100%; } fy-composition { display: block; width: 100%; height: 100%; } fy-composition[data-fy-pending] { visibility: hidden !important; }";

export interface RenderCompositionDocumentOptions {
  /** Authoring fragment: body content with one top-level `<fy-composition>`. */
  fragment: string;
  /**
   * Project format the host uses to fill width, height, and fps the
   * composition omits. Absent in projects without a format.
   */
  format?: CompositionFormat | null;
  importMap?: Record<string, string>;
  hostScriptUrl?: string;
  styleText?: string;
}

/**
 * Wraps an authoring fragment in the fixed composition document shell. Top-level
 * import maps and stylesheets are hoisted into `<head>`; the rest of the
 * fragment becomes `<body>` content.
 */
export function renderCompositionDocument(options: RenderCompositionDocumentOptions): string {
  const document = parse(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Frameyard composition</title></head><body></body></html>',
    { sourceCodeLocationInfo: false },
  );
  const head = getElementByTagName(document, "head");
  const body = getElementByTagName(document, "body");
  if (!head || !body) {
    throw new Error("Composition shell is missing <head> or <body>.");
  }

  const fragment = parseHtmlFragment(options.fragment);
  const bodyNodes: DefaultTreeAdapterTypes.ChildNode[] = [];
  const styleNodes: HtmlElement[] = [];
  const importMaps: HtmlElement[] = [];

  for (const node of fragment.childNodes) {
    if (isElement(node)) {
      if (node.tagName === "style") {
        styleNodes.push(node);
        continue;
      }
      if (node.tagName === "link" && isStyleSheetLink(node)) {
        styleNodes.push(node);
        continue;
      }
      if (node.tagName === "script" && getAttribute(node, "type")?.toLowerCase() === "importmap") {
        importMaps.push(node);
        continue;
      }
    }
    bodyNodes.push(node);
  }

  if (options.format) {
    const format = createElement("script", [
      { name: "type", value: "application/json" },
      { name: "data-fy", value: "format" },
      { name: "data-fy-host", value: "" },
    ]);
    appendText(
      format,
      JSON.stringify({
        width: options.format.width,
        height: options.format.height,
        fps: options.format.fps,
      }),
    );
    appendChild(head, format);
  }

  const frameworkImportMap = createElement("script", [
    { name: "type", value: "importmap" },
    { name: "data-fy-host", value: "" },
  ]);
  appendText(frameworkImportMap, JSON.stringify({ imports: options.importMap ?? FRAMEWORK_IMPORT_MAP }));
  appendChild(head, frameworkImportMap);

  for (const importMap of importMaps) {
    appendChild(head, importMap);
  }

  const hostStyle = createElement("style", [{ name: "data-fy-host", value: "" }]);
  appendText(hostStyle, options.styleText ?? COMPOSITION_HOST_STYLE);
  appendChild(head, hostStyle);

  for (const style of styleNodes) {
    appendChild(head, style);
  }

  const host = createElement("script", [
    { name: "type", value: "module" },
    { name: "src", value: options.hostScriptUrl ?? COMPOSITION_HOST_SCRIPT_URL },
    { name: "data-fy-host", value: "" },
  ]);
  appendChild(head, host);

  for (const node of bodyNodes) {
    appendChild(body, node);
  }

  return serialize(document);
}

function isStyleSheetLink(element: HtmlElement): boolean {
  const rel = getAttribute(element, "rel")?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return rel.includes("stylesheet");
}

function createElement(tagName: string, attrs: Array<{ name: string; value: string }>): HtmlElement {
  return defaultTreeAdapter.createElement(tagName, html.NS.HTML, attrs);
}

function appendText(element: HtmlElement, value: string): void {
  defaultTreeAdapter.appendChild(element, defaultTreeAdapter.createTextNode(value));
}

function appendChild(parent: HtmlElement, child: DefaultTreeAdapterTypes.ChildNode): void {
  defaultTreeAdapter.appendChild(parent, child);
}
