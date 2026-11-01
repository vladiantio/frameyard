import type {
  CompositionDiagnostic,
  CompositionMetadata,
  FrameyardHost,
  Props,
  ResolvedAudioClip,
  ResolvedTranscriptClip,
} from "../index.js";
import { frameToMilliseconds } from "../runtime/index.js";
import {
  FrameyardError,
  errorMessage,
  isFrameyardError,
  type FrameyardDiagnostic,
  type FrameyardErrorCode,
} from "../errors.js";

interface CompositionEntry {
  id: string;
  entry: string;
  metadata?: CompositionMetadata;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  diagnostics: CompositionDiagnostic[];
}

interface LoadedHostState {
  metadata: CompositionMetadata;
  props: Props;
  controller: { kind: "inline" } | { kind: "external"; src: string } | null;
  audioClips: ResolvedAudioClip[];
  embeddedAudioClips: ResolvedAudioClip[];
  transcriptClips: ResolvedTranscriptClip[];
  diagnostics: CompositionDiagnostic[];
}

interface AudioEntry {
  clip: ResolvedAudioClip;
  element: HTMLAudioElement;
}

interface PreviewApi {
  load(entry: string, props?: unknown): Promise<LoadedHostState>;
  seek(frame: number): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __frameyardPreview: PreviewApi;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Preview markup is missing #${id}.`);
  }
  return element as T;
}

const stageFrame = byId<HTMLIFrameElement>("stage-frame");
const stageWrap = byId<HTMLDivElement>("stage-wrap");
const viewport = byId<HTMLElement>("viewport");
const errorBox = byId<HTMLDivElement>("error");
const diagnosticsBox = byId<HTMLDivElement>("diagnostics");
const propsEditor = byId<HTMLTextAreaElement>("props");
const applyButton = byId<HTMLButtonElement>("apply");
const formatButton = byId<HTMLButtonElement>("format");
const compositionSelect = byId<HTMLSelectElement>("composition");
const timelineSelect = byId<HTMLSelectElement>("timeline");
const metaLabel = byId<HTMLDivElement>("meta");
const jumpBackButton = byId<HTMLButtonElement>("jump-back");
const stepBackButton = byId<HTMLButtonElement>("step-back");
const playButton = byId<HTMLButtonElement>("play");
const stepForwardButton = byId<HTMLButtonElement>("step-forward");
const jumpForwardButton = byId<HTMLButtonElement>("jump-forward");
const scrubber = byId<HTMLInputElement>("scrub");
const frameLabel = byId<HTMLSpanElement>("frame");
const durationLabel = byId<HTMLSpanElement>("duration");
const clockLabel = byId<HTMLSpanElement>("clock");
const muteCheckbox = byId<HTMLInputElement>("mute");
const volumeSlider = byId<HTMLInputElement>("volume");

let hostFrame: FrameyardHost | null = null;
let metadata: CompositionMetadata | null = null;
let audioClips: readonly ResolvedAudioClip[] = [];
let embeddedAudioClips: readonly ResolvedAudioClip[] = [];
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
let loadSequence = 0;
const entries = new Map<string, CompositionEntry>();

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

function setTransportEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  stepBackButton.disabled = !enabled;
  stepForwardButton.disabled = !enabled;
  jumpBackButton.disabled = !enabled;
  jumpForwardButton.disabled = !enabled;
  scrubber.disabled = !enabled;
}

function fitStage(): void {
  if (!metadata) {
    return;
  }

  const padding = 48;
  const availableWidth = Math.max(1, viewport.clientWidth - padding);
  const availableHeight = Math.max(1, viewport.clientHeight - padding);
  const scale = Math.min(availableWidth / metadata.width, availableHeight / metadata.height, 1);
  stageFrame.style.transform = `scale(${scale})`;
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

function renderFrame(frame: number, options: { settle?: boolean } = {}): void {
  const active = hostFrame;
  if (!active || !metadata) {
    throw new FrameyardError("COMPOSITION_ERROR", "No composition is loaded.");
  }

  try {
    active.seek(frame);
  } catch (error) {
    stopPlayback();
    showError(error);
    throw error;
  }

  currentFrame = frame;
  clearError();
  updateTransport();
  syncAudio();
  refreshDiagnostics();

  if (options.settle !== false) {
    void active.settle().catch((error) => {
      if (hostFrame !== active) {
        return;
      }
      stopPlayback();
      showError(error);
    });
  }
}

function playbackLoop(): void {
  if (!playing || !hostFrame || !metadata) {
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
  if (!hostFrame || !metadata || playing === value) {
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

function framesPerSecond(): number {
  return Math.max(1, Math.round(metadata?.fps ?? 1));
}

function stepFrame(delta: number): void {
  if (!hostFrame || !metadata) {
    return;
  }
  stopPlayback();
  const target = Math.max(0, Math.min(metadata.durationInFrames - 1, currentFrame + delta));
  if (target === currentFrame) {
    return;
  }
  try {
    renderFrame(target);
  } catch (error) {
    showError(error);
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  // Keys forwarded from the stage iframe carry elements from another realm,
  // where `instanceof HTMLElement` is false.
  if (!target || typeof (target as Element).tagName !== "string") {
    return false;
  }
  const element = target as HTMLElement;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

function handleTransportKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) {
    return;
  }
  const frames = event.shiftKey ? framesPerSecond() : 1;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepFrame(-frames);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    stepFrame(frames);
  }
}

async function teardown(): Promise<void> {
  stopPlayback();
  releaseAudio();
  setTransportEnabled(false);

  if (hostFrame) {
    const active = hostFrame;
    hostFrame = null;
    try {
      await active.dispose();
    } catch {
      // The host may already be disposed after a failed load.
    }
  }

  stageFrame.hidden = true;
  stageFrame.removeAttribute("src");
  stageFrame.style.width = "0px";
  stageFrame.style.height = "0px";
  metadata = null;
  audioClips = [];
  embeddedAudioClips = [];
  currentFrame = 0;
  diagnosticsBox.hidden = true;
  diagnosticsBox.replaceChildren();
  updateMeta();
  updateTransport();
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = loadQueue.then(task, task);
  loadQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadNow(entry: string, propOverrides?: unknown): Promise<LoadedHostState> {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new FrameyardError("COMPOSITION_INVALID", "A composition entry path is required.");
  }

  const composition = [...entries.values()].find((candidate) => candidate.entry === entry);
  if (!composition) {
    throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${entry}`);
  }

  if (hostFrame && selectedEntry === composition.entry) {
    clearError();
    return loadHtmlProps(composition, hostFrame, propOverrides);
  }

  await teardown();
  clearError();
  selectedEntry = composition.entry;
  return loadHtmlNow(composition, propOverrides);
}

async function loadHtmlNow(composition: CompositionEntry, propOverrides?: unknown): Promise<LoadedHostState> {
  if (!composition.metadata) {
    throw new FrameyardError("COMPOSITION_INVALID", `Composition "${composition.id}" has no static metadata.`);
  }

  stageFrame.hidden = false;
  metadata = composition.metadata;
  stageFrame.style.width = `${metadata.width}px`;
  stageFrame.style.height = `${metadata.height}px`;
  fitStage();
  updateMeta();

  const url = new URL(composition.entry, window.location.origin);
  url.searchParams.set("__fy-manual", "1");
  const loadToken = String(++loadSequence);
  url.searchParams.set("__fy-load", loadToken);
  stageFrame.src = url.href;

  const host = await waitForHost(composition, loadToken);
  await host.load({ props: clonePropsForHost(propOverrides) });
  hostFrame = host;
  stageFrame.contentDocument?.addEventListener("fy-diagnostic", () => refreshDiagnostics());

  const loaded = readHostState(host);
  applyLoadedHostState(composition, loaded);
  return loaded;
}

async function loadHtmlProps(
  composition: CompositionEntry,
  host: FrameyardHost,
  propOverrides?: unknown,
): Promise<LoadedHostState> {
  await host.load({ props: clonePropsForHost(propOverrides) });
  const loaded = readHostState(host);
  applyLoadedHostState(composition, loaded);
  return loaded;
}

function readHostState(host: FrameyardHost): LoadedHostState {
  return {
    metadata: host.metadata,
    props: host.props,
    controller: host.controller,
    audioClips: [...host.audioClips],
    embeddedAudioClips: [...host.embeddedAudioClips],
    transcriptClips: [...host.transcriptClips],
    diagnostics: [...host.diagnostics],
  };
}

function applyLoadedHostState(composition: CompositionEntry, loaded: LoadedHostState): void {
  metadata = loaded.metadata;
  audioClips = loaded.audioClips;
  embeddedAudioClips = loaded.embeddedAudioClips;
  currentFrame = 0;
  buildAudio();
  updateTransport();
  propsEditor.value = JSON.stringify(loaded.props, null, 2);
  selectedEntry = composition.entry;
  compositionSelect.value = composition.id;
  updateAudioVolumes();
  syncAudio();
  fitStage();
  refreshDiagnostics(loaded.diagnostics);
}

function clonePropsForHost(props: unknown): unknown {
  if (props === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(props);
    const contentWindow = stageFrame.contentWindow as (Window & { JSON?: { parse(value: string): unknown } }) | null;
    return contentWindow?.JSON ? contentWindow.JSON.parse(serialized) : JSON.parse(serialized);
  } catch {
    return props;
  }
}

async function waitForHost(composition: CompositionEntry, loadToken: string): Promise<FrameyardHost> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const contentWindow = stageFrame.contentWindow as
      | (Window & {
          __fy?: FrameyardHost;
          __fyError?: { code: string; message: string; diagnostics?: FrameyardDiagnostic[] };
        })
      | null;
    let currentToken: string | null = null;
    try {
      currentToken = contentWindow ? new URL(contentWindow.location.href).searchParams.get("__fy-load") : null;
    } catch {
      currentToken = null;
    }
    if (contentWindow && currentToken === loadToken) {
      if (contentWindow.__fyError) {
        throw new FrameyardError(contentWindow.__fyError.code as FrameyardErrorCode, contentWindow.__fyError.message, {
          diagnostics: contentWindow.__fyError.diagnostics,
        });
      }
      if (contentWindow.__fy) {
        await contentWindow.__fy.ready;
        return contentWindow.__fy;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new FrameyardError("RENDER_FAILED", `Timed out waiting for composition "${composition.id}" to load.`);
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

function refreshDiagnostics(runtimeDiagnostics?: readonly CompositionDiagnostic[]): void {
  const composition = selectedEntry
    ? [...entries.values()].find((candidate) => candidate.entry === selectedEntry)
    : undefined;
  const all = mergeDiagnostics(composition?.diagnostics ?? [], runtimeDiagnostics ?? hostFrame?.diagnostics ?? []);
  diagnosticsBox.hidden = all.length === 0;
  diagnosticsBox.replaceChildren(...all.map(renderDiagnostic));
}

function renderDiagnostic(diagnostic: CompositionDiagnostic): HTMLElement {
  const element = document.createElement("span");
  element.className = `diagnostic ${diagnostic.severity}`;
  const details = diagnostic.details;
  const location =
    details?.line !== undefined ? ` (${details.path ?? "composition"}:${details.line}:${details.column ?? 1})` : "";
  element.textContent = `${diagnostic.severity}: [${diagnostic.code}] ${diagnostic.message}${location}`;
  return element;
}

function isCompositionMetadata(value: unknown): value is CompositionMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.width === "number" &&
    typeof record.height === "number" &&
    typeof record.fps === "number" &&
    typeof record.durationInFrames === "number"
  );
}

function browserCommandError(error: unknown): Error {
  if (isFrameyardError(error)) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const api: PreviewApi = {
  load(entry: string, propOverrides?: unknown): Promise<LoadedHostState> {
    return enqueue(async () => {
      setTransportEnabled(false);
      try {
        return await loadNow(entry, propOverrides);
      } catch (error) {
        throw browserCommandError(error);
      } finally {
        setTransportEnabled(hostFrame !== null);
      }
    });
  },

  seek(frame: number): void {
    try {
      renderFrame(frame, { settle: false });
      if (playing) {
        playStartFrame = frame;
        playStartClock = performance.now();
      }
    } catch (error) {
      throw browserCommandError(error);
    }
  },

  async settle(): Promise<void> {
    try {
      if (!hostFrame) {
        throw new FrameyardError("COMPOSITION_ERROR", "No composition is loaded.");
      }
      await hostFrame.settle();
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
  setTransportEnabled(false);
  const response = await fetch("/__frameyard/project.json", { cache: "no-store" });
  if (!response.ok) {
    throw new FrameyardError("CONFIG_INVALID", `Could not load project.json (${response.status}).`);
  }
  const data = (await response.json()) as {
    compositions?: Array<{
      id?: unknown;
      entry?: unknown;
      metadata?: unknown;
      controller?: unknown;
      diagnostics?: unknown;
    }>;
    timelines?: Array<{ id?: unknown; entry?: unknown }>;
  };

  const timelineIds = (data.timelines ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
  timelineSelect.replaceChildren();
  const openTimeline = document.createElement("option");
  openTimeline.value = "";
  openTimeline.textContent = timelineIds.length > 0 ? "Open timeline…" : "No timelines";
  timelineSelect.append(openTimeline);
  for (const id of timelineIds) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    timelineSelect.append(option);
  }
  timelineSelect.disabled = timelineIds.length === 0;
  timelineSelect.addEventListener("change", () => {
    if (timelineSelect.value) {
      window.location.href = `/__frameyard/timeline/${encodeURIComponent(timelineSelect.value)}`;
    }
  });

  if (!Array.isArray(data.compositions) || data.compositions.length === 0) {
    if (timelineIds.length > 0) {
      window.location.replace(`/__frameyard/timeline/${encodeURIComponent(timelineIds[0] as string)}`);
      return;
    }
    throw new FrameyardError("CONFIG_INVALID", "The project has no compositions or timelines.");
  }

  compositionSelect.replaceChildren();
  for (const item of data.compositions) {
    if (typeof item.id !== "string" || typeof item.entry !== "string") {
      continue;
    }
    const metadata = isCompositionMetadata(item.metadata) ? item.metadata : undefined;
    const controller =
      item.controller === null || item.controller === undefined
        ? null
        : (item.controller as CompositionEntry["controller"]);
    const diagnostics = Array.isArray(item.diagnostics) ? (item.diagnostics as CompositionDiagnostic[]) : [];
    entries.set(item.id, { id: item.id, entry: item.entry, metadata, controller, diagnostics });

    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = metadata ? `${item.id} — ${metadata.width}×${metadata.height} · ${metadata.fps} fps` : item.id;
    compositionSelect.append(option);
  }

  const requested = new URLSearchParams(window.location.search).get("composition");
  const firstId = entries.has(requested ?? "") ? (requested as string) : [...entries.keys()][0];
  if (!firstId) {
    throw new FrameyardError("CONFIG_INVALID", "The project has no usable compositions.");
  }
  const firstEntry = (entries.get(firstId) as CompositionEntry).entry;
  selectedEntry = firstEntry;
  compositionSelect.value = firstId;
  document.title = `${firstId} — Frameyard Preview`;

  playButton.addEventListener("click", () => setPlaying(!playing));
  stepBackButton.addEventListener("click", () => stepFrame(-1));
  stepForwardButton.addEventListener("click", () => stepFrame(1));
  jumpBackButton.addEventListener("click", () => stepFrame(-framesPerSecond()));
  jumpForwardButton.addEventListener("click", () => stepFrame(framesPerSecond()));
  // The stage is a separate document; keydown there does not reach this window.
  stageFrame.addEventListener("load", () => {
    stageFrame.contentDocument?.addEventListener("keydown", handleTransportKey);
  });
  window.addEventListener("keydown", handleTransportKey);
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
    const composition = entries.get(id);
    if (!composition) {
      return;
    }
    document.title = `${id} — Frameyard Preview`;
    void api.load(composition.entry).catch(showError);
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

void initPreview();
