import type { DocumentAdapter } from "../composition/adapter.js";

/** Adapts a browser document to the shared composition reader. */
export function createDomAdapter(root: Node): DocumentAdapter<Node> {
  return {
    root,
    isElement: (node) => node.nodeType === Node.ELEMENT_NODE,
    tagName: (node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : ""),
    attributes: (node) =>
      node.nodeType === Node.ELEMENT_NODE
        ? Array.from((node as Element).attributes, (attribute) => ({
            name: attribute.name,
            value: attribute.value,
          }))
        : [],
    children: (node) => ("childNodes" in node ? Array.from(node.childNodes) : []),
    templateContent: (node) => (node instanceof HTMLTemplateElement ? Array.from(node.content.childNodes) : undefined),
    text: (node) => node.textContent ?? "",
    location: () => undefined,
  };
}
