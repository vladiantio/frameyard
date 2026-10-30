import { defaultTreeAdapter, html, parse, serialize } from "parse5";
import { getElementByTagName, type HtmlElement } from "../html/parse.js";

export const FRAMEWORK_IMPORT_MAP = {
  frameyard: "/__frameyard/framework/index.js",
  "frameyard/runtime": "/__frameyard/framework/runtime/index.js",
} as const;

export const COMPOSITION_HOST_SCRIPT_URL = "/__frameyard/framework/runtime/host.js";

export const COMPOSITION_HOST_STYLE =
  "html, body { margin: 0; width: 100%; height: 100%; } fy-composition { display: block; width: 100%; height: 100%; } fy-composition[data-fy-pending] { visibility: hidden !important; }";

export interface CompositionHostInjectionOptions {
  html: string;
  importMap?: Record<string, string>;
  hostScriptUrl?: string;
  styleText?: string;
}

/**
 * Injects the framework import map, sizing style, and composition host into a
 * composition document. The host script is a deferred module, so it runs after
 * the document is parsed; author executable scripts are rejected by static
 * validation before this function is called.
 */
export function injectCompositionHost(options: CompositionHostInjectionOptions): string {
  const document = parse(options.html);
  const head = getElementByTagName(document, "head");
  if (!head) {
    throw new Error("Composition document has no <head> element.");
  }

  const importMap = createElement("script", [
    { name: "type", value: "importmap" },
    { name: "data-fy-host", value: "" },
  ]);
  appendText(importMap, JSON.stringify({ imports: options.importMap ?? FRAMEWORK_IMPORT_MAP }));

  const style = createElement("style", [{ name: "data-fy-host-style", value: "" }]);
  appendText(style, options.styleText ?? COMPOSITION_HOST_STYLE);

  const host = createElement("script", [
    { name: "type", value: "module" },
    { name: "src", value: options.hostScriptUrl ?? COMPOSITION_HOST_SCRIPT_URL },
    { name: "data-fy-host", value: "" },
  ]);

  head.childNodes.unshift(importMap, style, host);
  for (const child of [importMap, style, host]) {
    child.parentNode = head;
  }

  return serialize(document);
}

function createElement(tagName: string, attrs: Array<{ name: string; value: string }>): HtmlElement {
  return defaultTreeAdapter.createElement(tagName, html.NS.HTML, attrs);
}

function appendText(element: HtmlElement, value: string): void {
  defaultTreeAdapter.appendChild(element, defaultTreeAdapter.createTextNode(value));
}
