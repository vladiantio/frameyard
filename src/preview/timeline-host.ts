import type {
  TimelinePreviewClip,
  TimelinePreviewData,
  TimelinePreviewSource,
  TimelinePreviewTransform,
} from "./timeline-data.js";

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

interface Layer {
  clip: TimelinePreviewClip;
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
  dispose(): Promise<void>;
}

function sourceSize(source: TimelinePreviewSource, data: TimelinePreviewData): { width: number; height: number } {
  if (source.kind === "composition" || source.kind === "timeline") {
    return { width: source.width, height: source.height };
  }
  return {
    width: source.width ?? data.format.width,
    height: source.height ?? data.format.height,
  };
}

function clipBox(
  transform: TimelinePreviewTransform,
  stage: { width: number; height: number },
): { width: number; height: number } {
  if (transform.width !== undefined && transform.height !== undefined) {
    return { width: transform.width, height: transform.height };
  }
  return { width: stage.width, height: stage.height };
}

function fitScale(
  transform: TimelinePreviewTransform,
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
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) <= 0.001 && video.readyState >= 2) {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    let onSeeked: () => void;
    let onError: () => void;
    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    onSeeked = (): void => {
      cleanup();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
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

  const visualClips = data.clips.filter((clip) => clip.source.kind !== "audio");
  const layers = new Map<string, Layer>();
  let currentFrame = 0;

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
    layers.delete(layer.clip.id);
  };

  const ensureLayer = (clip: TimelinePreviewClip): Layer => {
    const existing = layers.get(clip.id);
    if (existing) {
      return existing;
    }

    const source = clip.source;
    const size = sourceSize(source, data);
    const box = clipBox(clip.transform, stageSize);
    const fit = fitScale(clip.transform, size, box);
    const scale = clip.transform.width === undefined ? clip.transform.scale : 1;
    const wrapper = document.createElement("div");
    wrapper.className = "timeline-layer";
    wrapper.style.width = `${box.width}px`;
    wrapper.style.height = `${box.height}px`;
    wrapper.style.overflow = "hidden";
    wrapper.style.display = "none";
    wrapper.style.opacity = String(clip.transform.opacity);
    wrapper.style.transform = `translate(-50%, -50%) translate(${clip.transform.x}px, ${clip.transform.y}px) rotate(${clip.transform.rotation}deg) scale(${scale})`;

    const place = (element: HTMLElement): void => {
      element.style.position = "absolute";
      element.style.left = "50%";
      element.style.top = "50%";
      element.style.transformOrigin = "center";
      element.style.transform = `translate(-50%, -50%) scale(${fit.x}, ${fit.y})`;
    };

    let element: HTMLIFrameElement | HTMLVideoElement | HTMLImageElement;
    let load: Promise<void>;

    if (source.kind === "composition" || source.kind === "timeline") {
      const frame = document.createElement("iframe");
      frame.src = source.url;
      frame.width = String(size.width);
      frame.height = String(size.height);
      frame.style.width = `${size.width}px`;
      frame.style.height = `${size.height}px`;
      frame.style.border = "0";
      // The preview pages are dark. Without this, Chromium gives an iframe that
      // inherits the dark color scheme a white base behind transparent
      // compositions.
      frame.style.colorScheme = "normal";
      frame.title = `${source.kind} ${source.id}`;
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
        if (source.kind === "composition") {
          const api = await waitFor(() => (frame.contentWindow as unknown as FrameyardFrame | null)?.__fy);
          await api.ready;
          await api.load({ props: cloneProps(frame, clip.props) });
        } else {
          const api = await waitFor(() => (frame.contentWindow as unknown as FrameyardFrame | null)?.__fyTimeline);
          await api.ready;
          await api.load();
        }
      })();
    } else if (source.kind === "video") {
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

    const layer: Layer = { clip, wrapper, element, load, lastActive: -1 };
    layers.set(clip.id, layer);
    return layer;
  };

  const seek = async (target: number): Promise<void> => {
    const frame = Math.max(0, Math.min(data.durationInFrames - 1, Math.floor(target)));
    currentFrame = frame;
    const active = visualClips.filter((clip) => clip.start <= frame && frame < clip.end);
    const activeIds = new Set(active.map((clip) => clip.id));

    const activeLayers = active.map((clip) => ensureLayer(clip));
    await Promise.all(activeLayers.map((layer) => layer.load));

    for (const layer of activeLayers) {
      layer.lastActive = frame;
      layer.wrapper.style.display = "block";
      const clip = layer.clip;
      const localFrame = clip.sourceIn + (frame - clip.start);
      if (clip.source.kind === "composition" || clip.source.kind === "timeline") {
        const contentWindow = (layer.element as HTMLIFrameElement).contentWindow as unknown as FrameyardFrame | null;
        if (!contentWindow) {
          continue;
        }
        if (clip.source.kind === "composition") {
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
      } else if (clip.source.kind === "video") {
        await seekVideo(layer.element as HTMLVideoElement, localFrame / data.format.fps + 0.001);
      }
    }

    for (const layer of layers.values()) {
      if (!activeIds.has(layer.clip.id)) {
        layer.wrapper.style.display = "none";
      }
    }

    for (const clip of visualClips) {
      if (clip.start > frame && clip.start <= frame + data.format.fps * 2 && !layers.has(clip.id)) {
        const prefetched = ensureLayer(clip);
        void prefetched.load.catch(() => disposeLayer(prefetched));
      }
    }

    if (layers.size > maxCachedLayers) {
      const inactive = [...layers.values()]
        .filter((layer) => !activeIds.has(layer.clip.id))
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
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    },
    async dispose(): Promise<void> {
      for (const layer of Array.from(layers.values())) {
        disposeLayer(layer);
      }
    },
  };
}
