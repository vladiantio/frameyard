import type { CompositionDiagnostic, CompositionDiagnosticDetails, DiagnosticSeverity } from "../contracts.js";
import type { FrameyardErrorCode } from "../errors.js";
import type { DocumentAdapter, SourceLocation } from "./adapter.js";

export function createDiagnostic(
  severity: DiagnosticSeverity,
  code: FrameyardErrorCode,
  message: string,
  details: CompositionDiagnosticDetails,
): CompositionDiagnostic {
  return { severity, code, message, details };
}

export function locationDetails(location: SourceLocation | undefined): CompositionDiagnosticDetails {
  if (!location) {
    return {};
  }
  return {
    line: location.startLine,
    column: location.startCol,
    endLine: location.endLine,
    endColumn: location.endCol,
  };
}

export function lineColumn(location: SourceLocation | undefined): { line?: number; column?: number } {
  if (!location) {
    return {};
  }
  return { line: location.startLine, column: location.startCol };
}

export function elementDetails<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  node: Node,
  extra: CompositionDiagnosticDetails = {},
): CompositionDiagnosticDetails {
  return {
    path,
    element: adapter.tagName(node),
    ...locationDetails(adapter.location(node)),
    ...extra,
  };
}

export function attributeDetails<Node>(
  adapter: DocumentAdapter<Node>,
  path: string,
  node: Node,
  attribute: string,
  extra: CompositionDiagnosticDetails = {},
): CompositionDiagnosticDetails {
  return {
    path,
    element: adapter.tagName(node),
    attribute,
    ...locationDetails(adapter.location(node, attribute) ?? adapter.location(node)),
    ...extra,
  };
}
