import { assertJsonSerializable, isPlainObject, type JsonValue } from "../contracts.js";
import { FrameyardError } from "../errors.js";

/** Variable names accepted in timeline declarations and `$var` references. */
export const TIMELINE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

export type TimelineVariables = Readonly<Record<string, JsonValue>>;

export interface VariableExpansionIssue {
  kind: "missing" | "invalid";
  /** Path relative to the props object, such as `title` or `palette.foreground`. */
  path: string;
  message: string;
  variable?: string;
}

export interface VariableExpansionResult {
  value: JsonValue;
  issues: VariableExpansionIssue[];
  /**
   * Map from a relative props path that came from a variable to the variable
   * name. A reference to an object records its root path; a schema failure
   * below that path can point back to the variable that supplied it.
   */
  origins: ReadonlyMap<string, string>;
}

export function isVariableReferenceObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "$var");
}

/** Returns why a reference-like object is invalid, or null when it is well formed. */
export function variableReferenceError(value: unknown): string | null {
  if (!isVariableReferenceObject(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return 'A variable reference must contain only the "$var" key.';
  }
  if (typeof value.$var !== "string" || value.$var.length === 0) {
    return '"$var" must be a non-empty variable name.';
  }
  if (!TIMELINE_VARIABLE_NAME.test(value.$var)) {
    return `Invalid variable name "${value.$var}". Use letters, digits, "_", ".", or "-" and start with a letter or "_".`;
  }
  return null;
}

/** Validates an internal variable override object (preview URLs, tests). */
export function normalizeVariableOverrides(value: unknown, label = "variables"): Record<string, JsonValue> {
  if (!isPlainObject(value)) {
    throw new FrameyardError("TIMELINE_VARIABLE_INVALID", `${label} must be a plain JSON object.`);
  }
  const variables: Record<string, JsonValue> = {};
  for (const [name, variable] of Object.entries(value)) {
    if (!TIMELINE_VARIABLE_NAME.test(name)) {
      throw new FrameyardError("TIMELINE_VARIABLE_INVALID", `${label} contains invalid variable name "${name}".`, {
        details: { variable: name },
      });
    }
    try {
      assertJsonSerializable(variable, `${label}.${name}`);
      variables[name] = variable as JsonValue;
    } catch (error) {
      throw new FrameyardError(
        "TIMELINE_VARIABLE_INVALID",
        `${label}.${name} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
        { details: { variable: name } },
      );
    }
  }
  return variables;
}

function childPath(base: string, key: string | number): string {
  if (typeof key === "number") {
    return `${base}[${key}]`;
  }
  return base.length === 0 ? key : `${base}.${key}`;
}

/** Prefixes a relative props path with the clip's JSON path. */
export function clipPropsJsonPath(clipPath: string, relativePath: string): string {
  return relativePath.length === 0 ? `${clipPath}.props` : `${clipPath}.props.${relativePath}`;
}

/**
 * Replaces `{ "$var": "name" }` values inside a clip props object with the
 * nearest visible variable value. Variable values are inserted whole and are
 * not expanded again.
 */
export function expandVariableReferences(
  value: JsonValue,
  variables: ReadonlyMap<string, JsonValue>,
): VariableExpansionResult {
  const issues: VariableExpansionIssue[] = [];
  const origins = new Map<string, string>();

  const visit = (current: unknown, path: string): JsonValue => {
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, childPath(path, index)));
    }
    if (isPlainObject(current)) {
      if (isVariableReferenceObject(current)) {
        const error = variableReferenceError(current);
        if (error !== null) {
          issues.push({ kind: "invalid", path, message: error });
          return current as JsonValue;
        }
        const name = current.$var as string;
        if (!variables.has(name)) {
          issues.push({
            kind: "missing",
            path,
            variable: name,
            message: `Timeline variable "${name}" is not declared in this scope.`,
          });
          return current as JsonValue;
        }
        origins.set(path, name);
        return variables.get(name) as JsonValue;
      }
      const result: { [key: string]: JsonValue } = {};
      for (const [key, child] of Object.entries(current)) {
        result[key] = visit(child, childPath(path, key));
      }
      return result;
    }
    return current as JsonValue;
  };

  return { value: visit(value, ""), issues, origins };
}

/** Finds the variable that supplied a failing props path, if any. */
export function variableOrigin(origins: ReadonlyMap<string, string>, relativePath: string): string | undefined {
  let best: string | undefined;
  let bestPath = "";
  for (const [path, name] of origins) {
    if (
      path.length > bestPath.length &&
      (relativePath === path || relativePath.startsWith(`${path}.`) || relativePath.startsWith(`${path}[`))
    ) {
      best = name;
      bestPath = path;
    }
  }
  return best;
}
