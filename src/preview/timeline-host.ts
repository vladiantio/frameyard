import { nextPaint, waitForVideoPaint } from "../runtime/video.js";
import { evaluatePresentation } from "../timeline/keyframes.js";
import { projectScene, type TimelineSceneLayer } from "../timeline/scene.js";
import type { TimelineTransform } from "../timeline/schema.js";
import { transitionProgress } from "../timeline/transitions.js";
import type { TimelinePreviewData, TimelinePreviewSource } from "./timeline-data.js";

interface FrameyardHostApi {
  readonly ready: Promise<void>;
  load(options?: { props?: unknown }): Promise<void>;
  seek(frame: number): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

interface TimelineHostApi {
  readonly ready: Promise<void>;
  load(): Promise<void>;
  seek(frame: number): Promise<void>;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

interface FrameyardFrame {
  __fy?: FrameyardHostApi;
  __fyError?: { message?: string };
  __fyTimeline?: TimelineHostApi;
  __fyTimelineError?: { message?: string };
  JSON?: { parse(value: string): unknown };
}

type TimelineLayer = TimelineSceneLayer<TimelinePreviewSource>;

interface Layer {
  scene: TimelineLayer;
  wrapper: HTMLDivElement;
  element: HTMLIFrameElement | HTMLVideoElement | HTMLImageElement;
  load: Promise<void>;
  lastActive: number;
}

export interface TimelineHostOptions {
  /** Stage background. Defaults to data.background or black. */
  background?: string;
  /** Maximum cached layer count. Defaults to 12. */
  maxCachedLayers?: number;
}

export interface TimelineHost {
  readonly format: TimelinePreviewData["format"];
  readonly durationInFrames: number;
  readonly frame: number;
  readonly ready: Promise<void>;
  load(): Promise<void>;
  seek(frame: number): Promise<void>;
  settle(): Promise<void>;
  /** Forward keydown events from composition and nested-timeline layers. */
  setKeyHandler(handler: ((event: KeyboardEvent) => void) | null): void;
  dispose(): Promise<void>;
}

function clipBox(
  transform: TimelineTransform,
  stage: { width: number; height: number },
): { width: number; height: number } {
  if (transform.width !== undefined && transform.height !== undefined) {
    return { width: transform.width, height: transform.height };
  }
  return { width: stage.width, height: stage.height };
}

function fitScale(
  transform: TimelineTransform,
  source: { width: number; height: number },
  box: { width: number; height: number },
): { x: number; y: number } {
  if (transform.fit === "stretch") {
    return {
      x: box.width / source.width,
      y: box.height / source.height,
    };
  }
  const contain = transform.fit === "contain";
  const raw = contain
    ? Math.min(box.width / source.width, box.height / source.height)
    : Math.max(box.width / source.width, box.height / source.height);
  return { x: raw, y: raw };
}

function applyClipPresentation(wrapper: HTMLDivElement, scene: TimelineLayer, frame: number, alpha = 1): void {
  const values = evaluatePresentation(scene.transform, scene.keyframes, frame - scene.clip.start);
  const scale = scene.transform.width === undefined ? values.scale : 1;
  wrapper.style.opacity = String(values.opacity * alpha);
  wrapper.style.transform = `translate(-50%, -50%) translate(${values.x}px, ${values.y}px) rotate(${values.rotation}deg) scale(${scale})`;
}

function waitFor<T>(predicate: () => T | undefined, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = (): void => {
      const value = predicate();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (performance.now() - started > timeout) {
        reject(new Error("Timed out waiting for a timeline source."));
        return;
      }
      setTimeout(tick, 16);
    };
    tick();
  });
}

function cloneProps(frame: HTMLIFrameElement, props: unknown): unknown {
  if (props === undefined) {
    return undefined;
  }
  const contentWindow = frame.contentWindow as unknown as FrameyardFrame | null;
  const serialized = JSON.stringify(props);
  return contentWindow?.JSON ? contentWindow.JSON.parse(serialized) : JSON.parse(serialized);
}

function pinLightColorScheme(frame: HTMLIFrameElement): void {
  const root = frame.contentDocument?.documentElement;
  if (!root) {
    return;
  }
  // `color-scheme` on the iframe element does not reach the embedded document.
  // A composition that declares a dark scheme would make Chromium paint an
  // opaque canvas base and hide every layer beneath it. Pin the embedded root
  // to the same light scheme as the production capture context.
  root.style.setProperty("color-scheme", "light", "important");
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) {
    video.pause();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    video.addEventListener(
      "loadeddata",
      () => {
        video.pause();
        resolve();
      },
      { once: true },
    );
    video.addEventListener("error", () => reject(new Error(`Could not load ${video.src}`)), { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) <= 0.001 && video.readyState >= 2) {
    return nextPaint();
  }
  // Register before the seek so the callback catches the frame this seek
  // presents, not a later one.
  const painted = waitForVideoPaint(video);
  return new Promise<void>((resolve, reject) => {
    let onSeeked: () => void;
    let onError: () => void;
    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    onSeeked = (): void => {
      cleanup();
      void painted.then(resolve, reject);
    };
    onError = (): void => {
      cleanup();
      reject(new Error(`Could not seek ${video.src}`));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

function sourceId(source: TimelinePreviewSource): string {
  return source.kind === "composition" || source.kind === "timeline" ? source.id : source.src;
}

export function createTimelineHost(
  stage: HTMLElement,
  data: TimelinePreviewData,
  options: TimelineHostOptions = {},
): TimelineHost {
  const maxCachedLayers = options.maxCachedLayers ?? 12;
  const stageSize = { width: data.format.width, height: data.format.height };
  stage.style.position = "relative";
  stage.style.width = `${stageSize.width}px`;
  stage.style.height = `${stageSize.height}px`;
  stage.style.overflow = "hidden";
  stage.style.background = options.background ?? data.background ?? "#000";
  // Blend modes must not reach the preview chrome behind the stage.
  stage.style.isolation = "isolate";

  const layers = new Map<string, Layer>();
  let currentFrame = 0;
  let keyHandler: ((event: KeyboardEvent) => void) | null = null;

  const disposeLayer = (layer: Layer): void => {
    const frame = layer.element instanceof HTMLIFrameElement ? layer.element : undefined;
    if (frame) {
      try {
        const win = frame.contentWindow as unknown as FrameyardFrame | null;
        void win?.__fy?.dispose?.();
        void win?.__fyTimeline?.dispose?.();
      } catch {
        // Preview cleanup is best-effort.
      }
    }
    layer.wrapper.remove();
    layers.delete(layer.scene.clip.id);
  };

  const ensureLayer = (scene: TimelineLayer): Layer => {
    const id = scene.clip.id;
    const existing = layers.get(id);
    if (existing) {
      existing.scene = scene;
      return existing;
    }

    const clip = scene.clip;
    const source = clip.source;
    const size = { width: scene.sourceWidth, height: scene.sourceHeight };
    const box = clipBox(scene.transform, stageSize);
    const fit = fitScale(scene.transform, size, box);
    const wrapper = document.createElement("div");
    wrapper.className = "timeline-layer";
    wrapper.dataset.clip = clip.id;
    wrapper.style.width = `${box.width}px`;
    wrapper.style.height = `${box.height}px`;
    wrapper.style.overflow = "hidden";
    wrapper.style.display = "none";
    wrapper.style.mixBlendMode = scene.blend === "normal" ? "" : scene.blend;
    applyClipPresentation(wrapper, scene, scene.clip.start);

    const place = (element: HTMLElement): void => {
      element.style.position = "absolute";
      element.style.left = "50%";
      element.style.top = "50%";
      element.style.transformOrigin = "center";
      element.style.transform = `translate(-50%, -50%) scale(${fit.x}, ${fit.y})`;
    };

    let element: HTMLIFrameElement | HTMLVideoElement | HTMLImageElement;
    let load: Promise<void>;

    if (scene.capture === "frames" || scene.capture === "still" || scene.capture === "nested") {
      const frame = document.createElement("iframe");
      // The layer is its own document; keydown there does not bubble to the preview.
      frame.addEventListener("load", () => {
        pinLightColorScheme(frame);
        frame.contentDocument?.addEventListener("keydown", (event) => keyHandler?.(event));
      });
      frame.src = source.url;
      frame.width = String(size.width);
      frame.height = String(size.height);
      frame.style.width = `${size.width}px`;
      frame.style.height = `${size.height}px`;
      frame.style.border = "0";
      // The preview pages are dark. Pin the iframe to light, matching the
      // production capture context, so Chromium does not paint a white base
      // behind transparent compositions.
      frame.style.colorScheme = "light";
      frame.title = `${source.kind} ${sourceId(source)}`;
      place(frame);
      wrapper.append(frame);
      stage.append(wrapper);
      element = frame;
      load = (async () => {
        const loaded = await waitFor(() => {
          const frameWindow = frame.contentWindow as unknown as FrameyardFrame | null;
          return (
            frameWindow?.__fy || frameWindow?.__fyTimeline || frameWindow?.__fyError || frameWindow?.__fyTimelineError
          );
        });
        if ("__fyError" in (loaded as object)) {
          throw new Error((loaded as { message?: string }).message ?? `${source.kind} failed to initialize.`);
        }
        pinLightColorScheme(frame);
        if (source.kind === "composition") {
          const api = await waitFor(() => (frame.contentWindow as unknown as FrameyardFrame | null)?.__fy);
          await api.ready;
          pinLightColorScheme(frame);
          await api.load({ props: cloneProps(frame, clip.props) });
        } else {
          const api = await waitFor(() => (frame.contentWindow as unknown as FrameyardFrame | null)?.__fyTimeline);
          await api.ready;
          pinLightColorScheme(frame);
          await api.load();
        }
      })();
    } else if (scene.capture === "video") {
      const video = document.createElement("video");
      video.src = source.url;
      video.width = size.width;
      video.height = size.height;
      video.style.width = `${size.width}px`;
      video.style.height = `${size.height}px`;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      place(video);
      wrapper.append(video);
      stage.append(wrapper);
      element = video;
      load = waitForVideo(video);
    } else {
      const image = document.createElement("img");
      image.src = source.url;
      image.width = size.width;
      image.height = size.height;
      image.style.width = `${size.width}px`;
      image.style.height = `${size.height}px`;
      image.alt = "";
      place(image);
      wrapper.append(image);
      stage.append(wrapper);
      element = image;
      load = image.decode().catch(() => undefined);
    }

    const layer: Layer = { scene, wrapper, element, load, lastActive: -1 };
    layers.set(id, layer);
    return layer;
  };

  const seek = async (target: number): Promise<void> => {
    const frame = Math.max(0, Math.min(data.durationInFrames - 1, Math.floor(target)));
    currentFrame = frame;
    const scene = projectScene(data, frame, frame + 1);
    const activeIds = new Set(scene.layers.map((layer) => layer.clip.id));
    const activeLayers = scene.layers.map(ensureLayer);
    await Promise.all(activeLayers.map((layer) => layer.load));

    for (const [index, layer] of activeLayers.entries()) {
      layer.lastActive = frame;
      layer.wrapper.style.display = "block";
      const transition = layer.scene.transition;
      const alpha = transition?.role === "in" ? transitionProgress(transition.window, frame) : 1;
      applyClipPresentation(layer.wrapper, layer.scene, frame, alpha);
      // Array order is composite order; the incoming clip already sorts above
      // the outgoing clip during a transition overlap.
      layer.wrapper.style.zIndex = String(index + 1);
      const localFrame = layer.scene.sourceStart;
      if (layer.scene.capture === "frames" || layer.scene.capture === "nested") {
        const contentWindow = (layer.element as HTMLIFrameElement).contentWindow as unknown as FrameyardFrame | null;
        if (!contentWindow) {
          continue;
        }
        if (layer.scene.clip.source.kind === "composition") {
          const api = contentWindow.__fy;
          if (api) {
            api.seek(localFrame);
            await api.settle();
          }
        } else {
          const api = contentWindow.__fyTimeline;
          if (api) {
            await api.seek(localFrame);
            await api.settle();
          }
        }
      } else if (layer.scene.capture === "video") {
        await seekVideo(layer.element as HTMLVideoElement, localFrame / data.format.fps + 0.001);
      }
    }

    for (const layer of layers.values()) {
      if (!activeIds.has(layer.scene.clip.id)) {
        layer.wrapper.style.display = "none";
      }
    }

    for (const clip of data.clips) {
      if (
        clip.source.kind !== "audio" &&
        clip.start > frame &&
        clip.start <= frame + data.format.fps * 2 &&
        !layers.has(clip.id)
      ) {
        const prefetchedScene = projectScene(data, clip.start, clip.start + 1);
        const sceneLayer = prefetchedScene.layers.find((candidate) => candidate.clip.id === clip.id);
        if (!sceneLayer) {
          continue;
        }
        const prefetched = ensureLayer(sceneLayer);
        void prefetched.load.catch(() => disposeLayer(prefetched));
      }
    }

    if (layers.size > maxCachedLayers) {
      const inactive = [...layers.values()]
        .filter((layer) => !activeIds.has(layer.scene.clip.id))
        .sort((left, right) => left.lastActive - right.lastActive);
      while (layers.size > maxCachedLayers && inactive.length > 0) {
        const layer = inactive.shift();
        if (layer) {
          disposeLayer(layer);
        }
      }
    }
  };

  return {
    format: data.format,
    durationInFrames: data.durationInFrames,
    get frame() {
      return currentFrame;
    },
    ready: Promise.resolve(),
    async load(): Promise<void> {
      // Layers are loaded on demand around the playhead.
    },
    seek,
    async settle(): Promise<void> {
      await nextPaint();
    },
    setKeyHandler(handler) {
      keyHandler = handler;
    },
    async dispose(): Promise<void> {
      for (const layer of Array.from(layers.values())) {
        disposeLayer(layer);
      }
    },
  };
}
