import {
  isPlainObject,
  mergeProps,
  normalizeAudioClip,
  normalizeTranscriptClip,
  type CompositionDiagnostic,
  type CompositionMetadata,
  type ControllerDeclaration,
  type FrameyardHost,
  type Props,
  type ResolvedAudioClip,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import { errorMessage, FrameyardError, isFrameyardError, type FrameyardErrorCode } from "../errors.js";
import { applyBindings, applyPropVariables } from "./bindings.js";
import { frameToMilliseconds } from "./clock.js";
import { withDiagnosticsAsync, withDiagnosticsSync, type DiagnosticSink } from "./diagnostics.js";
import { describeMediaAudio, prepareMedia, releaseMedia, settleMedia } from "./media.js";

interface ControllerMountContext {
  root: HTMLElement;
  props: Readonly<Props>;
}

interface ControllerUpdateContext {
  frame: number;
  props: Readonly<Props>;
  root: HTMLElement;
}

interface ControllerModule {
  mount?(context: ControllerMountContext): void | Promise<void>;
  update?(context: ControllerUpdateContext): void;
  dispose?(): void | Promise<void>;
  validateProps?(props: Readonly<Props>): void | string[];
}

interface HostRuntimeOptions {
  root: HTMLElement;
  metadata: CompositionMetadata;
  defaultProps: Readonly<Props>;
  declaration: ControllerDeclaration | null;
  controllerModule: ControllerModule | null;
  manual: boolean;
}

type HostDiagnosticSink = (diagnostic: CompositionDiagnostic) => void;

const FRAME_STATE_PROPERTIES = [
  "--fy-frame",
  "--fy-time",
  "--fy-progress",
  "--fy-fps",
  "--fy-duration",
  "--fy-duration-frames",
];

class HostRuntime implements FrameyardHost {
  readonly metadata: CompositionMetadata;
  readonly defaultProps: Readonly<Props>;
  readonly controller: FrameyardHost["controller"];

  private readonly root: HTMLElement;
  private readonly snapshot: HTMLElement;
  private readonly controllerModule: ControllerModule | null;
  private readonly manual: boolean;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private readyResolved = false;
  private readonly diagnosticsList: CompositionDiagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  props: Readonly<Props>;
  private currentFrame = 0;
  private loaded = false;
  private mounted = false;
  private disposed = false;
  private audio: readonly ResolvedAudioClip[] = Object.freeze([]);
  private embedded: readonly ResolvedAudioClip[] = Object.freeze([]);
  private transcripts: readonly ResolvedTranscriptClip[] = Object.freeze([]);
  private loadQueue: Promise<void> = Promise.resolve();
  private settleLoop: Promise<void> | null = null;
  private settleWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void; frame: number }> = [];

  private readonly diagnosticSink: DiagnosticSink = (message) => {
    this.addDiagnostic({ severity: "warning", code: "DETERMINISM_WARNING", message });
  };

  constructor(options: HostRuntimeOptions) {
    this.root = options.root;
    this.metadata = options.metadata;
    this.defaultProps = options.defaultProps;
    this.controllerModule = options.controllerModule;
    this.manual = options.manual;
    this.props = options.defaultProps;
    this.controller = options.declaration
      ? options.declaration.kind === "inline"
        ? { kind: "inline" }
        : { kind: "external", src: options.declaration.src ?? "" }
      : null;
    this.snapshot = options.root.cloneNode(true) as HTMLElement;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.load = this.load.bind(this);
    this.seek = this.seek.bind(this);
    this.settle = this.settle.bind(this);
    this.dispose = this.dispose.bind(this);
    this.hideRoot();
    this.pauseAllAnimations();
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get audioClips(): readonly ResolvedAudioClip[] {
    return this.audio;
  }

  get embeddedAudioClips(): readonly ResolvedAudioClip[] {
    return this.embedded;
  }

  get transcriptClips(): readonly ResolvedTranscriptClip[] {
    return this.transcripts;
  }

  get diagnostics(): readonly CompositionDiagnostic[] {
    return Object.freeze([...this.diagnosticsList]);
  }

  get frame(): number {
    return this.currentFrame;
  }

  markReady(): void {
    if (this.readyResolved) {
      return;
    }
    this.readyResolved = true;
    this.resolveReady();
    document.dispatchEvent(new CustomEvent("fy-ready", { detail: { manual: this.manual } }));
  }

  initialLoad(): Promise<void> {
    return this.loadNow({});
  }

  load(options: { props?: unknown } = {}): Promise<void> {
    const task = this.readyPromise.then(() => {
      const run = this.loadQueue.then(
        () => this.loadNow(options),
        () => this.loadNow(options),
      );
      this.loadQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
    return task.catch((error) => {
      throw toHostError(error);
    });
  }

  seek(frame: number): void {
    try {
      if (this.disposed) {
        throw new FrameyardError("COMPOSITION_DISPOSED", "Cannot seek a disposed composition host.");
      }
      if (!this.loaded) {
        throw new FrameyardError("COMPOSITION_NOT_READY", "Cannot seek before the composition has loaded.");
      }
      this.seekNow(frame);
    } catch (error) {
      this.addError(error, Number.isInteger(frame) ? frame : null);
      throw toHostError(error);
    }
  }

  settle(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        toHostError(new FrameyardError("COMPOSITION_DISPOSED", "Cannot settle a disposed composition host.")),
      );
    }
    if (!this.loaded) {
      return Promise.reject(
        toHostError(new FrameyardError("COMPOSITION_NOT_READY", "Cannot settle before the composition has loaded.")),
      );
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.settleWaiters.push({ resolve, reject, frame: this.currentFrame });
      this.settleLoop ??= this.runSettleLoop();
    });
    return promise.catch((error) => {
      this.addError(error, this.currentFrame);
      throw toHostError(error);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const error = new FrameyardError("COMPOSITION_DISPOSED", "Composition host was disposed.");
    for (const waiter of this.settleWaiters) {
      waiter.reject(error);
    }
    this.settleWaiters = [];
    await this.disposeCurrent();
    this.loaded = false;
    this.currentFrame = 0;
    this.audio = Object.freeze([]);
    this.embedded = Object.freeze([]);
    this.transcripts = Object.freeze([]);
    this.root.replaceChildren();
    this.hideRoot();
    this.clearFrameState();
  }

  private async loadNow(options: { props?: unknown }): Promise<void> {
    if (this.disposed) {
      throw new FrameyardError("COMPOSITION_DISPOSED", "Cannot load a disposed composition host.");
    }

    this.clearDiagnostics();
    let props: Readonly<Props>;
    try {
      props = resolveHostProps(this.defaultProps, options.props, this.controllerModule?.validateProps);
    } catch (error) {
      this.addError(error, null);
      throw error;
    }

    try {
      await this.disposeCurrent();
      this.assertActive();
      this.restoreSnapshot();
      this.hideRoot();
      this.props = props;
      applyPropVariables(this.root, props);
      setFrameState(this.metadata, 0);
      applyBindings({
        root: this.root,
        props,
        onDiagnostic: (diagnostic) => this.addDiagnostic(diagnostic),
      });
      applyAnimationSchedule(this.root, this.metadata.fps);

      if (this.controllerModule?.mount) {
        await withDiagnosticsAsync("Composition mount()", this.diagnosticSink, () =>
          this.controllerModule?.mount?.({ root: this.root, props }),
        );
      }
      this.assertActive();
      this.mounted = true;

      await waitForAssets(this.root);
      this.assertActive();
      await prepareMedia(this.root);
      this.assertActive();
      this.audio = collectAudioClips(this.root, (diagnostic) => this.addDiagnostic(diagnostic));
      this.embedded = describeMediaAudio(this.root);
      this.transcripts = collectTranscriptClips(this.root, (diagnostic) => this.addDiagnostic(diagnostic));
      checkAnimationDiagnostics(this.root, (diagnostic) => this.addDiagnostic(diagnostic));

      this.seekNow(0);
      await settleMedia(this.root, 0, this.metadata.fps);
      this.assertActive();
      this.loaded = true;
      this.showRoot();
    } catch (error) {
      this.loaded = false;
      this.hideRoot();
      this.addError(error, null);
      throw error;
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new FrameyardError("COMPOSITION_DISPOSED", "Composition host was disposed during load.");
    }
  }

  private async disposeCurrent(): Promise<void> {
    if (this.mounted && this.controllerModule?.dispose) {
      try {
        await withDiagnosticsAsync("Composition dispose()", this.diagnosticSink, () =>
          this.controllerModule?.dispose?.(),
        );
      } catch (error) {
        this.addError(error, null);
      }
    }
    this.mounted = false;
    releaseMedia(this.root);
    this.loaded = false;
  }

  private restoreSnapshot(): void {
    releaseMedia(this.root);
    this.root.replaceChildren(...Array.from(this.snapshot.childNodes, (child) => child.cloneNode(true)));
    for (const attribute of Array.from(this.root.attributes)) {
      this.root.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(this.snapshot.attributes)) {
      this.root.setAttribute(attribute.name, attribute.value);
    }
  }

  private seekNow(frame: number): void {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.metadata.durationInFrames) {
      throw new FrameyardError(
        "FRAME_OUT_OF_RANGE",
        `Frame ${frame} is outside the valid range 0..${this.metadata.durationInFrames - 1}.`,
      );
    }

    setFrameState(this.metadata, frame);
    if (this.controllerModule?.update) {
      const result = withDiagnosticsSync("Composition update()", frame, this.diagnosticSink, () =>
        this.controllerModule?.update?.({ frame, props: this.props, root: this.root }),
      ) as unknown;
      if (isThenable(result)) {
        throw new FrameyardError(
          "COMPOSITION_UPDATE_ASYNC",
          `Composition update() must be synchronous, but it returned a promise at frame ${frame}.`,
        );
      }
    }
    seekAnimations(this.root, frame, this.metadata.fps, () => {
      this.addDiagnostic({
        severity: "warning",
        code: "DETERMINISM_WARNING",
        message: "Composition uses CSS transitions; derive visual styles from frame and props instead.",
      });
    });
    this.currentFrame = frame;
  }

  private async runSettleLoop(): Promise<void> {
    try {
      while (this.settleWaiters.length > 0) {
        const waiters = this.settleWaiters;
        this.settleWaiters = [];
        const frame = waiters[waiters.length - 1]?.frame ?? this.currentFrame;
        try {
          await settleMedia(this.root, frame, this.metadata.fps);
          for (const waiter of waiters) {
            waiter.resolve();
          }
        } catch (error) {
          for (const waiter of waiters) {
            waiter.reject(error);
          }
        }
      }
    } finally {
      this.settleLoop = null;
      if (this.settleWaiters.length > 0) {
        this.settleLoop = this.runSettleLoop();
      }
    }
  }

  private addDiagnostic(diagnostic: CompositionDiagnostic): void {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
    if (this.diagnosticKeys.has(key)) {
      return;
    }
    this.diagnosticKeys.add(key);
    this.diagnosticsList.push(diagnostic);
    document.dispatchEvent(new CustomEvent("fy-diagnostic", { detail: diagnostic }));
  }

  private addError(error: unknown, frame: number | null): void {
    const code: FrameyardErrorCode = isFrameyardError(error) ? error.code : "COMPOSITION_ERROR";
    this.addDiagnostic({
      severity: "error",
      code,
      message: errorMessage(error),
      ...(frame !== null ? { details: { frame } } : {}),
    });
  }

  private clearDiagnostics(): void {
    this.diagnosticsList.length = 0;
    this.diagnosticKeys.clear();
  }

  private hideRoot(): void {
    this.root.setAttribute("data-fy-pending", "");
  }

  private showRoot(): void {
    this.root.removeAttribute("data-fy-pending");
  }

  private pauseAllAnimations(): void {
    for (const animation of this.root.getAnimations({ subtree: true })) {
      try {
        animation.pause();
        animation.currentTime = 0;
      } catch {
        // Best-effort: hidden content should not animate in real time.
      }
    }
  }

  private clearFrameState(): void {
    for (const property of FRAME_STATE_PROPERTIES) {
      document.documentElement.style.removeProperty(property);
    }
  }
}

function resolveHostProps(
  defaults: Readonly<Props>,
  overrides: unknown,
  validateProps: ControllerModule["validateProps"],
): Readonly<Props> {
  const merged = mergeProps(defaults, overrides);
  if (!validateProps) {
    return merged;
  }

  let errors: void | string[];
  try {
    errors = validateProps(merged);
  } catch (error) {
    throw new FrameyardError("PROPS_INVALID", `Props validation failed: ${errorMessage(error)}`, { cause: error });
  }
  if (errors !== undefined) {
    if (!Array.isArray(errors) || errors.some((item) => typeof item !== "string")) {
      throw new FrameyardError("PROPS_INVALID", "validateProps() must return void or an array of strings.");
    }
    if (errors.length > 0) {
      throw new FrameyardError("PROPS_INVALID", `Invalid props: ${errors.join("; ")}`);
    }
  }
  return merged;
}

async function waitForDom(): Promise<void> {
  if (document.readyState !== "loading") {
    return;
  }
  await new Promise<void>((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

function readMetadata(root: HTMLElement): CompositionMetadata {
  const width = readPositiveInteger(root, "width");
  const height = readPositiveInteger(root, "height");
  const fps = readPositiveNumber(root, "fps");
  const durationInFrames = readPositiveInteger(root, "duration-in-frames");
  return { width, height, fps, durationInFrames };
}

function readPositiveInteger(root: HTMLElement, attribute: string): number {
  const raw = root.getAttribute(attribute);
  if (raw === null) {
    throw new FrameyardError("COMPOSITION_INVALID", `Missing required "${attribute}" attribute on <fy-composition>.`);
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value <= 0) {
    throw new FrameyardError("COMPOSITION_INVALID", `"${attribute}" must be a positive integer; received "${raw}".`);
  }
  return value;
}

function readPositiveNumber(root: HTMLElement, attribute: string): number {
  const raw = root.getAttribute(attribute);
  if (raw === null) {
    throw new FrameyardError("COMPOSITION_INVALID", `Missing required "${attribute}" attribute on <fy-composition>.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new FrameyardError("COMPOSITION_INVALID", `"${attribute}" must be a positive number; received "${raw}".`);
  }
  return value;
}

function readDefaultProps(): Readonly<Props> {
  const blocks = document.querySelectorAll('script[type="application/json"][data-fy="props"]');
  if (blocks.length > 1) {
    throw new FrameyardError("PROPS_INVALID", 'A composition may contain at most one data-fy="props" block.');
  }
  const block = blocks[0];
  if (!block) {
    return Object.freeze({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.textContent ?? "");
  } catch (error) {
    throw new FrameyardError("PROPS_INVALID", `Invalid default props JSON: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new FrameyardError("PROPS_INVALID", 'The data-fy="props" block must contain a JSON object.');
  }
  return mergeProps(parsed as Props, undefined);
}

function readControllerDeclaration(): ControllerDeclaration | null {
  const blocks = document.querySelectorAll('script[type="text/fy-controller"]');
  if (blocks.length > 1) {
    throw new FrameyardError("CONTROLLER_INVALID", "A composition may declare at most one controller.");
  }
  const block = blocks[0];
  if (!block) {
    return null;
  }
  const src = block.getAttribute("src");
  const source = block.textContent ?? "";
  if (src !== null && source.trim().length > 0) {
    throw new FrameyardError("CONTROLLER_INVALID", "A controller must be either inline or external, not both.");
  }
  if (src === null && source.trim().length === 0) {
    throw new FrameyardError(
      "CONTROLLER_INVALID",
      "A controller must contain inline source or reference an external module with src.",
    );
  }
  if (src !== null) {
    return { kind: "external", src };
  }
  return { kind: "inline", source };
}

async function importController(declaration: ControllerDeclaration | null): Promise<ControllerModule | null> {
  if (!declaration) {
    return null;
  }

  const url =
    declaration.kind === "external"
      ? new URL(declaration.src ?? "", document.baseURI).href
      : new URL("?__fy-controller", document.baseURI).href;

  let module: { default?: unknown };
  try {
    module = (await import(url)) as { default?: unknown };
  } catch (error) {
    throw new FrameyardError("CONTROLLER_INVALID", `Could not load controller ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!isPlainObject(module.default)) {
    throw new FrameyardError("CONTROLLER_INVALID", `Controller ${url} must default-export an object.`);
  }

  const controller = module.default as ControllerModule;
  for (const key of ["mount", "update", "dispose", "validateProps"] as const) {
    if (controller[key] !== undefined && typeof controller[key] !== "function") {
      throw new FrameyardError("CONTROLLER_INVALID", `Controller ${key} must be a function when provided.`);
    }
  }
  if (!controller.mount && !controller.update && !controller.validateProps) {
    throw new FrameyardError(
      "CONTROLLER_INVALID",
      "Controller must export at least one of mount(), update(), or validateProps().",
    );
  }
  if (controller.update && isAsyncFunction(controller.update)) {
    throw new FrameyardError(
      "CONTROLLER_INVALID",
      "Controller update() must be synchronous; finish asynchronous work in mount().",
    );
  }
  return controller;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAsyncFunction(value: unknown): boolean {
  return typeof value === "function" && Object.prototype.toString.call(value) === "[object AsyncFunction]";
}

function toHostError(error: unknown): Error {
  if (isFrameyardError(error)) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForAssets(root: HTMLElement): Promise<void> {
  await document.fonts.ready;
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (!image.currentSrc && !image.src) {
        return;
      }
      try {
        await image.decode();
      } catch (error) {
        throw new FrameyardError("ASSET_NOT_FOUND", `Could not load image asset "${image.currentSrc || image.src}".`, {
          cause: error,
        });
      }
    }),
  );
}

function animationElements(root: HTMLElement): Element[] {
  const selector = "[data-fy-anim-start], [data-fy-anim-duration], [data-fy-anim-easing]";
  return [...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector))];
}

function applyAnimationSchedule(root: HTMLElement, fps: number): void {
  for (const element of animationElements(root)) {
    const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null;
    if (!style) {
      continue;
    }
    const start = element.getAttribute("data-fy-anim-start");
    const duration = element.getAttribute("data-fy-anim-duration");
    const easing = element.getAttribute("data-fy-anim-easing");

    if (start !== null) {
      const frames = Number(start);
      if (!Number.isInteger(frames) || frames < 0) {
        throw new FrameyardError("ANIMATION_INVALID", "data-fy-anim-start must be a non-negative integer frame.");
      }
      style.setProperty("animation-delay", `${frames / fps}s`, "important");
    }
    if (duration !== null) {
      const frames = Number(duration);
      if (!Number.isInteger(frames) || frames <= 0) {
        throw new FrameyardError("ANIMATION_INVALID", "data-fy-anim-duration must be a positive integer frame.");
      }
      style.setProperty("animation-duration", `${frames / fps}s`, "important");
    }
    if (easing !== null) {
      if (easing.trim().length === 0) {
        throw new FrameyardError("ANIMATION_INVALID", "data-fy-anim-easing must not be empty.");
      }
      style.setProperty("animation-timing-function", easing, "important");
    }
  }
}

function checkAnimationDiagnostics(root: HTMLElement, sink: HostDiagnosticSink): void {
  for (const element of animationElements(root)) {
    const animations = element.getAnimations();
    if (animations.length === 0) {
      sink({
        severity: "warning",
        code: "ANIMATION_NOT_FOUND",
        message: "data-fy-anim-* is present but the element has no CSS animation.",
        details: { element: element.tagName.toLowerCase() },
      });
    } else if (animations.length > 1) {
      sink({
        severity: "warning",
        code: "ANIMATION_MULTIPLE",
        message: "data-fy-anim-* applies one schedule to every animation on the element.",
        details: { element: element.tagName.toLowerCase() },
      });
    }
  }
}

function seekAnimations(root: HTMLElement, frame: number, fps: number, onTransition: () => void): void {
  if (typeof root.getAnimations !== "function") {
    return;
  }

  const time = frameToMilliseconds(frame, fps);
  let sawTransition = false;

  for (const animation of root.getAnimations({ subtree: true })) {
    if (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition) {
      sawTransition = true;
    }
    try {
      animation.pause();
      animation.currentTime = time;
    } catch (error) {
      throw new FrameyardError(
        "COMPOSITION_ERROR",
        `A CSS or Web Animation could not be seeked to frame ${frame}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  if (sawTransition) {
    onTransition();
  }
}

function setFrameState(metadata: CompositionMetadata, frame: number): void {
  const root = document.documentElement;
  const progress = metadata.durationInFrames <= 1 ? 0 : frame / (metadata.durationInFrames - 1);
  root.style.setProperty("--fy-frame", String(frame));
  root.style.setProperty("--fy-time", String(frame / metadata.fps));
  root.style.setProperty("--fy-progress", String(progress));
  root.style.setProperty("--fy-fps", String(metadata.fps));
  root.style.setProperty("--fy-duration", String(metadata.durationInFrames / metadata.fps));
  root.style.setProperty("--fy-duration-frames", String(metadata.durationInFrames));
}

function collectAudioClips(root: HTMLElement, onDiagnostic: HostDiagnosticSink): readonly ResolvedAudioClip[] {
  const clips: ResolvedAudioClip[] = [];
  for (const element of Array.from(root.querySelectorAll("audio"))) {
    const src = element.getAttribute("src");
    if (src === null || src.length === 0) {
      continue;
    }
    const startFrame = readMediaInteger(element, "data-fy-start", 0);
    const trimStart = readMediaNumber(element, "data-fy-trim", 0);
    const trimDuration = readOptionalMediaNumber(element, "data-fy-duration");
    const volume = element.hasAttribute("muted") ? 0 : readMediaNumber(element, "data-fy-volume", 1);
    if (startFrame === undefined || trimStart === undefined || volume === undefined) {
      continue;
    }
    try {
      clips.push(
        normalizeAudioClip(
          {
            src,
            startFrame,
            trimStart,
            ...(trimDuration !== undefined ? { trimDuration } : {}),
            volume,
          },
          clips.length,
        ),
      );
    } catch (error) {
      onDiagnostic({
        severity: "warning",
        code: isFrameyardError(error) ? error.code : "MEDIA_INVALID",
        message: errorMessage(error),
      });
    }
  }
  return Object.freeze(clips);
}

function collectTranscriptClips(
  root: HTMLElement,
  onDiagnostic: HostDiagnosticSink,
): readonly ResolvedTranscriptClip[] {
  const clips: ResolvedTranscriptClip[] = [];
  for (const element of Array.from(root.querySelectorAll("fy-transcript"))) {
    const src = element.getAttribute("src");
    if (src === null || src.length === 0) {
      continue;
    }
    try {
      clips.push(normalizeTranscriptClip({ src, words: element.hasAttribute("words") }, clips.length));
    } catch (error) {
      onDiagnostic({
        severity: "warning",
        code: isFrameyardError(error) ? error.code : "TRANSCRIPT_INVALID",
        message: errorMessage(error),
      });
    }
  }
  return Object.freeze(clips);
}

function readMediaInteger(element: Element, attribute: string, fallback: number): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return /^\d+$/.test(raw.trim()) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readMediaNumber(element: Element, attribute: string, fallback: number): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOptionalMediaNumber(element: Element, attribute: string): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function createFrameyardHost(): Promise<FrameyardHost> {
  await waitForDom();
  const root = document.querySelector("fy-composition");
  if (!(root instanceof HTMLElement)) {
    throw new FrameyardError("COMPOSITION_INVALID", "Composition document must contain one <fy-composition> root.");
  }

  const metadata = readMetadata(root);
  const defaultProps = readDefaultProps();
  const declaration = readControllerDeclaration();
  const controllerModule = await importController(declaration);
  const manual = new URLSearchParams(window.location.search).has("__fy-manual");
  const host = new HostRuntime({
    root,
    metadata,
    defaultProps,
    declaration,
    controllerModule,
    manual,
  });

  window.__fy = host;
  if (manual) {
    host.markReady();
  } else {
    try {
      await host.initialLoad();
    } catch {
      // The host records the diagnostic; ready still resolves so callers can inspect it.
    }
    host.markReady();
  }
  return host;
}

declare global {
  interface Window {
    __fy: FrameyardHost;
    __fyError?: { code: string; message: string };
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void createFrameyardHost().catch((error: unknown) => {
    const code: FrameyardErrorCode = isFrameyardError(error) ? error.code : "COMPOSITION_ERROR";
    const message = errorMessage(error);
    window.__fyError = { code, message };
    console.error(`[frameyard] ${message}`);
    document.dispatchEvent(new CustomEvent("fy-error", { detail: { code, message } }));
  });
}
