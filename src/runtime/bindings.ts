import {
  coerceAttribute,
  coerceClass,
  coerceText,
  isTruthy,
  resolveBindingPath,
  validateBindingPath,
  type BindingScope,
} from "../bindings.js";
import type { CompositionDiagnostic, Props } from "../contracts.js";
import { FrameyardError } from "../errors.js";

export interface ApplyBindingsOptions {
  root: Element;
  props: Readonly<Props>;
  onDiagnostic?: (diagnostic: CompositionDiagnostic) => void;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const SAFE_PROP_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Applies declarative prop bindings to the pristine composition DOM. */
export function applyBindings(options: ApplyBindingsOptions): void {
  applyToElement(options.root, { props: options.props }, options, true);
}

/** Exposes primitive top-level props as --fy-prop-* custom properties. */
export function applyPropVariables(root: HTMLElement, props: Readonly<Props>): void {
  for (const [name, value] of Object.entries(props)) {
    if (!SAFE_PROP_NAME.test(name)) {
      continue;
    }
    const property = `--fy-prop-${name}`;
    if (value === null || value === undefined || typeof value === "object") {
      root.style.removeProperty(property);
      continue;
    }
    root.style.setProperty(property, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
}

function applyToElement(element: Element, scope: BindingScope, options: ApplyBindingsOptions, isRoot: boolean): void {
  const repeat = element.getAttribute("data-fy-repeat");
  if (repeat !== null) {
    applyRepeat(element, repeat, scope, options);
    return;
  }

  const condition = element.getAttribute("data-fy-if");
  if (condition !== null) {
    if (isRoot) {
      throw new FrameyardError("BINDING_INVALID", "data-fy-if cannot be used on the composition root.");
    }
    if (!isTruthy(resolvePath(scope, condition, element, "data-fy-if", options))) {
      element.remove();
      return;
    }
  }

  const text = element.getAttribute("data-fy-text");
  if (text !== null) {
    if (isRoot) {
      throw new FrameyardError("BINDING_TARGET_INVALID", "data-fy-text cannot be used on the composition root.");
    }
    if (VOID_ELEMENTS.has(element.tagName.toLowerCase())) {
      throw new FrameyardError(
        "BINDING_TARGET_INVALID",
        `data-fy-text cannot be used on <${element.tagName.toLowerCase()}>.`,
      );
    }
    const value = resolvePath(scope, text, element, "data-fy-text", options);
    const coerced = coerceText(value);
    if (coerced.invalid) {
      warn(
        options,
        "BINDING_VALUE_INVALID",
        `data-fy-text references "${text}", which is not a primitive value.`,
        element,
        "data-fy-text",
        text,
      );
    }
    element.textContent = coerced.value;
  }

  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.startsWith("data-fy-attr-")) {
      applyAttributeBinding(element, attribute.name, attribute.value, scope, options);
    } else if (attribute.name.startsWith("data-fy-class-")) {
      applyClassBinding(element, attribute.name, attribute.value, scope, options);
    }
  }

  for (const child of Array.from(element.children)) {
    applyToElement(child, scope, options, false);
  }
}

function applyRepeat(element: Element, path: string, scope: BindingScope, options: ApplyBindingsOptions): void {
  if (!(element instanceof HTMLTemplateElement)) {
    throw new FrameyardError("BINDING_REPEAT_INVALID", "data-fy-repeat must be used on a <template>.");
  }
  if (scope.repeat) {
    throw new FrameyardError(
      "BINDING_REPEAT_NESTED",
      "Nested data-fy-repeat is not supported; use a controller for nested data.",
    );
  }

  const value = resolvePath(scope, path, element, "data-fy-repeat", options);
  if (!Array.isArray(value)) {
    throw new FrameyardError("BINDING_REPEAT_INVALID", `data-fy-repeat must reference an array; "${path}" is not.`);
  }

  const output = document.createDocumentFragment();
  value.forEach((item, index) => {
    const clone = element.content.cloneNode(true) as DocumentFragment;
    const repeatScope: BindingScope = { ...scope, repeat: { item, index } };
    for (const child of Array.from(clone.children)) {
      if (child instanceof HTMLElement || child instanceof SVGElement) {
        child.style.setProperty("--fy-index", String(index));
      }
      applyToElement(child, repeatScope, options, false);
    }
    output.append(clone);
  });
  element.replaceWith(output);
}

function applyAttributeBinding(
  element: Element,
  name: string,
  path: string,
  scope: BindingScope,
  options: ApplyBindingsOptions,
): void {
  const target = name.slice("data-fy-attr-".length);
  if (target.length === 0) {
    throw new FrameyardError("BINDING_INVALID", "data-fy-attr-* requires an attribute name.");
  }
  if (/^on/i.test(target)) {
    throw new FrameyardError(
      "EVENT_HANDLER_NOT_ALLOWED",
      `data-fy-attr-${target} would set an event handler, which is not allowed.`,
    );
  }

  const value = resolvePath(scope, path, element, name, options);
  const coerced = coerceAttribute(value);
  if (coerced.invalid) {
    warn(
      options,
      "BINDING_VALUE_INVALID",
      `${name} references "${path}", which is not a primitive value.`,
      element,
      name,
      path,
    );
  }
  if (coerced.value === null) {
    element.removeAttribute(target);
    return;
  }
  if ((target === "href" || target === "src") && /^\s*javascript:/i.test(coerced.value)) {
    throw new FrameyardError("URL_NOT_ALLOWED", `"javascript:" URLs are not allowed in a composition.`);
  }
  element.setAttribute(target, coerced.value);
}

function applyClassBinding(
  element: Element,
  name: string,
  path: string,
  scope: BindingScope,
  options: ApplyBindingsOptions,
): void {
  const className = name.slice("data-fy-class-".length);
  if (className.length === 0 || /\s/.test(className)) {
    throw new FrameyardError("BINDING_INVALID", "data-fy-class-* requires one class name without whitespace.");
  }

  const value = resolvePath(scope, path, element, name, options);
  const coerced = coerceClass(value);
  if (coerced.invalid) {
    warn(
      options,
      "BINDING_VALUE_INVALID",
      `${name} references "${path}", which is not a primitive value.`,
      element,
      name,
      path,
    );
  }
  element.classList.toggle(className, coerced.value);
}

function resolvePath(
  scope: BindingScope,
  path: string,
  element: Element,
  attribute: string,
  options: ApplyBindingsOptions,
): unknown {
  const validation = validateBindingPath(path);
  if (!validation.ok) {
    throw new FrameyardError("BINDING_INVALID", `Invalid ${attribute} path "${path}": ${validation.reason}`);
  }

  const resolved = resolveBindingPath(scope, path);
  if (!resolved.found) {
    warn(
      options,
      "BINDING_PATH_MISSING",
      `${attribute} references prop "${path}", which is not in the resolved props.`,
      element,
      attribute,
      path,
    );
    return undefined;
  }
  return resolved.value;
}

function warn(
  options: ApplyBindingsOptions,
  code: CompositionDiagnostic["code"],
  message: string,
  element: Element,
  attribute: string,
  value?: string,
): void {
  options.onDiagnostic?.({
    severity: "warning",
    code,
    message,
    details: {
      element: element.tagName.toLowerCase(),
      attribute,
      ...(value !== undefined ? { value } : {}),
    },
  });
}
