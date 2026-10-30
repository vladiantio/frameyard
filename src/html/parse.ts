import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { SourceLocation } from "../composition/adapter.js";

export type { SourceLocation } from "../composition/adapter.js";

export type HtmlDocument = DefaultTreeAdapterTypes.Document;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlTemplate = DefaultTreeAdapterTypes.Template;
export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlParentNode = DefaultTreeAdapterTypes.ParentNode;
export type HtmlTextNode = DefaultTreeAdapterTypes.TextNode;
export type HtmlDocumentType = DefaultTreeAdapterTypes.DocumentType;

export function parseHtml(html: string): HtmlDocument {
  return parse(html, { sourceCodeLocationInfo: true });
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

export function isTemplate(node: HtmlNode): node is HtmlTemplate {
  return isElement(node) && node.tagName === "template" && "content" in node;
}

export function isTextNode(node: HtmlNode): node is HtmlTextNode {
  return node.nodeName === "#text";
}

export function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

export function hasAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attribute) => attribute.name === name);
}

export function getAttributeLocation(element: HtmlElement, name: string): SourceLocation | undefined {
  return element.sourceCodeLocation?.attrs?.[name] ?? undefined;
}

export function getElementLocation(element: HtmlElement): SourceLocation | undefined {
  return element.sourceCodeLocation ?? undefined;
}

export function getNodeLocation(node: HtmlNode): SourceLocation | undefined {
  return node.sourceCodeLocation ?? undefined;
}

export function getTextContent(node: HtmlNode): string {
  if (isTextNode(node)) {
    return node.value;
  }
  if (isTemplate(node)) {
    return node.content.childNodes.map((child) => getTextContent(child)).join("");
  }
  if (isElement(node)) {
    return node.childNodes.map((child) => getTextContent(child)).join("");
  }
  return "";
}

export function walk(node: HtmlNode, visit: (node: HtmlNode) => void): void {
  visit(node);
  if (isTemplate(node)) {
    for (const child of node.content.childNodes) {
      walk(child, visit);
    }
    return;
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      walk(child, visit);
    }
  }
}

export function findElements(document: HtmlDocument, predicate: (element: HtmlElement) => boolean): HtmlElement[] {
  const elements: HtmlElement[] = [];
  walk(document, (node) => {
    if (isElement(node) && predicate(node)) {
      elements.push(node);
    }
  });
  return elements;
}

export function getDocumentDoctype(document: HtmlDocument): HtmlDocumentType | undefined {
  return document.childNodes.find((node): node is HtmlDocumentType => node.nodeName === "#documentType");
}

export function getElementByTagName(document: HtmlDocument, tagName: string): HtmlElement | undefined {
  return findElements(document, (element) => element.tagName === tagName)[0];
}

export function isDescendantOf(node: HtmlNode, ancestor: HtmlElement): boolean {
  let current: HtmlParentNode | null = "parentNode" in node ? node.parentNode : null;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = "parentNode" in current ? current.parentNode : null;
  }
  return false;
}
