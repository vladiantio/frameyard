import type { CompositionMetadata, Props, ResolvedAudioClip } from "../index.js";
import {
  createCompositionRuntime,
  frameToMilliseconds,
  loadCompositionModule,
  type CompositionRuntime,
} from "../runtime/index.js";
import { FrameyardError, errorMessage, isFrameyardError } from "../errors.js";

interface PreviewLoadResult {
  metadata: CompositionMetadata;
  props: Props;
  audioClips: ResolvedAudioClip[];
}

interface PreviewApi {
  load(entry: string, props?: unknown): Promise<PreviewLoadResult>;
  seek(frame: number): void;
  dispose(): Promise<void>;
}

interface AudioEntry {
  clip: ResolvedAudioClip;
  element: HTMLAudioElement;
}

declare global {
  interface Window {
    __frameyardPreview: PreviewApi;
  }
}

const isRender = new URLSearchParams(window.location.search).get("render") === "1";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Preview markup is missing #${id}.`);
  }
  return element as T;
}

const stage = byId<HTMLDivElement>("stage");
const stageWrap = byId<HTMLDivElement>("stage-wrap");
const viewport = byId<HTMLElement>("viewport");
const errorBox = byId<HTMLDivElement>("error");
const propsEditor = byId<HTMLTextAreaElement>("props");
const applyButton = byId<HTMLButtonElement>("apply");
const formatButton = byId<HTMLButtonElement>("format");
const compositionSelect = byId<HTMLSelectElement>("composition");
const metaLabel = byId<HTMLDivElement>("meta");
const playButton = byId<HTMLButtonElement>("play");
const scrubber = byId<HTMLInputElement>("scrub");
const frameLabel = byId<HTMLSpanElement>("frame");
const durationLabel = byId<HTMLSpanElement>("duration");
const clockLabel = byId<HTMLSpanElement>("clock");
const muteCheckbox = byId<HTMLInputElement>("mute");
const volumeSlider = byId<HTMLInputElement>("volume");

let runtime: CompositionRuntime | null = null;
let metadata: CompositionMetadata | null = null;
let audioClips: readonly ResolvedAudioClip[] = [];
let audioEntries: AudioEntry[] = [];
let currentFrame = 0;
let playing = false;
let animationFrame = 0;
let playStartFrame = 0;
let playStartClock = 0;
let masterVolume = Number(volumeSlider.value) || 0.8;
let muted = false;
let lastError: string | null = null;
let selectedEntry: string | null = null;
let loadQueue: Promise<unknown> = Promise.resolve();
const entries = new Map<string, string>();

function showError(error: unknown): void {
  lastError = errorMessage(error);
  errorBox.hidden = false;
  errorBox.textContent = lastError;
  console.error(error);
}

function clearError(): void {
  lastError = null;
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function updateMeta(): void {
  if (!metadata) {
    metaLabel.textContent = "";
    return;
  }
  const seconds = metadata.durationInFrames / metadata.fps;
  metaLabel.textContent = `${metadata.width}×${metadata.height} · ${metadata.fps} fps · ${metadata.durationInFrames} frames · ${seconds.toFixed(2)}s`;
}

function updateTransport(): void {
  if (!metadata) {
    frameLabel.textContent = "0";
    durationLabel.textContent = "0";
    clockLabel.textContent = "0.00s";
    scrubber.max = "0";
    scrubber.value = "0";
    return;
  }
  frameLabel.textContent = String(currentFrame);
  durationLabel.textContent = String(metadata.durationInFrames - 1);
  clockLabel.textContent = `${(currentFrame / metadata.fps).toFixed(2)}s`;
  scrubber.max = String(metadata.durationInFrames - 1);
  scrubber.value = String(currentFrame);
}

function fitStage(): void {
  if (!metadata) {
    return;
  }

  if (isRender) {
    stage.style.transform = "none";
    stageWrap.style.width = "";
    stageWrap.style.height = "";
    return;
  }

  const padding = 48;
  const availableWidth = Math.max(1, viewport.clientWidth - padding);
  const availableHeight = Math.max(1, viewport.clientHeight - padding);
  const scale = Math.min(availableWidth / metadata.width, availableHeight / metadata.height, 1);
  stage.style.transform = `scale(${scale})`;
  stageWrap.style.width = `${metadata.width * scale}px`;
  stageWrap.style.height = `${metadata.height * scale}px`;
}

function assetUrl(src: string): string {
  return new URL(src.replace(/^\.\//, ""), `${window.location.origin}/`).href;
}

function updateAudioVolumes(): void {
  const level = muted ? 0 : masterVolume;
  for (const entry of audioEntries) {
    entry.element.volume = Math.max(0, Math.min(1, entry.clip.volume * level));
  }
}

function stopAudio(): void {
  for (const entry of audioEntries) {
    entry.element.pause();
  }
}

function releaseAudio(): void {
  for (const entry of audioEntries) {
    entry.element.pause();
    entry.element.removeAttribute("src");
    entry.element.load();
  }
  audioEntries = [];
}

function buildAudio(): void {
  releaseAudio();
  if (isRender || !metadata) {
    return;
  }

  for (const clip of audioClips) {
    const element = new Audio();
    element.preload = "auto";
    element.src = assetUrl(clip.src);
    element.load();
    audioEntries.push({ clip, element });
  }
  updateAudioVolumes();
}

function syncAudio(): void {
  if (!metadata || audioEntries.length === 0) {
    return;
  }

  const compositionTime = frameToMilliseconds(currentFrame, metadata.fps);

  for (const { clip, element } of audioEntries) {
    const clipStart = frameToMilliseconds(clip.startFrame, metadata.fps);
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
}

function stopPlayback(): void {
  playing = false;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  playButton.textContent = "\u25b6";
  playButton.setAttribute("aria-label", "Play");
  stopAudio();
}

function renderFrame(frame: number): void {
  if (!runtime || !metadata) {
    throw new FrameyardError("COMPOSITION_ERROR", "No composition is loaded.");
  }

  try {
    runtime.seek(frame);
  } catch (error) {
    stopPlayback();
    showError(error);
    throw error;
  }

  currentFrame = frame;
  clearError();
  updateTransport();
  syncAudio();
}

function playbackLoop(): void {
  if (!playing || !runtime || !metadata) {
    return;
  }

  const elapsed = (performance.now() - playStartClock) / 1000;
  let target = Math.floor(playStartFrame + elapsed * metadata.fps);
  if (target >= metadata.durationInFrames) {
    target = metadata.durationInFrames - 1;
  }

  if (target !== currentFrame) {
    try {
      renderFrame(target);
    } catch {
      stopPlayback();
      return;
    }
  }

  if (target >= metadata.durationInFrames - 1) {
    stopPlayback();
    return;
  }

  animationFrame = requestAnimationFrame(playbackLoop);
}

function setPlaying(value: boolean): void {
  if (!runtime || !metadata || playing === value) {
    return;
  }

  if (value) {
    if (currentFrame >= metadata.durationInFrames - 1) {
      renderFrame(0);
    }
    playing = true;
    playStartFrame = currentFrame;
    playStartClock = performance.now();
    playButton.textContent = "\u275a\u275a";
    playButton.setAttribute("aria-label", "Pause");
    syncAudio();
    animationFrame = requestAnimationFrame(playbackLoop);
  } else {
    stopPlayback();
    syncAudio();
  }
}

async function teardown(): Promise<void> {
  stopPlayback();
  releaseAudio();
  playButton.disabled = true;
  scrubber.disabled = true;
  if (runtime) {
    const active = runtime;
    runtime = null;
    await active.dispose();
  } else {
    stage.replaceChildren();
  }
  metadata = null;
  audioClips = [];
  currentFrame = 0;
  updateMeta();
  updateTransport();
  stage.style.width = "0px";
  stage.style.height = "0px";
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = loadQueue.then(task, task);
  loadQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadNow(entry: string, propOverrides?: unknown): Promise<PreviewLoadResult> {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new FrameyardError("COMPOSITION_INVALID", "A composition entry path is required.");
  }

  await teardown();
  clearError();

  const moduleUrl = new URL(entry, `${window.location.origin}/`);
  if (moduleUrl.origin !== window.location.origin) {
    throw new FrameyardError("COMPOSITION_INVALID", "Composition entry must be served from this project.");
  }

  const loadedComposition = await loadCompositionModule(moduleUrl.href);
  const loadedMetadata: CompositionMetadata = {
    width: loadedComposition.width,
    height: loadedComposition.height,
    fps: loadedComposition.fps,
    durationInFrames: loadedComposition.durationInFrames,
  };
  metadata = loadedMetadata;

  stage.style.width = `${loadedMetadata.width}px`;
  stage.style.height = `${loadedMetadata.height}px`;
  stage.style.transform = isRender ? "none" : "";
  fitStage();
  updateMeta();

  const active = await createCompositionRuntime({
    composition: loadedComposition,
    container: stage,
    props: propOverrides,
    ...(isRender
      ? {}
      : {
          diagnostics: (warning: string) => {
            console.warn(`[frameyard] ${warning}`);
          },
        }),
  });

  runtime = active;
  audioClips = active.audioClips;
  currentFrame = 0;
  buildAudio();
  updateTransport();
  propsEditor.value = JSON.stringify(active.props, null, 2);
  selectedEntry = entry;
  const idForEntry = [...entries].find(([, value]) => value === entry)?.[0];
  if (idForEntry) {
    compositionSelect.value = idForEntry;
  }
  updateAudioVolumes();
  syncAudio();
  fitStage();

  return {
    metadata: loadedMetadata,
    props: active.props as Props,
    audioClips: [...audioClips],
  };
}

function browserCommandError(error: unknown): Error {
  if (isFrameyardError(error)) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const api: PreviewApi = {
  load(entry: string, propOverrides?: unknown): Promise<PreviewLoadResult> {
    return enqueue(async () => {
      playButton.disabled = true;
      scrubber.disabled = true;
      try {
        return await loadNow(entry, propOverrides);
      } catch (error) {
        throw browserCommandError(error);
      } finally {
        playButton.disabled = runtime === null;
        scrubber.disabled = runtime === null;
      }
    });
  },
  seek(frame: number) {
    try {
      renderFrame(frame);
      if (playing) {
        playStartFrame = frame;
        playStartClock = performance.now();
      }
    } catch (error) {
      throw browserCommandError(error);
    }
  },
  dispose(): Promise<void> {
    return enqueue(async () => {
      try {
        await teardown();
        propsEditor.value = "";
        selectedEntry = null;
      } catch (error) {
        throw browserCommandError(error);
      }
    });
  },
};

window.__frameyardPreview = api;

async function initPreview(): Promise<void> {
  playButton.disabled = true;
  const response = await fetch("/__frameyard/project.json", { cache: "no-store" });
  if (!response.ok) {
    throw new FrameyardError("CONFIG_INVALID", `Could not load project.json (${response.status}).`);
  }
  const data = (await response.json()) as { compositions?: Array<{ id?: unknown; entry?: unknown }> };
  if (!Array.isArray(data.compositions) || data.compositions.length === 0) {
    throw new FrameyardError("CONFIG_INVALID", "The project has no compositions.");
  }

  compositionSelect.replaceChildren();
  for (const item of data.compositions) {
    if (typeof item.id !== "string" || typeof item.entry !== "string") {
      continue;
    }
    entries.set(item.id, item.entry);
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.id;
    compositionSelect.append(option);
  }

  const requested = new URLSearchParams(window.location.search).get("composition");
  const firstId = entries.has(requested ?? "") ? (requested as string) : [...entries.keys()][0];
  if (!firstId) {
    throw new FrameyardError("CONFIG_INVALID", "The project has no usable compositions.");
  }
  const firstEntry = entries.get(firstId) as string;
  selectedEntry = firstEntry;
  compositionSelect.value = firstId;
  document.title = `${firstId} — Frameyard Preview`;

  scrubber.disabled = true;
  playButton.addEventListener("click", () => setPlaying(!playing));
  scrubber.addEventListener("input", () => {
    stopPlayback();
    try {
      renderFrame(Number(scrubber.value));
    } catch (error) {
      showError(error);
    }
  });
  muteCheckbox.addEventListener("change", () => {
    muted = muteCheckbox.checked;
    updateAudioVolumes();
  });
  volumeSlider.addEventListener("input", () => {
    masterVolume = Number(volumeSlider.value);
    updateAudioVolumes();
  });
  window.addEventListener("resize", fitStage);

  compositionSelect.addEventListener("change", () => {
    const id = compositionSelect.value;
    const entry = entries.get(id);
    if (!entry) {
      return;
    }
    selectedEntry = entry;
    document.title = `${id} — Frameyard Preview`;
    void api.load(entry).catch(showError);
  });

  applyButton.addEventListener("click", () => {
    if (!selectedEntry) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsEditor.value.trim() || "{}");
    } catch (error) {
      showError(new FrameyardError("PROPS_INVALID", `Props are not valid JSON: ${errorMessage(error)}`));
      return;
    }
    void api.load(selectedEntry, parsed).catch(showError);
  });

  formatButton.addEventListener("click", () => {
    try {
      propsEditor.value = JSON.stringify(JSON.parse(propsEditor.value.trim() || "{}"), null, 2);
      clearError();
    } catch (error) {
      showError(new FrameyardError("PROPS_INVALID", `Props are not valid JSON: ${errorMessage(error)}`));
    }
  });

  try {
    await api.load(firstEntry);
  } catch (error) {
    showError(error);
  }
}

window.addEventListener("error", (event) => {
  if (event.error) {
    showError(event.error);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  showError(event.reason);
});

if (isRender) {
  document.body.classList.add("render");
  updateTransport();
} else {
  void initPreview();
}
