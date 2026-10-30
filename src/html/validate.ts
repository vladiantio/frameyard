import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  KNOWN_DATA_FY_ATTRIBUTES,
  isAnimationAttribute,
  isLocalRelative,
  isMediaAttribute,
  isRemote,
  readAnimationDeclarations,
  readCompositionDescriptor,
  readMediaDeclarations,
  readTranscriptDeclarations,
  type AnimationDeclaration,
  type MediaDeclaration,
  type TranscriptDeclaration,
} from "../composition/index.js";
import {
  mergeProps,
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
import { createParse5Adapter } from "./document-adapter.js";
import {
  findElements,
  getAttribute,
  getAttributeLocation,
  getDocumentDoctype,
  getElementByTagName,
  getElementLocation,
  getNodeLocation,
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
  private fixedFactsValid = false;
  private overridesValid = false;
  private controllerFileValid = true;
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

    const adapter = createParse5Adapter(this.document);
    const read = readCompositionDescriptor(adapter, {
      path: this.entry,
      resolvePath: (raw) => this.resolveControllerPath(raw),
    });
    this.diagnostics.push(...read.diagnostics);
    this.fixedFactsValid = read.valid;
    const readRoot = read.root;
    this.root = readRoot !== null && isElement(readRoot) ? readRoot : null;
    this.metadata = read.descriptor.metadata;
    this.defaultPropsValue = read.descriptor.defaultProps;
    this.controller = read.descriptor.controller;
    this.mergeOverrides();
    await this.validateControllerFile();

    this.validateScripts();
    this.validateUnsupportedElements();
    this.validateDocumentAttributes();
    this.validateOutsideRoot();
    if (this.root) {
      this.validateBindings(this.root, 0);
    }

    const animation = readAnimationDeclarations(adapter, {
      path: this.entry,
      includeTemplateContent: true,
    });
    this.diagnostics.push(...animation.diagnostics);
    this.validateAnimationTargets(animation.entries);

    const media = readMediaDeclarations(adapter, {
      path: this.entry,
      includeTemplateContent: true,
      props: this.props,
    });
    this.diagnostics.push(...media.diagnostics);
    await this.validateMediaFiles(media.audio, media.embedded);

    const transcripts = readTranscriptDeclarations(adapter, {
      path: this.entry,
      includeTemplateContent: true,
      props: this.props,
    });
    this.diagnostics.push(...transcripts.diagnostics);
    await this.validateTranscriptFiles(transcripts.declarations);

    await this.validateOrdinaryAssets();

    const metadata = this.metadata;
    const root = this.root;
    const info: CompositionSourceInfo | null =
      metadata && root && this.fixedFactsValid && this.overridesValid && this.controllerFileValid && this.documentValid
        ? {
            metadata,
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

  private mergeOverrides(): void {
    try {
      this.props = mergeProps(this.defaultPropsValue, this.propsOverrides);
      this.overridesValid = true;
    } catch (error) {
      this.overridesValid = false;
      this.error("PROPS_INVALID", `Invalid props: ${errorMessage(error)}`);
      this.props = this.defaultPropsValue;
    }
  }

  private async validateControllerFile(): Promise<void> {
    const controller = this.controller;
    if (
      !controller ||
      controller.kind !== "external" ||
      controller.rawSrc === undefined ||
      controller.src === undefined
    ) {
      return;
    }

    const details: CompositionDiagnosticDetails = {
      path: this.entry,
      ...(controller.line !== undefined ? { line: controller.line, column: controller.column } : {}),
    };
    const resolved = await this.resolveLocalFile(
      controller.rawSrc,
      this.compositionDir,
      "CONTROLLER_INVALID",
      "Controller",
      details,
    );
    if (!resolved) {
      this.controllerFileValid = false;
      return;
    }
    this.controller = { ...controller, src: resolved.relative };
  }

  private resolveControllerPath(raw: string): string {
    return path.relative(this.projectRoot, path.resolve(this.compositionDir, raw)).split(path.sep).join("/");
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
      if (isAnimationAttribute(name) || isMediaAttribute(name)) {
        continue;
      }
      if (name.startsWith("data-fy-")) {
        this.error(
          "BINDING_INVALID",
          `Unknown Frameyard attribute "${name}". Known attributes: ${KNOWN_DATA_FY_ATTRIBUTES.join(", ")}.`,
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

  private validateAnimationTargets(entries: readonly AnimationDeclaration<HtmlNode>[]): void {
    for (const entry of entries) {
      if (!isElement(entry.element)) {
        continue;
      }
      const tag = entry.element.tagName;
      if (!NON_ANIMATED_ELEMENTS.has(tag)) {
        continue;
      }
      for (const attribute of entry.attributes) {
        if (attribute !== "data-fy-anim-start" && attribute !== "data-fy-anim-duration") {
          continue;
        }
        this.warning(
          "ANIMATION_NOT_FOUND",
          `${attribute} has no visual animation target on <${tag}>.`,
          this.attributeDetails(entry.element, attribute),
        );
      }
    }
  }

  private async validateMediaFiles(
    audio: readonly MediaDeclaration<HtmlNode>[],
    embedded: readonly MediaDeclaration<HtmlNode>[],
  ): Promise<void> {
    for (const declaration of audio) {
      if (await this.mediaFileExists(declaration)) {
        this.audioClips.push(declaration.clip);
      }
    }
    for (const declaration of embedded) {
      if (await this.mediaFileExists(declaration)) {
        this.embeddedAudioClips.push(declaration.clip);
      }
    }
  }

  private async mediaFileExists(declaration: MediaDeclaration<HtmlNode>): Promise<boolean> {
    if (!isElement(declaration.element)) {
      return false;
    }
    const file = await this.resolveLocalFile(
      declaration.clip.src,
      this.projectRoot,
      "MEDIA_INVALID",
      "Media",
      this.elementDetails(declaration.element),
    );
    return file !== null;
  }

  private async validateTranscriptFiles(declarations: readonly TranscriptDeclaration<HtmlNode>[]): Promise<void> {
    for (const declaration of declarations) {
      if (!isElement(declaration.element)) {
        continue;
      }
      const file = await this.resolveLocalFile(
        declaration.clip.src,
        this.projectRoot,
        "TRANSCRIPT_INVALID",
        "Transcript",
        this.elementDetails(declaration.element),
      );
      if (!file) {
        continue;
      }
      this.transcriptClips.push(declaration.clip);
      try {
        const content = await readFile(file.absolute, "utf8");
        const parsed: unknown = JSON.parse(content);
        parseTranscript(parsed, { requireWords: declaration.clip.words });
      } catch (error) {
        this.error(errorCode(error, "TRANSCRIPT_INVALID"), errorMessage(error), {
          path: file.relative,
          ...this.elementDetails(declaration.element),
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
