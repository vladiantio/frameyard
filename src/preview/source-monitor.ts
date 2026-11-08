import type {
  CompositionDiagnostic,
  FrameyardHost,
  Props,
  ResolvedAudioClip,
  ResolvedCompositionMetadata,
  ResolvedTranscriptClip,
} from "../index.js";
import { COMPOSITION_FORMAT_UNRESOLVED_MESSAGE } from "../composition/index.js";
import { frameToMilliseconds } from "../runtime/index.js";
import { FrameyardError, type FrameyardDiagnostic, type FrameyardErrorCode } from "../errors.js";
import type { TimelinePreviewMediaSource, TimelinePreviewNestedSource } from "./timeline-data.js";

interface FrameyardFrame {
  __fy?: FrameyardHost;
  __fyError?: { code: string; message: string; diagnostics?: FrameyardDiagnostic[] };
  __fyTimeline?: NestedTimelineApi;
  __fyTimelineError?: { message?: string };
  JSON?: { parse(value: string): unknown };
}

interface NestedTimelineApi {
  ready: Promise<void>;
  durationInFrames: number;
  load(): Promise<void>;
  seek(frame: number): Promise<void>;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SourceCompositionEntry {
  id: string;
  entry: string;
  metadata?: ResolvedCompositionMetadata;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  diagnostics: CompositionDiagnostic[];
}

export interface LoadedCompositionState {
  metadata: ResolvedCompositionMetadata;
  props: Props;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  audioClips: ResolvedAudioClip[];
  embeddedAudioClips: ResolvedAudioClip[];
  transcriptClips: ResolvedTranscriptClip[];
  diagnostics: CompositionDiagnostic[];
}

export interface SourceMetadata {
  kind: "composition" | "timeline" | "video" | "image" | "audio";
  width: number;
  height: number;
  fps?: number;
  durationInFrames?: number;
  static?: boolean;
}

export interface SourceTransportElements {
  play: HTMLButtonElement;
  stepBack: HTMLButtonElement;
  stepForward: HTMLButtonElement;
  jumpBack: HTMLButtonElement;
  jumpForward: HTMLButtonElement;
  scrub: HTMLInputElement;
  frame: HTMLElement;
  duration: HTMLElement;
  clock: HTMLElement;
  mute: HTMLInputElement;
  volume: HTMLInputElement;
}

export interface SourceMonitorCallbacks {
  onMetadata?(metadata: SourceMetadata | null): void;
  onFrame?(frame: number): void;
  onDiagnostics?(diagnostics: readonly CompositionDiagnostic[]): void;
  onDocument?(document: Document): void;
  onKey?(event: KeyboardEvent): void;
  onError?(error: unknown): void;
  /** Called when this monitor starts playback, so the other monitor can pause. */
  onPlay?(): void;
}

export interface SourceMonitorOptions {
  frame: HTMLIFrameElement;
  stageWrap: HTMLElement;
  viewport: HTMLElement;
  scroll: HTMLElement;
  nestedFrame: HTMLIFrameElement;
  nestedWrap: HTMLElement;
  mediaHost: HTMLElement;
  empty: HTMLElement;
  transport: SourceTransportElements;
  /** Project frame rate used for media sources without their own rate. */
  defaultFps?: () => number;
  callbacks?: SourceMonitorCallbacks;
}

export type MonitorZoomMode = "fit" | "custom";

export interface MonitorZoom {
  readonly mode: MonitorZoomMode;
  readonly scale: number;
}

export interface SourceMonitor {
  readonly metadata: SourceMetadata | null;
  readonly frame: number;
  readonly host: FrameyardHost | null;
  readonly composition: SourceCompositionEntry | null;
  readonly document: Document | null;
  readonly naturalSize: { width: number; height: number } | null;
  readonly zoom: MonitorZoom;
  readonly canZoom: boolean;
  loadComposition(composition: SourceCompositionEntry, props?: unknown): Promise<LoadedCompositionState>;
  loadNestedTimeline(source: TimelinePreviewNestedSource, frame?: number): Promise<void>;
  loadMedia(source: TimelinePreviewMediaSource, frame?: number): Promise<void>;
  seek(frame: number): Promise<void> | void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
  step(delta: number): void;
  jump(deltaFrames: number): void;
  togglePlay(): void;
  pause(): void;
  setMuted(value: boolean): void;
  setVolume(value: number): void;
  refreshTransport(): void;
  layout(): void;
  fit(): void;
  actualSize(): void;
  zoomIn(): void;
  zoomOut(): void;
}

interface AudioEntry {
  clip: ResolvedAudioClip;
  element: HTMLAudioElement;
}

function mergeDiagnostics(...groups: Array<readonly CompositionDiagnostic[]>): CompositionDiagnostic[] {
  const seen = new Set<string>();
  const result: CompositionDiagnostic[] = [];
  for (const group of groups) {
    for (const diagnostic of group) {
      const key = JSON.stringify([
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.details ?? null,
      ]);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(diagnostic);
      }
    }
  }
  return result;
}

function assetUrl(src: string): string {
  return new URL(src.replace(/^\.\//, ""), `${window.location.origin}/`).href;
}
export function createSourceMonitor(options: SourceMonitorOptions): SourceMonitor {
  const callbacks = options.callbacks ?? {};
  const transport = options.transport;
  const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;

  let host: FrameyardHost | null = null;
  let composition: SourceCompositionEntry | null = null;
  let metadata: SourceMetadata | null = null;
  let audioClips: readonly ResolvedAudioClip[] = [];
  let embeddedAudioClips: readonly ResolvedAudioClip[] = [];
  let audioEntries: AudioEntry[] = [];
  let currentFrame = 0;
  let playing = false;
  let animationFrame = 0;
  let playStartFrame = 0;
  let playStartClock = 0;
  let masterVolume = Number(transport.volume.value) || 0.8;
  let muted = false;
  let loadSequence = 0;
  let loadQueue: Promise<unknown> = Promise.resolve();
  let nestedHost: FrameyardFrame["__fyTimeline"] | null = null;
  let mediaElement: HTMLImageElement | HTMLVideoElement | HTMLAudioElement | null = null;
  let sourceDiagnostics: CompositionDiagnostic[] = [];
  let inspectedDocument: Document | null = null;
  let zoomMode: MonitorZoomMode = "fit";
  let customZoom = 1;

  const setTransportEnabled = (enabled: boolean): void => {
    transport.play.disabled = !enabled;
    transport.stepBack.disabled = !enabled;
    transport.stepForward.disabled = !enabled;
    transport.jumpBack.disabled = !enabled;
    transport.jumpForward.disabled = !enabled;
    transport.scrub.disabled = !enabled;
  };

  const lastFrame = (): number => {
    if (!metadata || metadata.static === true || metadata.durationInFrames === undefined) {
      return 0;
    }
    return Math.max(0, metadata.durationInFrames - 1);
  };

  const updateTransport = (): void => {
    if (!metadata || metadata.static === true || metadata.durationInFrames === undefined) {
      transport.frame.textContent = "0";
      transport.duration.textContent = "0";
      transport.clock.textContent = "0.00s";
      transport.scrub.max = "0";
      transport.scrub.value = "0";
      transport.scrub.style.setProperty("--progress", "0%");
      return;
    }
    const last = lastFrame();
    transport.frame.textContent = String(currentFrame);
    transport.duration.textContent = String(last);
    transport.clock.textContent = `${(currentFrame / (metadata.fps ?? 30) || 0).toFixed(2)}s`;
    transport.scrub.max = String(last);
    transport.scrub.value = String(currentFrame);
    transport.scrub.style.setProperty("--progress", `${last > 0 ? (currentFrame / last) * 100 : 0}%`);
  };

  const canUseAudio = (): boolean =>
    metadata !== null &&
    metadata.static !== true &&
    (host !== null || mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement);

  const refreshTransport = (): void => {
    setTransportEnabled(
      metadata !== null &&
        metadata.static !== true &&
        metadata.durationInFrames !== undefined &&
        metadata.durationInFrames > 1,
    );
    transport.mute.disabled = !canUseAudio();
    transport.volume.disabled = !canUseAudio();
    updateTransport();
  };

  const naturalSize = (): { width: number; height: number } | null =>
    metadata === null ? null : { width: metadata.width, height: metadata.height };

  const fitScale = (): number => {
    const size = naturalSize();
    if (size === null) {
      return 1;
    }
    const availableWidth = Math.max(1, options.viewport.clientWidth - 32);
    const availableHeight = Math.max(1, options.viewport.clientHeight - 32);
    return Math.min(availableWidth / size.width, availableHeight / size.height, 1);
  };

  const effectiveScale = (): number => {
    if (zoomMode === "fit") {
      return fitScale();
    }
    return customZoom;
  };

  const setStageSize = (wrap: HTMLElement, frame: HTMLIFrameElement, size: { width: number; height: number }): void => {
    const scale = effectiveScale();
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.transform = `scale(${scale})`;
    wrap.style.width = `${size.width * scale}px`;
    wrap.style.height = `${size.height * scale}px`;
  };

  const layout = (): void => {
    const size = naturalSize();
    if (size === null) {
      return;
    }
    if (!options.stageWrap.hidden) {
      setStageSize(options.stageWrap, options.frame, size);
    }
    if (!options.nestedWrap.hidden) {
      setStageSize(options.nestedWrap, options.nestedFrame, size);
    }
    if (!options.mediaHost.hidden) {
      const scale = effectiveScale();
      options.mediaHost.style.width = `${size.width * scale}px`;
      options.mediaHost.style.height = `${size.height * scale}px`;
    }
  };

  const resetZoom = (): void => {
    zoomMode = "fit";
    customZoom = 1;
    options.scroll.scrollLeft = 0;
    options.scroll.scrollTop = 0;
    layout();
  };

  const zoomTo = (scale: number): void => {
    zoomMode = "custom";
    customZoom = Math.max(0.05, Math.min(4, scale));
    layout();
  };

  const updateVolumes = (): void => {
    const level = muted ? 0 : masterVolume;
    for (const entry of audioEntries) {
      entry.element.volume = Math.max(0, Math.min(1, entry.clip.volume * level));
    }
    if (mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement) {
      mediaElement.muted = muted;
      mediaElement.volume = Math.max(0, Math.min(1, masterVolume));
    }
  };

  const releaseAudio = (): void => {
    for (const entry of audioEntries) {
      entry.element.pause();
      entry.element.removeAttribute("src");
      entry.element.load();
    }
    audioEntries = [];
  };

  const buildAudio = (): void => {
    releaseAudio();
    if (!metadata) {
      return;
    }
    for (const clip of [...audioClips, ...embeddedAudioClips]) {
      const element = new Audio();
      element.preload = "auto";
      element.src = assetUrl(clip.src);
      element.load();
      audioEntries.push({ clip, element });
    }
    updateVolumes();
  };

  const stopAudio = (): void => {
    for (const entry of audioEntries) {
      entry.element.pause();
    }
  };

  const syncAudio = (): void => {
    if (!metadata || metadata.static === true || audioEntries.length === 0) {
      return;
    }
    const compositionTime = frameToMilliseconds(currentFrame, metadata.fps ?? 30);
    for (const { clip, element } of audioEntries) {
      const clipStart = frameToMilliseconds(clip.startFrame, metadata.fps ?? 30);
      const localTime = compositionTime - clipStart;
      const sourceDuration = Number.isFinite(element.duration)
        ? Math.max(0, element.duration - clip.trimStart)
        : Number.POSITIVE_INFINITY;
      const clipDuration = clip.trimDuration ?? sourceDuration;

      if (localTime < 0 || localTime >= clipDuration * 1000) {
        element.pause();
        const edge = localTime < 0 ? clip.trimStart : clip.trimStart + clipDuration;
        try {
          element.currentTime = edge;
        } catch {
          // Metadata may not be available yet; the next sync will retry.
        }
        continue;
      }

      const desiredTime = clip.trimStart + localTime / 1000;
      if (Math.abs(element.currentTime - desiredTime) > 0.12) {
        try {
          element.currentTime = desiredTime;
        } catch {
          // Ignore an unseekable element until metadata loads.
        }
      }

      if (playing) {
        if (element.paused) {
          void element.play().catch(() => {
            // Preview audio is best-effort until the user interacts with the page.
          });
        }
      } else if (!element.paused) {
        element.pause();
      }
    }
  };

  const stopPlayback = (): void => {
    playing = false;
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    transport.play.textContent = "\u25b6";
    transport.play.setAttribute("aria-label", "Play");
    stopAudio();
    if (mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement) {
      mediaElement.pause();
    }
  };

  const reportDiagnostics = (): void => {
    sourceDiagnostics = mergeDiagnostics(composition?.diagnostics ?? [], host?.diagnostics ?? []);
    callbacks.onDiagnostics?.(sourceDiagnostics);
  };

  const reportFrame = (): void => {
    updateTransport();
    callbacks.onFrame?.(currentFrame);
  };

  const renderCompositionFrame = (frame: number, settle: boolean): void => {
    const active = host;
    if (!active || !metadata) {
      throw new FrameyardError("COMPOSITION_ERROR", "No composition is loaded.");
    }
    const target = metadata.static === true ? 0 : frame;
    active.seek(target);
    currentFrame = target;
    syncAudio();
    reportDiagnostics();
    reportFrame();
    if (settle) {
      void active.settle().catch((error) => callbacks.onError?.(error));
    }
  };

  const playbackLoop = (): void => {
    if (!playing || !host || !metadata || metadata.static === true || metadata.durationInFrames === undefined) {
      return;
    }
    const elapsed = (performance.now() - playStartClock) / 1000;
    let target = Math.floor(playStartFrame + elapsed * (metadata.fps ?? 30));
    if (target >= metadata.durationInFrames) {
      target = metadata.durationInFrames - 1;
    }
    if (target !== currentFrame) {
      try {
        renderCompositionFrame(target, true);
      } catch (error) {
        stopPlayback();
        callbacks.onError?.(error);
        return;
      }
    }
    if (target >= metadata.durationInFrames - 1) {
      stopPlayback();
      return;
    }
    animationFrame = requestAnimationFrame(playbackLoop);
  };

  const startCompositionPlayback = (): void => {
    if (!host || !metadata || metadata.static === true || metadata.durationInFrames === undefined) {
      return;
    }
    callbacks.onPlay?.();
    if (currentFrame >= metadata.durationInFrames - 1) {
      renderCompositionFrame(0, true);
    }
    playing = true;
    playStartFrame = currentFrame;
    playStartClock = performance.now();
    transport.play.textContent = "\u275a\u275a";
    transport.play.setAttribute("aria-label", "Pause");
    syncAudio();
    animationFrame = requestAnimationFrame(playbackLoop);
  };

  const mediaFps = (): number => metadata?.fps ?? options.defaultFps?.() ?? 30;

  const mediaPlaybackLoop = (): void => {
    if (!playing) {
      return;
    }
    const media =
      mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement ? mediaElement : null;
    if (media === null || media.paused || media.ended) {
      stopPlayback();
      reportFrame();
      return;
    }
    currentFrame = Math.max(0, Math.floor(media.currentTime * mediaFps()));
    reportFrame();
    animationFrame = requestAnimationFrame(mediaPlaybackLoop);
  };

  const nestedPlaybackLoop = (): void => {
    if (!playing || !nestedHost || !metadata || metadata.durationInFrames === undefined) {
      return;
    }
    const elapsed = (performance.now() - playStartClock) / 1000;
    let target = Math.floor(playStartFrame + elapsed * mediaFps());
    if (target >= metadata.durationInFrames) {
      target = metadata.durationInFrames - 1;
    }
    if (target !== currentFrame) {
      currentFrame = target;
      void nestedHost.seek(target).then(
        () => reportFrame(),
        (error: unknown) => {
          stopPlayback();
          callbacks.onError?.(error);
        },
      );
    }
    if (target >= metadata.durationInFrames - 1) {
      stopPlayback();
      return;
    }
    animationFrame = requestAnimationFrame(nestedPlaybackLoop);
  };

  const clearVisuals = (): void => {
    options.frame.hidden = true;
    options.frame.style.width = "0px";
    options.frame.style.height = "0px";
    options.frame.removeAttribute("src");
    options.stageWrap.hidden = true;
    options.nestedFrame.hidden = true;
    options.nestedFrame.removeAttribute("src");
    options.nestedWrap.hidden = true;
    options.mediaHost.replaceChildren();
    options.mediaHost.hidden = true;
    options.mediaHost.style.width = "0px";
    options.mediaHost.style.height = "0px";
    options.empty.hidden = false;
    zoomMode = "fit";
    customZoom = 1;
  };

  const disposeComposition = async (): Promise<void> => {
    if (host) {
      const active = host;
      host = null;
      try {
        await active.dispose();
      } catch {
        // The host may already be disposed after a failed load.
      }
    }
    composition = null;
    inspectedDocument = null;
    sourceDiagnostics = [];
  };

  const disposeNested = async (): Promise<void> => {
    if (nestedHost) {
      const active = nestedHost;
      nestedHost = null;
      try {
        await active.dispose();
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  const disposeMedia = (): void => {
    if (mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement) {
      mediaElement.pause();
      mediaElement.removeAttribute("src");
      mediaElement.load();
    }
    mediaElement = null;
  };

  const teardown = async (): Promise<void> => {
    stopPlayback();
    releaseAudio();
    disposeMedia();
    await disposeComposition();
    await disposeNested();
    metadata = null;
    currentFrame = 0;
    audioClips = [];
    embeddedAudioClips = [];
    clearVisuals();
    refreshTransport();
    callbacks.onMetadata?.(null);
    callbacks.onDiagnostics?.([]);
    callbacks.onFrame?.(0);
  };

  const clonePropsForHost = (props: unknown): unknown => {
    if (props === undefined) {
      return undefined;
    }
    try {
      const serialized = JSON.stringify(props);
      const contentWindow = options.frame.contentWindow as
        | (Window & { JSON?: { parse(value: string): unknown } })
        | null;
      return contentWindow?.JSON ? contentWindow.JSON.parse(serialized) : JSON.parse(serialized);
    } catch {
      return props;
    }
  };

  const waitForHost = async (entry: string, loadToken: string): Promise<FrameyardHost> => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const contentWindow = options.frame.contentWindow as (Window & FrameyardFrame) | null;
      let currentToken: string | null = null;
      try {
        currentToken = contentWindow ? new URL(contentWindow.location.href).searchParams.get("__fy-load") : null;
      } catch {
        currentToken = null;
      }
      if (contentWindow && currentToken === loadToken) {
        if (contentWindow.__fyError) {
          throw new FrameyardError(
            contentWindow.__fyError.code as FrameyardErrorCode,
            contentWindow.__fyError.message,
            {
              diagnostics: contentWindow.__fyError.diagnostics,
            },
          );
        }
        if (contentWindow.__fy) {
          await contentWindow.__fy.ready;
          return contentWindow.__fy;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new FrameyardError("RENDER_FAILED", `Timed out waiting for composition "${entry}" to load.`);
  };

  const attachDocument = (document: Document): void => {
    if (inspectedDocument === document) {
      return;
    }
    inspectedDocument = document;
    document.addEventListener("fy-diagnostic", () => reportDiagnostics());
    document.addEventListener("keydown", (event) => callbacks.onKey?.(event));
    document.addEventListener("keyup", (event) => callbacks.onKey?.(event));
    callbacks.onDocument?.(document);
  };

  const readHostState = (active: FrameyardHost): LoadedCompositionState => ({
    metadata: active.metadata,
    props: active.props,
    controller: active.controller,
    audioClips: [...active.audioClips],
    embeddedAudioClips: [...active.embeddedAudioClips],
    transcriptClips: [...active.transcriptClips],
    diagnostics: [...active.diagnostics],
  });

  const applyLoadedState = (loaded: LoadedCompositionState): void => {
    metadata = { kind: "composition", ...loaded.metadata };
    audioClips = loaded.audioClips;
    embeddedAudioClips = loaded.embeddedAudioClips;
    currentFrame = 0;
    buildAudio();
    refreshTransport();
    resetZoom();
    reportDiagnostics();
    callbacks.onMetadata?.(metadata);
    callbacks.onFrame?.(0);
  };

  const loadCompositionNow = async (next: SourceCompositionEntry, props?: unknown): Promise<LoadedCompositionState> => {
    stopPlayback();
    if (host && composition?.entry === next.entry) {
      await host.load({ props: clonePropsForHost(props) });
      composition = next;
      const loaded = readHostState(host);
      applyLoadedState(loaded);
      return loaded;
    }

    await teardown();
    if (!next.metadata) {
      const hasErrors = next.diagnostics.some((diagnostic) => diagnostic.severity === "error");
      if (!hasErrors) {
        throw new FrameyardError(
          "COMPOSITION_FORMAT_UNRESOLVED",
          `Composition "${next.id}": ${COMPOSITION_FORMAT_UNRESOLVED_MESSAGE}`,
        );
      }
      throw new FrameyardError("COMPOSITION_INVALID", `Composition "${next.id}" has no static metadata.`);
    }

    composition = next;
    metadata = { kind: "composition", ...next.metadata };
    options.stageWrap.hidden = false;
    options.frame.hidden = false;
    options.nestedWrap.hidden = true;
    options.mediaHost.hidden = true;
    options.empty.hidden = true;
    options.frame.style.width = `${next.metadata.width}px`;
    options.frame.style.height = `${next.metadata.height}px`;
    resetZoom();

    const url = new URL(next.entry, window.location.origin);
    url.searchParams.set("__fy-manual", "1");
    const loadToken = String(++loadSequence);
    url.searchParams.set("__fy-load", loadToken);
    options.frame.src = url.href;

    const active = await waitForHost(next.entry, loadToken);
    await active.load({ props: clonePropsForHost(props) });
    host = active;
    attachDocument(options.frame.contentDocument as Document);
    const loaded = readHostState(active);
    applyLoadedState(loaded);
    refreshTransport();
    return loaded;
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = loadQueue.then(task, task);
    loadQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const loadComposition = (next: SourceCompositionEntry, props?: unknown): Promise<LoadedCompositionState> =>
    enqueue(() => loadCompositionNow(next, props));

  const waitForNestedHost = async (loadToken: string): Promise<NestedTimelineApi> => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const contentWindow = options.nestedFrame.contentWindow as (Window & FrameyardFrame) | null;
      let currentToken: string | null = null;
      try {
        currentToken = contentWindow ? new URL(contentWindow.location.href).searchParams.get("__fy-load") : null;
      } catch {
        currentToken = null;
      }
      if (contentWindow && currentToken === loadToken) {
        if (contentWindow.__fyTimelineError) {
          throw new Error(contentWindow.__fyTimelineError.message ?? "Nested timeline failed to initialize.");
        }
        if (contentWindow.__fyTimeline) {
          await contentWindow.__fyTimeline.ready;
          return contentWindow.__fyTimeline;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for a nested timeline source.");
  };

  const loadNestedTimelineNow = async (source: TimelinePreviewNestedSource, frame = 0): Promise<void> => {
    await teardown();
    metadata = {
      kind: "timeline",
      width: source.timeline.format.width,
      height: source.timeline.format.height,
      fps: source.timeline.format.fps,
      durationInFrames: source.timeline.durationInFrames,
    };
    options.stageWrap.hidden = true;
    options.nestedWrap.hidden = false;
    options.nestedFrame.hidden = false;
    options.mediaHost.hidden = true;
    options.empty.hidden = true;
    options.nestedFrame.style.width = `${source.timeline.format.width}px`;
    options.nestedFrame.style.height = `${source.timeline.format.height}px`;
    const url = new URL(source.url, window.location.origin);
    const loadToken = String(++loadSequence);
    url.searchParams.set("__fy-load", loadToken);
    options.nestedFrame.src = url.href;
    resetZoom();
    const active = await waitForNestedHost(loadToken);
    await active.load();
    nestedHost = active;
    currentFrame = Math.max(0, Math.min(source.timeline.durationInFrames - 1, frame));
    await active.seek(currentFrame);
    refreshTransport();
    callbacks.onMetadata?.(metadata);
    callbacks.onFrame?.(currentFrame);
  };

  const loadMediaNow = async (source: TimelinePreviewMediaSource, frame = 0): Promise<void> => {
    await teardown();
    options.stageWrap.hidden = true;
    options.nestedWrap.hidden = true;
    options.mediaHost.hidden = false;
    options.mediaHost.replaceChildren();
    options.empty.hidden = true;

    if (source.kind === "image") {
      const image = document.createElement("img");
      image.alt = "";
      image.src = source.url;
      options.mediaHost.append(image);
      mediaElement = image;
      await image.decode().catch(() => undefined);
      metadata = {
        kind: "image",
        width: source.width ?? image.naturalWidth ?? 320,
        height: source.height ?? image.naturalHeight ?? 180,
      };
      currentFrame = 0;
    } else if (source.kind === "video") {
      const video = document.createElement("video");
      video.src = source.url;
      video.muted = false;
      video.playsInline = true;
      video.preload = "auto";
      video.controls = false;
      options.mediaHost.append(video);
      mediaElement = video;
      await new Promise<void>((resolve) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener("error", () => resolve(), { once: true });
      });
      const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
      const fps = options.defaultFps?.() ?? 30;
      metadata = {
        kind: "video",
        width: source.width ?? video.videoWidth ?? 320,
        height: source.height ?? video.videoHeight ?? 180,
        fps,
        durationInFrames: source.durationInFrames ?? Math.max(1, Math.round(durationSeconds * fps)),
      };
      currentFrame = Math.max(0, Math.min((metadata.durationInFrames ?? 1) - 1, frame));
      video.currentTime = currentFrame / fps + 0.001;
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "media-placeholder";
      const label = document.createElement("strong");
      label.textContent = "audio";
      const path = document.createElement("span");
      path.textContent = source.src;
      placeholder.append(label, path);
      options.mediaHost.append(placeholder);
      const audio = new Audio(source.url);
      audio.preload = "auto";
      mediaElement = audio;
      await new Promise<void>((resolve) => {
        audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
        audio.addEventListener("error", () => resolve(), { once: true });
      });
      const durationSeconds = Number.isFinite(audio.duration) ? audio.duration : 0;
      const fps = options.defaultFps?.() ?? 30;
      metadata = {
        kind: "audio",
        width: source.width ?? 320,
        height: source.height ?? 180,
        fps,
        durationInFrames: source.durationInFrames ?? Math.max(1, Math.round(durationSeconds * fps)),
      };
      currentFrame = Math.max(0, Math.min((metadata.durationInFrames ?? 1) - 1, frame));
      if (durationSeconds > 0) {
        audio.currentTime = currentFrame / fps + 0.001;
      }
    }

    updateVolumes();
    refreshTransport();
    resetZoom();
    callbacks.onMetadata?.(metadata);
    callbacks.onFrame?.(currentFrame);
  };

  const loadNestedTimeline = (source: TimelinePreviewNestedSource, frame = 0): Promise<void> =>
    enqueue(() => loadNestedTimelineNow(source, frame));

  const loadMedia = (source: TimelinePreviewMediaSource, frame = 0): Promise<void> =>
    enqueue(() => loadMediaNow(source, frame));

  const seek = (frame: number): Promise<void> | void => {
    if (!metadata) {
      throw new FrameyardError("COMPOSITION_ERROR", "No source is loaded.");
    }
    if (host) {
      // Let the host validate the requested frame so out-of-range seeks keep
      // their stable error code.
      renderCompositionFrame(metadata.static === true ? 0 : frame, true);
      return;
    }
    const target = metadata.static === true ? 0 : Math.max(0, Math.min(lastFrame(), Math.floor(frame)));
    if (nestedHost) {
      currentFrame = target;
      updateTransport();
      return nestedHost.seek(target).then(
        () => callbacks.onFrame?.(target),
        (error: unknown) => {
          callbacks.onError?.(error);
          throw error;
        },
      );
    }
    if (mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement) {
      currentFrame = target;
      updateTransport();
      try {
        mediaElement.currentTime = target / mediaFps() + 0.001;
      } catch {
        // Ignore an unseekable media element until metadata loads.
      }
      callbacks.onFrame?.(target);
      return;
    }
    currentFrame = target;
    updateTransport();
    callbacks.onFrame?.(target);
  };

  const settle = async (): Promise<void> => {
    if (host) {
      await host.settle();
      return;
    }
    if (nestedHost) {
      await nestedHost.settle();
      return;
    }
    if (mediaElement instanceof HTMLVideoElement && mediaElement.readyState < 2) {
      await new Promise<void>((resolve) => {
        mediaElement?.addEventListener("loadeddata", () => resolve(), { once: true });
        mediaElement?.addEventListener("error", () => resolve(), { once: true });
      });
    }
  };

  const step = (delta: number): void => {
    if (!metadata || metadata.static === true) {
      return;
    }
    stopPlayback();
    const target = Math.max(0, Math.min(lastFrame(), currentFrame + delta));
    if (target === currentFrame) {
      return;
    }
    try {
      void seek(target);
    } catch (error) {
      callbacks.onError?.(error);
    }
  };

  const jump = (deltaFrames: number): void => {
    step(deltaFrames);
  };

  const togglePlay = (): void => {
    if (!metadata || metadata.static === true) {
      return;
    }
    if (playing) {
      stopPlayback();
      syncAudio();
      return;
    }
    if (host) {
      startCompositionPlayback();
      return;
    }
    if (nestedHost && metadata.durationInFrames !== undefined) {
      callbacks.onPlay?.();
      if (currentFrame >= metadata.durationInFrames - 1) {
        void seek(0);
      }
      playing = true;
      playStartFrame = currentFrame;
      playStartClock = performance.now();
      transport.play.textContent = "\u275a\u275a";
      transport.play.setAttribute("aria-label", "Pause");
      animationFrame = requestAnimationFrame(nestedPlaybackLoop);
      return;
    }
    if (mediaElement instanceof HTMLVideoElement || mediaElement instanceof HTMLAudioElement) {
      callbacks.onPlay?.();
      if (
        metadata.durationInFrames !== undefined &&
        currentFrame >= metadata.durationInFrames - 1 &&
        mediaElement.duration > 0
      ) {
        mediaElement.currentTime = 0;
      }
      playing = true;
      transport.play.textContent = "\u275a\u275a";
      transport.play.setAttribute("aria-label", "Pause");
      void mediaElement.play().then(
        () => {
          animationFrame = requestAnimationFrame(mediaPlaybackLoop);
        },
        (error: unknown) => {
          stopPlayback();
          callbacks.onError?.(error);
        },
      );
    }
  };

  transport.play.addEventListener("click", togglePlay);
  transport.stepBack.addEventListener("click", () => step(-1));
  transport.stepForward.addEventListener("click", () => step(1));
  transport.jumpBack.addEventListener("click", () => jump(-Math.max(1, Math.round(metadata?.fps ?? 30))));
  transport.jumpForward.addEventListener("click", () => jump(Math.max(1, Math.round(metadata?.fps ?? 30))));
  transport.scrub.addEventListener("input", () => {
    stopPlayback();
    try {
      void seek(Number(transport.scrub.value));
    } catch (error) {
      callbacks.onError?.(error);
    }
  });
  transport.mute.addEventListener("change", () => {
    muted = transport.mute.checked;
    updateVolumes();
  });
  transport.volume.addEventListener("input", () => {
    masterVolume = Number(transport.volume.value);
    updateVolumes();
  });
  window.addEventListener("resize", layout);

  refreshTransport();

  return {
    get metadata() {
      return metadata;
    },
    get frame() {
      return currentFrame;
    },
    get host() {
      return host;
    },
    get composition() {
      return composition;
    },
    get document() {
      return options.frame.contentDocument;
    },
    get naturalSize() {
      return naturalSize();
    },
    get zoom(): MonitorZoom {
      return { mode: zoomMode, scale: effectiveScale() };
    },
    get canZoom() {
      return metadata !== null && metadata.kind !== "audio";
    },
    loadComposition,
    loadNestedTimeline,
    loadMedia,
    seek,
    settle,
    dispose: teardown,
    step,
    jump,
    togglePlay,
    pause() {
      if (playing) {
        stopPlayback();
        syncAudio();
      }
    },
    setMuted(value: boolean) {
      muted = value;
      transport.mute.checked = value;
      updateVolumes();
    },
    setVolume(value: number) {
      masterVolume = value;
      transport.volume.value = String(value);
      updateVolumes();
    },
    refreshTransport,
    layout,
    fit() {
      zoomMode = "fit";
      layout();
    },
    actualSize() {
      zoomTo(1);
    },
    zoomIn() {
      const current = effectiveScale();
      const next = ZOOM_STEPS.find((step) => step > current + 0.0001);
      zoomTo(next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4);
    },
    zoomOut() {
      const current = effectiveScale();
      const previous = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.0001);
      zoomTo(previous ?? ZOOM_STEPS[0] ?? 0.05);
    },
  };
}
