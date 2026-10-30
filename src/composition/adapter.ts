export interface SourceLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface DocumentAttribute {
  name: string;
  value: string;
}

/**
 * A lazy view over an HTML document tree. The composition reader owns the
 * traversal and rules; an adapter supplies the tree primitives for parse5 or
 * the browser DOM.
 */
export interface DocumentAdapter<Node> {
  readonly root: Node;
  isElement(node: Node): boolean;
  /** Lowercase tag name for elements; empty for non-elements. */
  tagName(node: Node): string;
  attributes(node: Node): readonly DocumentAttribute[];
  children(node: Node): readonly Node[];
  /** Template content, or undefined when the node is not a template. */
  templateContent(node: Node): readonly Node[] | undefined;
  /** Text content, including descendants for elements. */
  text(node: Node): string;
  /** Source location when the adapter can supply one. */
  location(node: Node, attribute?: string): SourceLocation | undefined;
}
