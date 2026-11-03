import { defaultTreeAdapter, html, parse, serialize } from "parse5";
import type { CompositionFormat } from "../contracts.js";
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
 * Injects the framework import map, sizing style, resolved project format, and
 * composition host into a composition document. The host script is a deferred
 * module, so it runs after the document is parsed; author executable scripts
 * are rejected by static validation before this function is called.
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

  const injected: HtmlElement[] = [importMap, style, host];
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
    injected.unshift(format);
  }

  head.childNodes.unshift(...injected);
  for (const child of injected) {
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
