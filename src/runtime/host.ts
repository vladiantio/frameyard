import {
  readAnimationDeclarations,
  readCompositionDescriptor,
  readMediaDeclarations,
  readTranscriptDeclarations,
  type AnimationDeclaration,
} from "../composition/index.js";
import {
  isPlainObject,
  mergeProps,
  type CompositionDiagnostic,
  type CompositionMetadata,
  type ControllerDeclaration,
  type FrameyardHost,
  type Props,
  type ResolvedAudioClip,
  type ResolvedTranscriptClip,
} from "../contracts.js";
import {
  errorMessage,
  FrameyardError,
  isFrameyardError,
  type FrameyardDiagnostic,
  type FrameyardErrorCode,
} from "../errors.js";
import { applyBindings, applyPropVariables } from "./bindings.js";
import { frameToMilliseconds } from "./clock.js";
import { withDiagnosticsAsync, withDiagnosticsSync, type DiagnosticSink } from "./diagnostics.js";
import { createDomAdapter } from "./document-adapter.js";
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
  path: string;
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
  private readonly path: string;
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
    this.path = options.path;
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

      const animation = readAnimationDeclarations(createDomAdapter(this.root), {
        path: this.path,
        includeTemplateContent: false,
      });
      this.addDiagnostics(animation.diagnostics);
      this.assertNoReadErrors(animation.diagnostics);
      applyAnimationSchedule(animation.entries, this.metadata.fps);

      if (this.controllerModule?.mount) {
        await withDiagnosticsAsync("Composition mount()", this.diagnosticSink, () =>
          this.controllerModule?.mount?.({ root: this.root, props }),
        );
      }
      this.assertActive();
      this.mounted = true;

      await waitForAssets(this.root);
      this.assertActive();
      const media = readMediaDeclarations(createDomAdapter(this.root), {
        path: this.path,
        includeTemplateContent: false,
        props,
        bindingsApplied: true,
      });
      this.addDiagnostics(media.diagnostics);
      this.assertNoReadErrors(media.diagnostics);
      await prepareMedia(this.root);
      this.assertActive();
      this.audio = Object.freeze(media.audio.map((declaration) => declaration.clip));
      this.embedded = describeMediaAudio(this.root);

      const transcripts = readTranscriptDeclarations(createDomAdapter(this.root), {
        path: this.path,
        includeTemplateContent: false,
        props,
        bindingsApplied: true,
      });
      this.addDiagnostics(transcripts.diagnostics);
      this.assertNoReadErrors(transcripts.diagnostics);
      this.transcripts = Object.freeze(transcripts.declarations.map((declaration) => declaration.clip));
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

  private addDiagnostics(diagnostics: readonly CompositionDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.addDiagnostic(diagnostic);
    }
  }

  private assertNoReadErrors(diagnostics: readonly CompositionDiagnostic[]): void {
    const first = diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (first) {
      throw new FrameyardError(first.code, first.message, { diagnostics: [...diagnostics] });
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

async function importController(declaration: ControllerDeclaration | null): Promise<ControllerModule | null> {
  if (!declaration) {
    return null;
  }

  const url =
    declaration.kind === "external"
      ? new URL(declaration.rawSrc ?? declaration.src ?? "", document.baseURI).href
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

function applyAnimationSchedule(entries: readonly AnimationDeclaration<Node>[], fps: number): void {
  for (const entry of entries) {
    const element = entry.element;
    const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null;
    if (!style) {
      continue;
    }
    if (entry.startFrame !== undefined) {
      style.setProperty("animation-delay", `${entry.startFrame / fps}s`, "important");
    }
    if (entry.durationInFrames !== undefined) {
      style.setProperty("animation-duration", `${entry.durationInFrames / fps}s`, "important");
    }
    if (entry.easing !== undefined) {
      style.setProperty("animation-timing-function", entry.easing, "important");
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

export async function createFrameyardHost(): Promise<FrameyardHost> {
  await waitForDom();
  const path = decodeURIComponent(window.location.pathname).replace(/^\/+/, "");
  const read = readCompositionDescriptor(createDomAdapter(document), {
    path,
    resolvePath: (raw) => {
      const url = new URL(raw, document.baseURI);
      return decodeURIComponent(url.pathname).replace(/^\/+/, "");
    },
  });
  const firstError = read.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  const root = read.root;
  const metadata = read.descriptor.metadata;
  if (!read.valid || firstError !== undefined || root === null || metadata === null) {
    throw new FrameyardError(
      firstError?.code ?? "COMPOSITION_INVALID",
      firstError?.message ?? "Composition document is invalid.",
      { diagnostics: read.diagnostics },
    );
  }
  if (!(root instanceof HTMLElement)) {
    throw new FrameyardError("COMPOSITION_INVALID", "Composition document must contain one <fy-composition> root.", {
      diagnostics: read.diagnostics,
    });
  }

  const defaultProps = read.descriptor.defaultProps;
  const declaration = read.descriptor.controller;
  const controllerModule = await importController(declaration);
  const manual = new URLSearchParams(window.location.search).has("__fy-manual");
  const host = new HostRuntime({
    root,
    path,
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
    __fyError?: { code: string; message: string; diagnostics?: FrameyardDiagnostic[] };
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void createFrameyardHost().catch((error: unknown) => {
    const code: FrameyardErrorCode = isFrameyardError(error) ? error.code : "COMPOSITION_ERROR";
    const message = errorMessage(error);
    const diagnostics = isFrameyardError(error) ? error.diagnostics : undefined;
    window.__fyError = {
      code,
      message,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    };
    console.error(`[frameyard] ${message}`);
    document.dispatchEvent(new CustomEvent("fy-error", { detail: { code, message } }));
  });
}
