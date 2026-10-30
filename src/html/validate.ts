import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertJsonSerializable,
  isPlainObject,
  mergeProps,
  normalizeAudioClip,
  normalizeTranscriptClip,
  type CompositionDiagnostic,
  type CompositionDiagnosticDetails,
  type CompositionMetadata,
  type CompositionSourceInfo,
  type ControllerDeclaration,
  type DiagnosticSeverity,
  type Props,
  type ResolvedAudioClip,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import { resolveBindingPath, suggestBindingPath, validateBindingPath } from "../bindings.js";
import { errorMessage, isFrameyardError, type FrameyardErrorCode } from "../errors.js";
import { parseTranscript } from "../transcript.js";
import {
  findElements,
  getAttribute,
  getAttributeLocation,
  getDocumentDoctype,
  getElementByTagName,
  getElementLocation,
  getNodeLocation,
  getTextContent,
  hasAttribute,
  isDescendantOf,
  isElement,
  isTemplate,
  isTextNode,
  parseHtml,
  walk,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  type HtmlParentNode,
  type SourceLocation,
} from "./parse.js";

export interface ValidateHtmlCompositionOptions {
  projectRoot: string;
  /** Project-relative path to the composition HTML document. */
  entry: string;
  /** External props overrides merged over the document's default props. */
  props?: unknown;
}

export interface StaticValidationResult {
  info: CompositionSourceInfo | null;
  diagnostics: CompositionDiagnostic[];
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
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
const NON_VISUAL_ELEMENTS = new Set(["script", "style", "link", "meta", "template", "noscript", "title"]);
const NON_ANIMATED_ELEMENTS = new Set(["audio", "fy-transcript", "script", "style", "link", "meta", "template"]);
const MEDIA_ATTRIBUTES = new Set([
  "data-fy-start",
  "data-fy-trim",
  "data-fy-duration",
  "data-fy-volume",
  "data-fy-audio",
]);
const KNOWN_BINDING_ATTRIBUTES = [
  "data-fy",
  "data-fy-text",
  "data-fy-if",
  "data-fy-repeat",
  "data-fy-anim-start",
  "data-fy-anim-duration",
  "data-fy-anim-easing",
  "data-fy-start",
  "data-fy-trim",
  "data-fy-duration",
  "data-fy-volume",
  "data-fy-audio",
];

class HtmlCompositionValidator {
  private readonly diagnostics: CompositionDiagnostic[] = [];
  private readonly projectRoot: string;
  private readonly entry: string;
  private readonly compositionDir: string;
  private readonly document: HtmlDocument;
  private readonly propsOverrides: unknown;
  private defaultPropsValue: Readonly<Props> = Object.freeze({});
  private props: Readonly<Props>;
  private metadata: CompositionMetadata | null = null;
  private controller: ControllerDeclaration | null = null;
  private documentValid = true;
  private defaultsValid = true;
  private controllerValid = true;
  private rootValid = false;
  private root: HtmlElement | null = null;
  private readonly audioClips: ResolvedAudioClip[] = [];
  private readonly embeddedAudioClips: ResolvedAudioClip[] = [];
  private readonly transcriptClips: ResolvedTranscriptClip[] = [];

  constructor(options: ValidateHtmlCompositionOptions, document: HtmlDocument) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.entry = options.entry.replaceAll("\\", "/");
    this.compositionDir = path.dirname(path.resolve(this.projectRoot, this.entry));
    this.document = document;
    this.propsOverrides = options.props;
    this.props = this.defaultPropsValue;
  }

  async run(): Promise<StaticValidationResult> {
    this.validateDoctype();
    this.findRoot();
    this.validateMetadata();
    await this.validateDefaultProps();
    this.validateControllerDeclaration();
    await this.validateControllerFile();
    this.validateScripts();
    this.validateUnsupportedElements();
    this.validateDocumentAttributes();
    this.validateOutsideRoot();
    if (this.root) {
      this.validateBindings(this.root, 0);
    }
    await this.validateMedia();
    await this.validateTranscripts();
    await this.validateOrdinaryAssets();

    const info: CompositionSourceInfo | null =
      this.metadata && this.root && this.rootValid && this.documentValid && this.defaultsValid && this.controllerValid
        ? {
            metadata: this.metadata,
            defaultProps: this.defaultPropsValue,
            controller: this.controller,
            audioClips: Object.freeze([...this.audioClips]),
            embeddedAudioClips: Object.freeze([...this.embeddedAudioClips]),
            transcriptClips: Object.freeze([...this.transcriptClips]),
          }
        : null;

    return { info, diagnostics: this.finishDiagnostics() };
  }

  private report(
    severity: DiagnosticSeverity,
    code: FrameyardErrorCode,
    message: string,
    details?: CompositionDiagnosticDetails,
  ): void {
    const diagnostic: CompositionDiagnostic = {
      severity,
      code,
      message,
    };
    const merged = { path: this.entry, ...details };
    if (Object.keys(merged).length > 0) {
      diagnostic.details = merged;
    }
    this.diagnostics.push(diagnostic);
  }

  private error(code: FrameyardErrorCode, message: string, details?: CompositionDiagnosticDetails): void {
    this.report("error", code, message, details);
  }

  private warning(code: FrameyardErrorCode, message: string, details?: CompositionDiagnosticDetails): void {
    this.report("warning", code, message, details);
  }

  private attributeDetails(
    element: HtmlElement,
    attribute: string,
    extra: CompositionDiagnosticDetails = {},
  ): CompositionDiagnosticDetails {
    const location = getAttributeLocation(element, attribute) ?? getElementLocation(element);
    return {
      element: element.tagName,
      attribute,
      ...this.locationDetails(location),
      ...extra,
    };
  }

  private elementDetails(element: HtmlElement, extra: CompositionDiagnosticDetails = {}): CompositionDiagnosticDetails {
    return {
      element: element.tagName,
      ...this.locationDetails(getElementLocation(element)),
      ...extra,
    };
  }

  private nodeDetails(node: HtmlNode, extra: CompositionDiagnosticDetails = {}): CompositionDiagnosticDetails {
    return {
      ...this.locationDetails(getNodeLocation(node)),
      ...extra,
    };
  }

  private locationDetails(location: SourceLocation | undefined): CompositionDiagnosticDetails {
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

  private finishDiagnostics(): CompositionDiagnostic[] {
    const seen = new Set<string>();
    const unique = this.diagnostics.filter((diagnostic) => {
      const key = JSON.stringify([
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.details ?? null,
      ]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return unique.sort((left, right) => {
      const leftLine = left.details?.line ?? Number.MAX_SAFE_INTEGER;
      const rightLine = right.details?.line ?? Number.MAX_SAFE_INTEGER;
      if (leftLine !== rightLine) {
        return leftLine - rightLine;
      }
      const leftColumn = left.details?.column ?? 0;
      const rightColumn = right.details?.column ?? 0;
      return leftColumn - rightColumn;
    });
  }

  private validateDoctype(): void {
    const doctype = getDocumentDoctype(this.document);
    if (!doctype) {
      this.documentValid = false;
      this.error("COMPOSITION_INVALID", "Composition documents must start with <!doctype html>.", {
        line: 1,
        column: 1,
      });
      return;
    }
    if (doctype.name.toLowerCase() !== "html") {
      this.documentValid = false;
      this.error("COMPOSITION_INVALID", "Composition documents must use the HTML doctype.", {
        ...this.locationDetails(doctype.sourceCodeLocation ?? undefined),
      });
    }
  }

  private findRoot(): void {
    const roots = findElements(this.document, (element) => element.tagName === "fy-composition");
    if (roots.length === 0) {
      this.error("COMPOSITION_INVALID", "Composition document must contain one <fy-composition> root.");
      return;
    }

    for (const extra of roots.slice(1)) {
      this.error(
        "COMPOSITION_INVALID",
        "Composition document must contain exactly one <fy-composition> root.",
        this.elementDetails(extra),
      );
    }

    const root = roots[0] as HtmlElement;
    this.root = root;

    let valid = roots.length === 1;
    const body = getElementByTagName(this.document, "body");
    if (!body || !isDescendantOf(root, body)) {
      valid = false;
      this.error("COMPOSITION_INVALID", "The <fy-composition> root must be inside <body>.", this.elementDetails(root));
    }
    if (this.isInsideTemplate(root)) {
      valid = false;
      this.error(
        "COMPOSITION_INVALID",
        "The <fy-composition> root must not be inside a <template>.",
        this.elementDetails(root),
      );
    }
    this.rootValid = valid;
  }

  private isInsideTemplate(node: HtmlNode): boolean {
    let current: HtmlParentNode | null = "parentNode" in node ? node.parentNode : null;
    while (current) {
      if (isElement(current) && current.tagName === "template") {
        return true;
      }
      current = "parentNode" in current ? current.parentNode : null;
    }
    return false;
  }

  private validateMetadata(): void {
    const root = this.root;
    if (!root) {
      return;
    }

    const width = this.readPositiveInteger(root, "width");
    const height = this.readPositiveInteger(root, "height");
    const fps = this.readPositiveNumber(root, "fps");
    const durationInFrames = this.readPositiveInteger(root, "duration-in-frames");

    if (width !== null && height !== null && fps !== null && durationInFrames !== null) {
      this.metadata = { width, height, fps, durationInFrames };
    }
  }

  private readPositiveInteger(element: HtmlElement, attribute: string): number | null {
    const raw = getAttribute(element, attribute);
    if (raw === undefined) {
      this.error(
        "COMPOSITION_INVALID",
        `Missing required "${attribute}" attribute on <fy-composition>.`,
        this.attributeDetails(element, attribute),
      );
      return null;
    }
    const value = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value <= 0) {
      this.error(
        "COMPOSITION_INVALID",
        `"${attribute}" must be a positive integer; received "${raw}".`,
        this.attributeDetails(element, attribute, { value: raw }),
      );
      return null;
    }
    return value;
  }

  private readPositiveNumber(element: HtmlElement, attribute: string): number | null {
    const raw = getAttribute(element, attribute);
    if (raw === undefined) {
      this.error(
        "COMPOSITION_INVALID",
        `Missing required "${attribute}" attribute on <fy-composition>.`,
        this.attributeDetails(element, attribute),
      );
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      this.error(
        "COMPOSITION_INVALID",
        `"${attribute}" must be a positive number; received "${raw}".`,
        this.attributeDetails(element, attribute, { value: raw }),
      );
      return null;
    }
    return value;
  }

  private async validateDefaultProps(): Promise<void> {
    const blocks = findElements(
      this.document,
      (element) =>
        element.tagName === "script" &&
        getAttribute(element, "type")?.toLowerCase() === "application/json" &&
        getAttribute(element, "data-fy") === "props",
    );

    if (blocks.length > 1) {
      this.defaultsValid = false;
      for (const extra of blocks.slice(1)) {
        this.error(
          "PROPS_INVALID",
          'A composition may contain at most one data-fy="props" block.',
          this.elementDetails(extra),
        );
      }
    }

    const block = blocks[0];
    let defaults: Readonly<Props> = Object.freeze({});
    if (block) {
      if (this.isInsideTemplate(block)) {
        this.defaultsValid = false;
        this.error(
          "PROPS_INVALID",
          'The data-fy="props" block must not be inside a <template>.',
          this.elementDetails(block),
        );
      }
      try {
        const parsed: unknown = JSON.parse(getTextContent(block));
        if (!isPlainObject(parsed)) {
          throw new Error('The data-fy="props" block must contain a JSON object.');
        }
        assertJsonSerializable(parsed, "defaultProps");
        defaults = mergeProps(parsed as Props, undefined);
      } catch (error) {
        this.defaultsValid = false;
        this.error("PROPS_INVALID", `Invalid default props: ${errorMessage(error)}`, this.elementDetails(block));
      }
    }

    try {
      this.props = mergeProps(defaults, this.propsOverrides);
    } catch (error) {
      this.defaultsValid = false;
      this.error("PROPS_INVALID", `Invalid props: ${errorMessage(error)}`);
      this.props = defaults;
    }

    if (this.defaultsValid) {
      this.defaultPropsValue = defaults;
    }
  }

  private validateControllerDeclaration(): void {
    const blocks = findElements(
      this.document,
      (element) =>
        element.tagName === "script" && getAttribute(element, "type")?.toLowerCase() === "text/fy-controller",
    );

    if (blocks.length > 1) {
      this.controllerValid = false;
      for (const extra of blocks.slice(1)) {
        this.error(
          "CONTROLLER_INVALID",
          "A composition may declare at most one controller.",
          this.elementDetails(extra),
        );
      }
    }

    const block = blocks[0];
    if (!block) {
      return;
    }

    if (this.isInsideTemplate(block)) {
      this.controllerValid = false;
      this.error(
        "CONTROLLER_INVALID",
        "The controller block must not be inside a <template>.",
        this.elementDetails(block),
      );
    }

    const src = getAttribute(block, "src");
    const source = getTextContent(block);
    const hasSource = source.trim().length > 0;

    if (src !== undefined && hasSource) {
      this.controllerValid = false;
      this.error(
        "CONTROLLER_INVALID",
        "A controller must be either inline or external, not both.",
        this.attributeDetails(block, "src"),
      );
      return;
    }
    if (src === undefined && !hasSource) {
      this.controllerValid = false;
      this.error(
        "CONTROLLER_INVALID",
        "A controller must contain inline source or reference an external module with src.",
        this.elementDetails(block),
      );
      return;
    }

    if (src !== undefined) {
      this.controller = {
        kind: "external",
        src,
        ...this.locationDetails(getAttributeLocation(block, "src")),
      };
      return;
    }

    const textNode = block.childNodes[0];
    const location = textNode ? getNodeLocation(textNode) : getElementLocation(block);
    this.controller = {
      kind: "inline",
      source,
      ...this.locationDetails(location),
    };
  }

  private async validateControllerFile(): Promise<void> {
    if (!this.controller || this.controller.kind !== "external" || this.controller.src === undefined) {
      return;
    }

    const details: CompositionDiagnosticDetails = {
      path: this.entry,
      ...(this.controller.line !== undefined ? { line: this.controller.line, column: this.controller.column } : {}),
    };
    const resolved = await this.resolveLocalFile(
      this.controller.src,
      this.compositionDir,
      "CONTROLLER_INVALID",
      "Controller",
      details,
    );
    if (!resolved) {
      this.controllerValid = false;
      return;
    }
    this.controller = { ...this.controller, src: resolved.relative };
  }

  private validateScripts(): void {
    for (const element of findElements(this.document, (candidate) => candidate.tagName === "script")) {
      if (hasAttribute(element, "data-fy-host")) {
        continue;
      }
      const type = getAttribute(element, "type")?.toLowerCase();
      if (type === "importmap" || type === "application/json" || type === "text/fy-controller") {
        continue;
      }
      this.error(
        "SCRIPT_NOT_ALLOWED",
        "Executable <script> elements are not allowed in a composition; move code into the controller.",
        this.elementDetails(element, { value: getAttribute(element, "src") }),
      );
    }
  }

  private validateUnsupportedElements(): void {
    walk(this.document, (node) => {
      if (!isElement(node)) {
        return;
      }
      const tag = node.tagName;
      if (tag === "iframe" || tag === "object" || tag === "embed") {
        this.error(
          "ELEMENT_NOT_SUPPORTED",
          `<${tag}> is not a supported visual source; use HTML, SVG, canvas, or a local <video>.`,
          this.elementDetails(node),
        );
        return;
      }
      if (tag === "base") {
        this.error("ELEMENT_NOT_SUPPORTED", "<base> is not supported in a composition.", this.elementDetails(node));
        return;
      }
      if (tag === "source" || tag === "track") {
        this.error(
          "ELEMENT_NOT_SUPPORTED",
          `<${tag}> is not supported; use a local media src and <fy-transcript> for captions.`,
          this.elementDetails(node),
        );
        return;
      }
      if (tag === "meta") {
        const httpEquiv = getAttribute(node, "http-equiv")?.toLowerCase();
        if (httpEquiv === "refresh" || httpEquiv === "content-security-policy") {
          this.error(
            "ELEMENT_NOT_SUPPORTED",
            `<meta http-equiv="${httpEquiv}"> is not supported in a composition.`,
            this.attributeDetails(node, "http-equiv"),
          );
        }
        return;
      }
      if (tag === "template" && hasAttribute(node, "shadowrootmode")) {
        this.error(
          "ELEMENT_NOT_SUPPORTED",
          "Declarative shadow DOM is not supported in a composition.",
          this.elementDetails(node),
        );
        return;
      }
      if (tag.startsWith("fy-") && tag !== "fy-composition" && tag !== "fy-transcript") {
        this.warning("ELEMENT_UNKNOWN", `Unknown Frameyard element <${tag}>.`, this.elementDetails(node));
      }
    });
  }

  private validateDocumentAttributes(): void {
    walk(this.document, (node) => {
      if (!isElement(node)) {
        return;
      }
      for (const attribute of node.attrs) {
        if (/^on[a-z]/i.test(attribute.name)) {
          this.error(
            "EVENT_HANDLER_NOT_ALLOWED",
            `Event handler attribute "${attribute.name}" is not allowed in a composition.`,
            this.attributeDetails(node, attribute.name),
          );
        }
        if (/^\s*javascript:/i.test(attribute.value)) {
          this.error(
            "URL_NOT_ALLOWED",
            `"javascript:" URLs are not allowed in a composition.`,
            this.attributeDetails(node, attribute.name, { value: attribute.value }),
          );
        }
      }
    });
  }

  private validateOutsideRoot(): void {
    const body = getElementByTagName(this.document, "body");
    const root = this.root;
    if (!body || !root) {
      return;
    }

    const inspect = (parent: HtmlElement): void => {
      for (const child of parent.childNodes) {
        if (child === root) {
          continue;
        }
        if (isElement(child)) {
          if (isDescendantOf(root, child)) {
            inspect(child);
            continue;
          }
          if (NON_VISUAL_ELEMENTS.has(child.tagName)) {
            continue;
          }
          this.warning(
            "CONTENT_OUTSIDE_ROOT",
            "Visual content outside <fy-composition> is not captured; move it inside the composition root.",
            this.elementDetails(child),
          );
          continue;
        }
        if (isTextNode(child) && child.value.trim().length > 0) {
          this.warning(
            "CONTENT_OUTSIDE_ROOT",
            "Text outside <fy-composition> is not captured; move it inside the composition root.",
            this.nodeDetails(child),
          );
        }
      }
    };

    inspect(body);
  }

  private validateBindings(element: HtmlElement, repeatDepth: number): void {
    const repeat = getAttribute(element, "data-fy-repeat");
    const condition = getAttribute(element, "data-fy-if");
    const text = getAttribute(element, "data-fy-text");
    const inRepeat = repeatDepth > 0;

    if (repeat !== undefined) {
      if (element.tagName !== "template") {
        this.error(
          "BINDING_REPEAT_INVALID",
          "data-fy-repeat must be used on a <template>.",
          this.attributeDetails(element, "data-fy-repeat"),
        );
      }
      if (condition !== undefined) {
        this.error(
          "BINDING_INVALID",
          "A repeat template cannot also use data-fy-if.",
          this.attributeDetails(element, "data-fy-if"),
        );
      }
      if (text !== undefined) {
        this.error(
          "BINDING_TARGET_INVALID",
          "A repeat template cannot use data-fy-text.",
          this.attributeDetails(element, "data-fy-text"),
        );
      }
      if (inRepeat) {
        this.error(
          "BINDING_REPEAT_NESTED",
          "Nested data-fy-repeat is not supported; use a controller for nested data.",
          this.attributeDetails(element, "data-fy-repeat"),
        );
      }
      this.validateBindingPathValue(repeat, element, "data-fy-repeat", {
        inRepeat,
        requireArray: true,
      });

      if (isTemplate(element)) {
        for (const child of element.content.childNodes) {
          if (isElement(child)) {
            this.validateBindings(child, repeatDepth + 1);
          }
        }
      }
      return;
    }

    if (condition !== undefined) {
      if (element === this.root) {
        this.error(
          "BINDING_INVALID",
          "data-fy-if cannot be used on the composition root.",
          this.attributeDetails(element, "data-fy-if"),
        );
      } else {
        this.validateBindingPathValue(condition, element, "data-fy-if", { inRepeat });
      }
    }

    if (text !== undefined) {
      if (element === this.root) {
        this.error(
          "BINDING_TARGET_INVALID",
          "data-fy-text cannot be used on the composition root.",
          this.attributeDetails(element, "data-fy-text"),
        );
      } else if (VOID_ELEMENTS.has(element.tagName)) {
        this.error(
          "BINDING_TARGET_INVALID",
          `data-fy-text cannot be used on <${element.tagName}>.`,
          this.attributeDetails(element, "data-fy-text"),
        );
      } else {
        this.validateBindingPathValue(text, element, "data-fy-text", {
          inRepeat,
          checkValueType: "text",
        });
      }
    }

    for (const attribute of element.attrs) {
      const name = attribute.name;
      if (name === "data-fy-repeat" || name === "data-fy-if" || name === "data-fy-text") {
        continue;
      }
      if (name === "data-fy") {
        if (element.tagName !== "script" || getAttribute(element, "type")?.toLowerCase() !== "application/json") {
          this.error(
            "BINDING_INVALID",
            "data-fy is only valid on a JSON props block.",
            this.attributeDetails(element, name),
          );
        }
        continue;
      }
      if (name.startsWith("data-fy-attr-")) {
        this.validateAttributeBinding(element, name, attribute.value, inRepeat);
        continue;
      }
      if (name.startsWith("data-fy-class-")) {
        this.validateClassBinding(element, name, attribute.value, inRepeat);
        continue;
      }
      if (name === "data-fy-anim-start" || name === "data-fy-anim-duration") {
        this.validateAnimationDuration(element, name, attribute.value);
        continue;
      }
      if (name === "data-fy-anim-easing") {
        if (attribute.value.trim().length === 0) {
          this.error(
            "ANIMATION_INVALID",
            "data-fy-anim-easing must not be empty.",
            this.attributeDetails(element, name),
          );
        }
        continue;
      }
      if (MEDIA_ATTRIBUTES.has(name)) {
        this.validateMediaAttribute(element, name, attribute.value);
        continue;
      }
      if (name.startsWith("data-fy-")) {
        this.error(
          "BINDING_INVALID",
          `Unknown Frameyard attribute "${name}". Known attributes: ${KNOWN_BINDING_ATTRIBUTES.join(", ")}.`,
          this.attributeDetails(element, name, { value: attribute.value }),
        );
      }
    }

    const children = isTemplate(element) ? element.content.childNodes : element.childNodes;
    for (const child of children) {
      if (isElement(child)) {
        this.validateBindings(child, repeatDepth);
      }
    }
  }

  private validateBindingPathValue(
    path: string,
    element: HtmlElement,
    attribute: string,
    options: {
      inRepeat: boolean;
      requireArray?: boolean;
      checkValueType?: "text" | "attr" | "class";
    },
  ): void {
    const validation = validateBindingPath(path);
    if (!validation.ok) {
      this.error(
        "BINDING_INVALID",
        `Invalid ${attribute} path "${path}": ${validation.reason}`,
        this.attributeDetails(element, attribute, { value: path }),
      );
      return;
    }

    const root = path.split(".")[0];
    if (options.inRepeat && (root === "item" || root === "index")) {
      return;
    }

    const resolved = resolveBindingPath({ props: this.props }, path);
    if (!resolved.found) {
      const severity: DiagnosticSeverity = options.requireArray ? "error" : "warning";
      const code: FrameyardErrorCode = options.requireArray ? "BINDING_REPEAT_INVALID" : "BINDING_PATH_MISSING";
      this.report(
        severity,
        code,
        `${attribute} references prop "${path}", which is not in the resolved props.`,
        this.attributeDetails(element, attribute, {
          value: path,
          suggestion: suggestBindingPath(path, this.props),
        }),
      );
      return;
    }

    if (options.requireArray && !Array.isArray(resolved.value)) {
      this.error(
        "BINDING_REPEAT_INVALID",
        `${attribute} must reference an array; "${path}" is ${describeValue(resolved.value)}.`,
        this.attributeDetails(element, attribute, { value: path }),
      );
      return;
    }

    if (options.checkValueType && resolved.value !== null && typeof resolved.value === "object") {
      this.warning(
        "BINDING_VALUE_INVALID",
        `${attribute} references "${path}", which is ${describeValue(resolved.value)}; ${options.checkValueType} bindings require a primitive value.`,
        this.attributeDetails(element, attribute, { value: path }),
      );
    }
  }

  private validateAttributeBinding(element: HtmlElement, name: string, value: string, inRepeat: boolean): void {
    const target = name.slice("data-fy-attr-".length);
    if (target.length === 0) {
      this.error("BINDING_INVALID", "data-fy-attr-* requires an attribute name.", this.attributeDetails(element, name));
      return;
    }
    if (/^on/i.test(target)) {
      this.error(
        "EVENT_HANDLER_NOT_ALLOWED",
        `data-fy-attr-${target} would set an event handler, which is not allowed.`,
        this.attributeDetails(element, name),
      );
      return;
    }
    this.validateBindingPathValue(value, element, name, {
      inRepeat,
      checkValueType: "attr",
    });
  }

  private validateClassBinding(element: HtmlElement, name: string, value: string, inRepeat: boolean): void {
    const className = name.slice("data-fy-class-".length);
    if (className.length === 0 || /\s/.test(className)) {
      this.error(
        "BINDING_INVALID",
        "data-fy-class-* requires one class name without whitespace.",
        this.attributeDetails(element, name),
      );
      return;
    }
    this.validateBindingPathValue(value, element, name, {
      inRepeat,
      checkValueType: "class",
    });
  }

  private validateAnimationDuration(element: HtmlElement, name: string, value: string): void {
    const frames = Number(value);
    const valid =
      /^\d+$/.test(value.trim()) &&
      Number.isInteger(frames) &&
      (name === "data-fy-anim-start" ? frames >= 0 : frames > 0);
    if (!valid) {
      this.error(
        "ANIMATION_INVALID",
        `${name} must be a ${name === "data-fy-anim-start" ? "non-negative" : "positive"} integer frame count.`,
        this.attributeDetails(element, name, { value }),
      );
    }
    if (NON_ANIMATED_ELEMENTS.has(element.tagName)) {
      this.warning(
        "ANIMATION_NOT_FOUND",
        `${name} has no visual animation target on <${element.tagName}>.`,
        this.attributeDetails(element, name),
      );
    }
  }

  private validateMediaAttribute(element: HtmlElement, name: string, value: string): void {
    if (element.tagName !== "audio" && element.tagName !== "video") {
      this.error("MEDIA_INVALID", `${name} is only valid on <audio> or <video>.`, this.attributeDetails(element, name));
      return;
    }
    if (name === "data-fy-audio") {
      if (element.tagName !== "video" || value !== "off") {
        this.error(
          "MEDIA_INVALID",
          'data-fy-audio is only valid on <video> with the value "off".',
          this.attributeDetails(element, name, { value }),
        );
      }
      return;
    }
    if (name === "data-fy-start") {
      const frames = Number(value);
      if (!/^\d+$/.test(value.trim()) || !Number.isInteger(frames) || frames < 0) {
        this.error(
          "MEDIA_INVALID",
          "data-fy-start must be a non-negative integer frame.",
          this.attributeDetails(element, name, { value }),
        );
      }
      return;
    }
    if (name === "data-fy-trim") {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) {
        this.error(
          "MEDIA_INVALID",
          "data-fy-trim must be a non-negative number of seconds.",
          this.attributeDetails(element, name, { value }),
        );
      }
      return;
    }
    if (name === "data-fy-duration") {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        this.error(
          "MEDIA_INVALID",
          "data-fy-duration must be a positive number of seconds.",
          this.attributeDetails(element, name, { value }),
        );
      }
      return;
    }
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      this.error(
        "MEDIA_INVALID",
        "data-fy-volume must be between 0 and 1.",
        this.attributeDetails(element, name, { value }),
      );
    }
  }

  private async validateMedia(): Promise<void> {
    const media = findElements(this.document, (element) => element.tagName === "audio" || element.tagName === "video");
    for (const element of media) {
      const literal = getAttribute(element, "src");
      const bound = getAttribute(element, "data-fy-attr-src");
      if (literal !== undefined && bound !== undefined) {
        this.error(
          "MEDIA_INVALID",
          `Use either src or data-fy-attr-src on <${element.tagName}>, not both.`,
          this.elementDetails(element),
        );
        continue;
      }
      if (literal === undefined && bound === undefined) {
        this.error(
          "MEDIA_INVALID",
          `<${element.tagName}> requires a src attribute or data-fy-attr-src binding.`,
          this.elementDetails(element),
        );
        continue;
      }

      let source: string | undefined;
      if (literal !== undefined) {
        source = literal;
      } else if (bound !== undefined) {
        const resolved = this.resolveMediaBinding(bound);
        if (resolved === null) {
          continue;
        }
        source = resolved;
      }

      if (source === undefined) {
        continue;
      }

      const file = await this.resolveLocalFile(
        source,
        this.projectRoot,
        "MEDIA_INVALID",
        "Media",
        this.elementDetails(element),
      );
      if (!file) {
        continue;
      }

      const startFrame = this.readMediaInteger(element, "data-fy-start", 0);
      const trimStart = this.readMediaNumber(element, "data-fy-trim", 0);
      const trimDuration = this.readOptionalMediaNumber(element, "data-fy-duration");
      const volume = hasAttribute(element, "muted") ? 0 : this.readMediaNumber(element, "data-fy-volume", 1);
      if (startFrame === undefined || trimStart === undefined || volume === undefined) {
        continue;
      }

      try {
        const clip = normalizeAudioClip(
          {
            src: file.relative,
            startFrame,
            trimStart,
            ...(trimDuration !== undefined ? { trimDuration } : {}),
            volume,
          },
          this.audioClips.length + this.embeddedAudioClips.length,
        );
        if (element.tagName === "audio") {
          this.audioClips.push(clip);
        } else if (!hasAttribute(element, "muted") && getAttribute(element, "data-fy-audio") !== "off") {
          this.embeddedAudioClips.push(clip);
        }
      } catch (error) {
        this.error(errorCode(error, "MEDIA_INVALID"), errorMessage(error), this.elementDetails(element));
      }
    }
  }

  private resolveMediaBinding(path: string): string | null {
    const root = path.split(".")[0];
    if (root === "item" || root === "index") {
      return null;
    }
    const resolved = resolveBindingPath({ props: this.props }, path);
    if (!resolved.found) {
      return null;
    }
    if (typeof resolved.value !== "string" || resolved.value.length === 0) {
      this.error("MEDIA_INVALID", `Media binding "${path}" must resolve to a non-empty local path.`, { value: path });
      return null;
    }
    return resolved.value;
  }

  private readMediaInteger(element: HtmlElement, attribute: string, fallback: number): number | undefined {
    const raw = getAttribute(element, attribute);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number(raw);
    return /^\d+$/.test(raw.trim()) && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  private readMediaNumber(element: HtmlElement, attribute: string, fallback: number): number | undefined {
    const raw = getAttribute(element, attribute);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private readOptionalMediaNumber(element: HtmlElement, attribute: string): number | undefined {
    const raw = getAttribute(element, attribute);
    if (raw === undefined) {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private async validateTranscripts(): Promise<void> {
    const transcripts = findElements(this.document, (element) => element.tagName === "fy-transcript");
    for (const element of transcripts) {
      const literal = getAttribute(element, "src");
      const bound = getAttribute(element, "data-fy-attr-src");
      if (literal !== undefined && bound !== undefined) {
        this.error(
          "TRANSCRIPT_INVALID",
          "Use either src or data-fy-attr-src on <fy-transcript>, not both.",
          this.elementDetails(element),
        );
        continue;
      }
      if (literal === undefined && bound === undefined) {
        this.error(
          "TRANSCRIPT_INVALID",
          "<fy-transcript> requires a src attribute or data-fy-attr-src binding.",
          this.elementDetails(element),
        );
        continue;
      }

      let source: string | undefined;
      if (literal !== undefined) {
        source = literal;
      } else if (bound !== undefined) {
        const resolved = this.resolveMediaBinding(bound);
        if (resolved === null) {
          continue;
        }
        source = resolved;
      }

      if (source === undefined) {
        continue;
      }

      const file = await this.resolveLocalFile(
        source,
        this.projectRoot,
        "TRANSCRIPT_INVALID",
        "Transcript",
        this.elementDetails(element),
      );
      if (!file) {
        continue;
      }

      const words = hasAttribute(element, "words");
      try {
        const clip = normalizeTranscriptClip({ src: file.relative, words }, this.transcriptClips.length);
        this.transcriptClips.push(clip);
        const content = await readFile(file.absolute, "utf8");
        const parsed: unknown = JSON.parse(content);
        parseTranscript(parsed, { requireWords: words });
      } catch (error) {
        this.error(errorCode(error, "TRANSCRIPT_INVALID"), errorMessage(error), {
          path: file.relative,
          ...this.elementDetails(element),
        });
      }
    }
  }

  private async validateOrdinaryAssets(): Promise<void> {
    const assets: Array<{ element: HtmlElement; attribute: string; value: string }> = [];

    for (const image of findElements(this.document, (element) => element.tagName === "img")) {
      const src = getAttribute(image, "src");
      if (src !== undefined) {
        assets.push({ element: image, attribute: "src", value: src });
      }
    }
    for (const link of findElements(this.document, (element) => element.tagName === "link")) {
      const rel = getAttribute(link, "rel")?.toLowerCase().split(/\s+/) ?? [];
      if (!rel.includes("stylesheet")) {
        continue;
      }
      const href = getAttribute(link, "href");
      if (href !== undefined) {
        assets.push({ element: link, attribute: "href", value: href });
      }
    }

    for (const asset of assets) {
      if (isRemote(asset.value)) {
        continue;
      }
      await this.resolveLocalFile(
        asset.value,
        this.compositionDir,
        "ASSET_NOT_FOUND",
        "Asset",
        this.attributeDetails(asset.element, asset.attribute, { value: asset.value }),
      );
    }
  }

  private async resolveLocalFile(
    raw: string,
    baseDir: string,
    code: FrameyardErrorCode,
    label: string,
    details: CompositionDiagnosticDetails,
  ): Promise<{ absolute: string; relative: string } | null> {
    if (!isLocalRelative(raw)) {
      this.error(code, `${label} path must be a local project file, not "${raw}".`, { ...details, value: raw });
      return null;
    }
    const absolute = path.resolve(baseDir, raw);
    if (absolute !== this.projectRoot && !absolute.startsWith(this.projectRoot + path.sep)) {
      this.error(code, `${label} path escapes the project root: "${raw}".`, { ...details, value: raw });
      return null;
    }
    try {
      const file = await stat(absolute);
      if (!file.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      this.error(code, `${label} file does not exist: "${raw}".`, { ...details, value: raw });
      return null;
    }
    return {
      absolute,
      relative: path.relative(this.projectRoot, absolute).split(path.sep).join("/"),
    };
  }
}

export async function validateHtmlComposition(
  options: ValidateHtmlCompositionOptions,
): Promise<StaticValidationResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const entryPath = path.resolve(projectRoot, options.entry);
  if (entryPath !== projectRoot && !entryPath.startsWith(projectRoot + path.sep)) {
    return {
      info: null,
      diagnostics: [
        {
          severity: "error",
          code: "COMPOSITION_INVALID",
          message: `Composition entry escapes the project root: "${options.entry}".`,
          details: { path: options.entry.replaceAll("\\", "/") },
        },
      ],
    };
  }

  let html: string;
  try {
    html = await readFile(entryPath, "utf8");
  } catch {
    return {
      info: null,
      diagnostics: [
        {
          severity: "error",
          code: "COMPOSITION_NOT_FOUND",
          message: `Composition entry does not exist: "${options.entry}".`,
          details: { path: options.entry.replaceAll("\\", "/") },
        },
      ],
    };
  }

  let document: HtmlDocument;
  try {
    document = parseHtml(html);
  } catch (error) {
    return {
      info: null,
      diagnostics: [
        {
          severity: "error",
          code: "COMPOSITION_INVALID",
          message: `Could not parse composition HTML: ${errorMessage(error)}`,
          details: { path: options.entry.replaceAll("\\", "/") },
        },
      ],
    };
  }

  const validator = new HtmlCompositionValidator({ ...options, projectRoot }, document);
  return validator.run();
}

function isRemote(value: string): boolean {
  return SCHEME.test(value) || value.startsWith("//");
}

function isLocalRelative(value: string): boolean {
  return !SCHEME.test(value) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

function errorCode(error: unknown, fallback: FrameyardErrorCode): FrameyardErrorCode {
  return isFrameyardError(error) ? error.code : fallback;
}
