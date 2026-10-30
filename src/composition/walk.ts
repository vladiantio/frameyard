import type { DocumentAdapter } from "./adapter.js";

export interface ElementMatch<Node> {
  node: Node;
  inTemplate: boolean;
  ancestors: readonly Node[];
}

export function getAttribute<Node>(adapter: DocumentAdapter<Node>, node: Node, name: string): string | undefined {
  return adapter.attributes(node).find((attribute) => attribute.name === name)?.value;
}

export function hasAttribute<Node>(adapter: DocumentAdapter<Node>, node: Node, name: string): boolean {
  return adapter.attributes(node).some((attribute) => attribute.name === name);
}

export function findElements<Node>(
  adapter: DocumentAdapter<Node>,
  predicate: (node: Node) => boolean,
  includeTemplateContent = true,
): ElementMatch<Node>[] {
  const matches: ElementMatch<Node>[] = [];

  const visit = (node: Node, inTemplate: boolean, ancestors: readonly Node[]): void => {
    if (adapter.isElement(node)) {
      if (predicate(node)) {
        matches.push({ node, inTemplate, ancestors });
      }
      const childAncestors = [...ancestors, node];
      for (const child of adapter.children(node)) {
        visit(child, inTemplate, childAncestors);
      }
      if (includeTemplateContent && adapter.tagName(node) === "template") {
        for (const child of adapter.templateContent(node) ?? []) {
          visit(child, true, childAncestors);
        }
      }
      return;
    }

    for (const child of adapter.children(node)) {
      visit(child, inTemplate, ancestors);
    }
  };

  visit(adapter.root, false, []);
  return matches;
}
