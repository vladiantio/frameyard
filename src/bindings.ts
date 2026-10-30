import type { Props } from "./contracts.js";

export interface RepeatScope {
  item: unknown;
  index: number;
}

export interface BindingScope {
  props: Readonly<Props>;
  repeat?: RepeatScope;
}

export interface BindingPathValidation {
  ok: boolean;
  reason?: string;
}

export interface ResolvedBindingPath {
  found: boolean;
  value: unknown;
}

export interface CoercedBindingValue<T> {
  value: T;
  invalid?: boolean;
}

const PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;
const DANGEROUS_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Validates a dot-separated binding path without resolving it. */
export function validateBindingPath(path: string): BindingPathValidation {
  if (path.length === 0) {
    return { ok: false, reason: "Binding path must not be empty." };
  }

  for (const segment of path.split(".")) {
    if (segment.length === 0) {
      return { ok: false, reason: "Binding path must not contain empty segments." };
    }
    if (DANGEROUS_SEGMENTS.has(segment)) {
      return { ok: false, reason: `Binding path must not use "${segment}".` };
    }
    if (!PATH_SEGMENT.test(segment)) {
      return {
        ok: false,
        reason: `Binding path segment "${segment}" must use letters, digits, "_", "$", or "-".`,
      };
    }
  }

  return { ok: true };
}

/**
 * Resolves a dot-separated path against props, or against the repeat scope when
 * the first segment is `item` or `index`. Only own properties are read.
 */
export function resolveBindingPath(scope: BindingScope, path: string): ResolvedBindingPath {
  if (!validateBindingPath(path).ok) {
    return { found: false, value: undefined };
  }

  const segments = path.split(".");
  const first = segments[0] as string;
  let current: unknown;
  let index = 0;

  if (scope.repeat && (first === "item" || first === "index")) {
    current = first === "item" ? scope.repeat.item : scope.repeat.index;
    index = 1;
  } else {
    current = scope.props;
  }

  for (; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

/** JavaScript truthiness, used by `data-fy-if` and class bindings. */
export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

/** Coerces a value for `textContent`. Objects and arrays are invalid. */
export function coerceText(value: unknown): CoercedBindingValue<string> {
  if (value === null || value === undefined) {
    return { value: "" };
  }
  if (typeof value === "string") {
    return { value };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value) };
  }
  return { value: "", invalid: true };
}

/**
 * Coerces a value for an attribute. `true` writes an empty attribute, and
 * `false`, `null`, and `undefined` remove it.
 */
export function coerceAttribute(value: unknown): CoercedBindingValue<string | null> {
  if (value === true) {
    return { value: "" };
  }
  if (value === false || value === null || value === undefined) {
    return { value: null };
  }
  if (typeof value === "string" || typeof value === "number") {
    return { value: String(value) };
  }
  return { value: null, invalid: true };
}

/** Coerces a value for a class binding. Objects and arrays are invalid. */
export function coerceClass(value: unknown): CoercedBindingValue<boolean> {
  if (value === null || value === undefined) {
    return { value: false };
  }
  if (typeof value === "boolean") {
    return { value };
  }
  if (typeof value === "string" || typeof value === "number") {
    return { value: Boolean(value) };
  }
  return { value: false, invalid: true };
}

/** Suggests the closest top-level prop name for a mistyped binding path. */
export function suggestBindingPath(path: string, props: Readonly<Props>): string | undefined {
  const root = path.split(".")[0];
  if (root === undefined || root.length === 0) {
    return undefined;
  }

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const key of Object.keys(props)) {
    if (key === root) {
      return undefined;
    }
    const distance = editDistance(root.toLowerCase(), key.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }

  return bestDistance <= 2 ? best : undefined;
}

function editDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] as number) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const insertion = (current[rightIndex - 1] as number) + 1;
      const deletion = (previous[rightIndex] as number) + 1;
      current[rightIndex] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }

  return previous[right.length] as number;
}
