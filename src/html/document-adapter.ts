import type { DocumentAdapter } from "../composition/adapter.js";
import {
  getAttributeLocation,
  getElementLocation,
  getNodeLocation,
  getTextContent,
  isElement,
  isTemplate,
  type HtmlNode,
  type HtmlRoot,
} from "./parse.js";

/** Adapts a parse5 document, fragment, or element subtree to the shared composition reader. */
export function createParse5Adapter(root: HtmlRoot | HtmlNode): DocumentAdapter<HtmlNode> {
  return {
    root,
    isElement,
    tagName: (node) => (isElement(node) ? node.tagName : ""),
    attributes: (node) => (isElement(node) ? node.attrs.map(({ name, value }) => ({ name, value })) : []),
    children: (node) => ("childNodes" in node ? node.childNodes : []),
    templateContent: (node) => (isTemplate(node) ? node.content.childNodes : undefined),
    text: (node) => getTextContent(node),
    location: (node, attribute) =>
      attribute !== undefined && isElement(node)
        ? (getAttributeLocation(node, attribute) ?? getElementLocation(node))
        : getNodeLocation(node),
  };
}
