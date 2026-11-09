import type { CompositionDiagnostic, Props, ResolvedCompositionMetadata } from "../index.js";
import { errorMessage, FrameyardError, isFrameyardError } from "../errors.js";
import { createInspector, type InspectorRow, type InspectorSection } from "./inspector.js";
import {
  createSourceMonitor,
  type LoadedCompositionState,
  type SourceAudioDebug,
  type SourceCompositionEntry,
  type SourceMonitor,
  type SourceTransportElements,
} from "./source-monitor.js";
import { createTimelineMonitor, type TimelineMonitor, type TimelineTransportElements } from "./timeline-monitor.js";
import type { TimelinePreviewClip, TimelinePreviewData, TimelinePreviewMediaSource } from "./timeline-data.js";

interface ProjectTimelineEntry {
  id: string;
  entry: string;
}

interface ProjectData {
  format?: { width: number; height: number; fps: number } | null;
  compositions: SourceCompositionEntry[];
  timelines: ProjectTimelineEntry[];
}

interface PreviewApi {
  load(entry: string, props?: unknown): Promise<LoadedCompositionState>;
  seek(frame: number): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
  audioDebug(): SourceAudioDebug;
}

declare global {
  interface Window {
    __frameyardPreview: PreviewApi;
  }
}

type PreviewMode = "composition" | "timeline";
type SourceKind = "composition" | "clip" | "asset" | null;
type MonitorName = "source" | "program";
type PanelTab = "props" | "inspector";
type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "frameyard.preview.theme";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Preview markup is missing #${id}.`);
  }
  return element as T;
}

function browserCommandError(error: unknown): Error {
  if (isFrameyardError(error)) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isCompositionMetadata(value: unknown): value is ResolvedCompositionMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.width !== "number" || typeof record.height !== "number") {
    return false;
  }
  if (record.static === true) {
    return true;
  }
  return typeof record.fps === "number" && typeof record.durationInFrames === "number";
}

function assetKey(source: TimelinePreviewMediaSource): string {
  return `${source.kind}:${source.src}`;
}

function mediaSources(data: TimelinePreviewData | null): TimelinePreviewMediaSource[] {
  if (!data) {
    return [];
  }
  const assets = new Map<string, TimelinePreviewMediaSource>();
  for (const clip of data.clips) {
    const source = clip.source;
    if (source.kind === "video" || source.kind === "image" || source.kind === "audio") {
      assets.set(assetKey(source), source);
    }
  }
  for (const clip of data.audioClips) {
    const source: TimelinePreviewMediaSource = {
      kind: "audio",
      src: clip.src,
      url: clip.url,
    };
    assets.set(assetKey(source), source);
  }
  return [...assets.values()].sort((left, right) => left.src.localeCompare(right.src));
}

function compositionLastFrame(metadata: ResolvedCompositionMetadata | null): number {
  return metadata && metadata.static !== true ? Math.max(0, metadata.durationInFrames - 1) : 0;
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

async function fetchTimelineData(timelineId: string): Promise<TimelinePreviewData> {
  const response = await fetch(`/__frameyard/timeline/${encodeURIComponent(timelineId)}.json`, {
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Could not load timeline data (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) {
        message = body.error.message;
      }
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as TimelinePreviewData;
}

function parseFrame(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function bootPreview(): Promise<void> {
  const body = document.body;
  const mode: PreviewMode = body.dataset.previewMode === "timeline" ? "timeline" : "composition";
  const sourcePrimary = mode === "composition";
  const programPrimary = mode === "timeline";
  const sourceTransportId = (name: string): string => (sourcePrimary ? name : `source-${name}`);
  const programTransportId = (name: string): string => (programPrimary ? name : `timeline-${name}`);

  const metaLabel = byId<HTMLElement>("meta");
  const themeToggle = byId<HTMLElement>("theme-toggle");
  const compositionAssets = byId<HTMLElement>("composition-assets");
  const timelineAssets = byId<HTMLElement>("timeline-assets");
  const mediaAssets = byId<HTMLElement>("media-assets");
  const assetCount = byId<HTMLElement>("asset-count");
  const assetFilter = byId<HTMLInputElement>("asset-filter");
  const tabSource = byId<HTMLButtonElement>("tab-source");
  const tabProgram = byId<HTMLButtonElement>("tab-program");
  const closeSourceButton = byId<HTMLButtonElement>("close-source");
  const closeProgramButton = byId<HTMLButtonElement>("close-program");
  const monitorColumn = byId<HTMLElement>("monitor-column");
  const monitorPanel = byId<HTMLElement>("monitor-panel");
  const monitorEyebrow = byId<HTMLElement>("monitor-eyebrow");
  const monitorTitle = byId<HTMLElement>("monitor-title");
  const sourceView = byId<HTMLElement>("source-view");
  const programView = byId<HTMLElement>("program-view");
  const sourceViewport = byId<HTMLElement>("source-viewport");
  const programViewport = byId<HTMLElement>("program-viewport");
  const sourceScroll = document.querySelector<HTMLElement>('[data-monitor-scroll="source"]') as HTMLElement | null;
  const programScroll = document.querySelector<HTMLElement>('[data-monitor-scroll="program"]') as HTMLElement | null;
  if (sourceScroll === null || programScroll === null) {
    throw new Error("Preview markup is missing a monitor scroll container.");
  }
  const sourceScrollElement: HTMLElement = sourceScroll;
  const programScrollElement: HTMLElement = programScroll;
  const sourcePan = byId<HTMLElement>("source-pan");
  const programPan = byId<HTMLElement>("program-pan");
  const panToggle = byId<HTMLButtonElement>("pan-toggle");
  const zoomOut = byId<HTMLButtonElement>("zoom-out");
  const zoomIn = byId<HTMLButtonElement>("zoom-in");
  const zoomFit = byId<HTMLButtonElement>("zoom-fit");
  const zoomActual = byId<HTMLButtonElement>("zoom-actual");
  const zoomReadout = byId<HTMLElement>("zoom-readout");
  const fullscreenButton = byId<HTMLButtonElement>("monitor-fullscreen");
  const timelinePanel = byId<HTMLElement>("timeline");
  const timelineMeta = byId<HTMLElement>("timeline-meta");
  const timelineScroll = byId<HTMLElement>("timeline-scroll");
  const timelineInner = byId<HTMLElement>("timeline-inner");
  const timelineZoomOut = byId<HTMLButtonElement>("timeline-zoom-out");
  const timelineZoomIn = byId<HTMLButtonElement>("timeline-zoom-in");
  const timelineZoomFit = byId<HTMLButtonElement>("timeline-zoom-fit");
  const timelineZoomReadout = byId<HTMLElement>("timeline-zoom-readout");
  const propsEditor = byId<HTMLTextAreaElement>("props");
  const applyButton = byId<HTMLButtonElement>("apply");
  const formatButton = byId<HTMLButtonElement>("format");
  const propsReset = byId<HTMLButtonElement>("props-reset");
  const propsDirty = byId<HTMLElement>("props-dirty");
  const propsSyntax = byId<HTMLElement>("props-syntax");
  const propsHint = byId<HTMLElement>("props-hint");
  const propsView = byId<HTMLElement>("props-view");
  const inspectorView = byId<HTMLElement>("inspector-view");
  const inspectorEmpty = byId<HTMLElement>("inspector-empty");
  const inspectorHost = byId<HTMLElement>("inspector-host");
  const tabProps = byId<HTMLButtonElement>("tab-props");
  const tabInspector = byId<HTMLButtonElement>("tab-inspector");
  const errorBox = byId<HTMLDivElement>("error");
  const diagnosticsBox = byId<HTMLDivElement>("diagnostics");
  const monitorStatus = byId<HTMLElement>("monitor-status");
  const sourceEmpty = byId<HTMLElement>("source-empty");
  const programEmpty = byId<HTMLElement>("program-empty");

  const sourceElements: SourceTransportElements = {
    play: byId("play"),
    stepBack: byId(sourceTransportId("step-back")),
    stepForward: byId(sourceTransportId("step-forward")),
    jumpBack: byId(sourceTransportId("jump-back")),
    jumpForward: byId(sourceTransportId("jump-forward")),
    scrub: byId(sourceTransportId("scrub")),
    frame: byId(sourceTransportId("frame")),
    duration: byId(sourceTransportId("duration")),
    clock: byId(sourceTransportId("clock")),
    mute: byId(sourceTransportId("mute")),
    volume: byId(sourceTransportId("volume")),
  };
  const programElements: TimelineTransportElements = {
    play: byId("play-button"),
    stepBack: byId(programTransportId("step-back")),
    stepForward: byId(programTransportId("step-forward")),
    jumpBack: byId(programTransportId("jump-back")),
    jumpForward: byId(programTransportId("jump-forward")),
    scrub: byId(programTransportId("scrub")),
    frame: byId(programTransportId("frame")),
    duration: byId(programTransportId("duration")),
    clock: byId(programTransportId("clock")),
    mute: byId(programTransportId("mute")),
    volume: byId(programTransportId("volume")),
  };

  const compositions = new Map<string, SourceCompositionEntry>();
  const timelines = new Map<string, ProjectTimelineEntry>();
  let projectFormat: ProjectData["format"] = null;
  let sourceKind: SourceKind = null;
  let selectedCompositionId: string | null = null;
  let selectedTimelineId: string | null = null;
  let selectedClip: TimelinePreviewClip | null = null;
  let selectedMedia: TimelinePreviewMediaSource | null = null;
  let selectedElement: Element | null = null;
  let timelineData: TimelinePreviewData | null = null;
  let sourceDiagnostics: CompositionDiagnostic[] = [];
  let timelineDiagnostics: CompositionDiagnostic[] = [];
  let sourceError: unknown = null;
  let programError: unknown = null;
  let currentComposition: SourceCompositionEntry | null = null;
  let timelineQueue: Promise<unknown> = Promise.resolve();
  let activeMonitor: MonitorName = mode === "timeline" ? "program" : "source";
  let panelTab: PanelTab = "props";
  let themeMode: ThemeMode = "system";
  let propsBaseline = "";
  let frameTimer = 0;
  let applyingHistory = false;
  let panMode = false;
  let spaceDown = false;
  let panDrag: { pointerId: number; x: number; y: number; left: number; top: number; scroll: HTMLElement } | null =
    null;
  let syncingInspector = false;
  let sourceMonitor!: SourceMonitor;
  let timelineMonitor!: TimelineMonitor;

  const inspectedDocuments = new WeakSet<Document>();

  const inspector = createInspector({
    container: inspectorHost,
    onVisibilityChange(open) {
      if (syncingInspector) {
        return;
      }
      setPanelTab(open ? "inspector" : "props");
      inspectorEmpty.hidden = open;
    },
  });

  function sourceAvailable(): boolean {
    return sourceKind !== null;
  }

  function programAvailable(): boolean {
    return timelineData !== null;
  }

  function sourceTitleText(): string {
    if (sourceKind === "clip" && selectedClip) {
      return `clip · ${selectedClip.id} · ${selectedClip.source.kind}`;
    }
    if (sourceKind === "asset" && selectedMedia) {
      return `asset · ${selectedMedia.kind} · ${selectedMedia.src}`;
    }
    if (sourceKind === "composition" && selectedCompositionId) {
      return `composition · ${selectedCompositionId}`;
    }
    return "";
  }

  function updateMonitorHeader(): void {
    const source = activeMonitor === "source";
    monitorEyebrow.textContent = source ? "source" : "program";
    monitorTitle.textContent = source ? sourceTitleText() : (selectedTimelineId ?? "");
    updateZoomUi();
  }

  function updateZoomUi(): void {
    const source = activeMonitor === "source";
    const zoom = source ? sourceMonitor.zoom : timelineMonitor.zoom;
    const can = source ? sourceMonitor.canZoom : timelineMonitor.data !== null;
    zoomReadout.textContent = zoom.mode === "fit" ? "fit" : `${Math.round(zoom.scale * 100)}%`;
    zoomOut.disabled = !can;
    zoomIn.disabled = !can;
    zoomFit.disabled = !can;
    zoomActual.disabled = !can;
    panToggle.disabled = !can;
    fullscreenButton.disabled = !can && document.fullscreenElement !== monitorPanel;
    updatePanOverlay();
  }

  function updateTimelineZoomUi(zoom: number): void {
    timelineZoomReadout.textContent = `${Math.round(zoom * 100)}%`;
  }

  function updateTimelineTitle(): void {
    const program = selectedTimelineId ?? "";
    timelineMeta.textContent = timelineData
      ? `${timelineData.durationInFrames} frames · ${(timelineData.durationInFrames / timelineData.format.fps).toFixed(2)}s`
      : "";
    if (activeMonitor === "program") {
      monitorTitle.textContent = program;
    }
  }

  function updateMeta(): void {
    let label = "";
    if (activeMonitor === "source") {
      const metadata = sourceMonitor.metadata;
      if (metadata) {
        if (metadata.kind !== "composition") {
          label = `${metadata.width}×${metadata.height} · ${metadata.kind}`;
        } else if (metadata.static === true) {
          label = `${metadata.width}×${metadata.height} · static`;
        } else {
          label = `${metadata.width}×${metadata.height} · ${metadata.fps} fps · ${metadata.durationInFrames} frames · ${((metadata.durationInFrames ?? 0) / (metadata.fps ?? 30)).toFixed(2)}s`;
        }
      }
    }
    if (label.length === 0 && timelineData !== null) {
      label = `${timelineData.format.width}×${timelineData.format.height} · ${timelineData.format.fps} fps · ${timelineData.durationInFrames} frames · ${(timelineData.durationInFrames / timelineData.format.fps).toFixed(2)}s`;
    }
    metaLabel.textContent = label;
  }

  function setActiveMonitor(monitor: MonitorName): void {
    if (monitor === "source" && !sourceAvailable()) {
      if (programAvailable()) {
        monitor = "program";
      } else {
        return;
      }
    }
    if (monitor === "program" && !programAvailable()) {
      if (sourceAvailable()) {
        monitor = "source";
      } else {
        return;
      }
    }
    const wasVisible = monitor === "source" ? !sourceView.hidden : !programView.hidden;
    activeMonitor = monitor;
    const source = monitor === "source";
    sourceView.hidden = !source;
    programView.hidden = source;
    tabSource.setAttribute("aria-selected", String(source));
    tabProgram.setAttribute("aria-selected", String(!source));
    if (source) {
      timelineMonitor.pause();
      sourceMonitor.layout();
      if (!wasVisible) {
        sourceMonitor.refresh();
      }
    } else {
      sourceMonitor.pause();
      timelineMonitor.layout();
      if (!wasVisible) {
        timelineMonitor.refresh();
      }
    }
    updateMonitorHeader();
    updateMeta();
    refreshDiagnostics();
    updatePanOverlay();
  }

  function refreshAvailability(): void {
    tabSource.hidden = !sourceAvailable();
    tabProgram.hidden = !programAvailable();
    closeSourceButton.hidden = !(mode === "timeline" && sourceAvailable());
    closeProgramButton.hidden = !(mode === "composition" && programAvailable() && sourceAvailable());
    monitorColumn.classList.toggle("program-open", programAvailable());
    timelinePanel.hidden = !programAvailable();
    updateTimelineTitle();
    updateZoomUi();
    updateTimelineZoomUi(timelineMonitor.timelineZoom);
    if (activeMonitor === "source" && !sourceAvailable() && programAvailable()) {
      setActiveMonitor("program");
    } else if (activeMonitor === "program" && !programAvailable() && sourceAvailable()) {
      setActiveMonitor("source");
    } else if (activeMonitor === "source" && !sourceAvailable()) {
      sourceView.hidden = false;
      programView.hidden = true;
    }
  }

  function setPanelTab(tab: PanelTab): void {
    panelTab = tab;
    tabProps.setAttribute("aria-selected", String(tab === "props"));
    tabInspector.setAttribute("aria-selected", String(tab === "inspector"));
    propsView.hidden = tab !== "props";
    inspectorView.hidden = tab !== "inspector";
    inspectorEmpty.hidden = tab !== "inspector" || inspector.isOpen();
  }

  function closeInspectorForSelection(): void {
    if (inspector.isOpen()) {
      syncingInspector = true;
      inspector.hide();
      syncingInspector = false;
    }
    inspectorEmpty.hidden = true;
    setPanelTab("props");
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

  function activeDiagnostics(): CompositionDiagnostic[] {
    return activeMonitor === "source" ? sourceDiagnostics : timelineDiagnostics;
  }

  function activeError(): unknown {
    return activeMonitor === "source" ? sourceError : programError;
  }

  function refreshDiagnostics(): void {
    const diagnostics = activeDiagnostics();
    const error = activeError();
    const message = error === null ? "" : errorMessage(error);
    errorBox.hidden = message.length === 0;
    errorBox.textContent = message;
    diagnosticsBox.hidden = diagnostics.length === 0;
    diagnosticsBox.replaceChildren(...diagnostics.map(renderDiagnostic));
    monitorStatus.hidden = message.length === 0 && diagnostics.length === 0;
  }

  function showError(error: unknown, monitor: MonitorName = activeMonitor): void {
    if (monitor === "source") {
      sourceError = error;
      if (sourceAvailable()) {
        setActiveMonitor("source");
      }
    } else {
      programError = error;
      if (programAvailable()) {
        setActiveMonitor("program");
      }
    }
    refreshAvailability();
    refreshDiagnostics();
    console.error(error);
  }

  function clearError(monitor: MonitorName): void {
    if (monitor === "source") {
      sourceError = null;
    } else {
      programError = null;
    }
    refreshDiagnostics();
  }

  function resolvePropPath(props: Readonly<Props> | undefined, path: string): unknown {
    let current: unknown = props;
    for (const key of path.split(".")) {
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  function formatInspectorValue(value: unknown): string {
    if (value === undefined) {
      return "—";
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function diagnosticsForElement(target: Element): CompositionDiagnostic[] {
    const tag = target.tagName.toLowerCase();
    const attributes = new Set([...target.attributes].map((attribute) => attribute.name));
    const values = new Set([...target.attributes].map((attribute) => attribute.value));
    return sourceDiagnostics.filter((diagnostic) => {
      const details = diagnostic.details;
      if (!details) {
        return false;
      }
      if (details.element === tag && (details.attribute === undefined || attributes.has(details.attribute))) {
        return true;
      }
      if (details.attribute !== undefined && attributes.has(details.attribute)) {
        return true;
      }
      return details.value !== undefined && values.has(details.value);
    });
  }

  function frameStateRows(): InspectorRow[] {
    const documentRoot = sourceMonitor.document?.documentElement;
    if (!documentRoot) {
      return [];
    }
    const style = sourceMonitor.document?.defaultView?.getComputedStyle(documentRoot);
    if (!style) {
      return [];
    }
    return ["--fy-frame", "--fy-time", "--fy-progress", "--fy-fps", "--fy-duration", "--fy-duration-frames"].map(
      (name) => ({ label: name, value: style.getPropertyValue(name).trim() || "—" }),
    );
  }

  function showElementInspector(target: Element): void {
    selectedElement = target;
    selectedClip = null;
    const composition = currentComposition;
    const tag = target.tagName.toLowerCase();
    const id = target.id.length > 0 ? `#${target.id}` : "";
    const classes = [...target.classList].map((name) => `.${name}`).join("");
    const metadata = sourceMonitor.metadata;
    const elementRows: InspectorRow[] = [
      { label: "tag", value: tag },
      { label: "id", value: target.id || "—" },
      { label: "classes", value: classes || "—" },
      { label: "frame", value: String(sourceMonitor.frame) },
      {
        label: "time",
        value:
          metadata && metadata.static !== true && metadata.fps !== undefined
            ? `${(sourceMonitor.frame / metadata.fps).toFixed(3)}s`
            : "—",
      },
    ];
    const bindingRows: InspectorRow[] = [...target.attributes]
      .filter((attribute) => attribute.name.startsWith("data-fy-"))
      .map((attribute) => ({
        label: attribute.name,
        value: `${attribute.value} → ${formatInspectorValue(resolvePropPath(sourceMonitor.host?.props, attribute.value))}`,
      }));
    const sections: InspectorSection[] = [
      { title: "element", rows: elementRows },
      ...(bindingRows.length > 0 ? [{ title: "bindings", rows: bindingRows }] : []),
      { title: "frame state", rows: frameStateRows() },
    ];
    const lastFrame = compositionLastFrame(
      metadata?.kind === "composition" ? (metadata as ResolvedCompositionMetadata) : null,
    );
    const copyText =
      composition === null || sourceKind !== "composition"
        ? undefined
        : `npx frameyard still ${composition.id} --frame ${sourceMonitor.frame}`;

    setActiveMonitor("source");
    setPanelTab("inspector");
    inspector.show({
      kind: "element",
      title: `<${tag}>`,
      ...(id.length > 0 || classes.length > 0 ? { subtitle: `${id}${classes}` } : {}),
      sections,
      diagnostics: diagnosticsForElement(target),
      actions: {
        jumpStart: () => {
          try {
            void sourceMonitor.seek(0);
          } catch (error) {
            showError(error, "source");
          }
        },
        jumpEnd: () => {
          try {
            void sourceMonitor.seek(lastFrame);
          } catch (error) {
            showError(error, "source");
          }
        },
        ...(copyText !== undefined ? { copyText } : {}),
        ...(composition !== null ? { sourceHref: `/${composition.entry.replace(/^\.\//, "")}` } : {}),
      },
    });
  }

  function showClipInspector(clip: TimelinePreviewClip): void {
    const source = clip.source;
    const sourceLabel = source.kind === "composition" || source.kind === "timeline" ? source.id : source.src;
    const rows: InspectorRow[] = [
      { label: "id", value: clip.id },
      { label: "track", value: clip.track },
      { label: "source", value: `${source.kind} · ${sourceLabel}` },
      { label: "start", value: String(clip.start) },
      { label: "duration", value: String(clip.duration) },
      { label: "end", value: String(clip.end) },
      { label: "sourceIn", value: String(clip.sourceIn) },
      { label: "props", value: formatInspectorValue(clip.props) },
      { label: "transform", value: formatInspectorValue(clip.transform) },
      { label: "keyframes", value: formatInspectorValue(clip.keyframes) },
      { label: "blend", value: clip.blend ?? "normal" },
      { label: "audio", value: formatInspectorValue(clip.audio) },
    ];
    const diagnostics = timelineDiagnostics.filter(
      (diagnostic) => diagnostic.details?.clip === clip.id || diagnostic.details?.value === clip.id,
    );
    const timelineId = selectedTimelineId;

    setPanelTab("inspector");
    inspector.show({
      kind: "clip",
      title: clip.id,
      subtitle: `${source.kind} · ${clip.track}`,
      sections: [{ title: "clip", rows }],
      diagnostics,
      actions: {
        jumpStart: () => {
          void timelineMonitor.seek(clip.start);
        },
        jumpEnd: () => {
          void timelineMonitor.seek(Math.max(clip.start, clip.end - 1));
        },
        ...(timelineId !== null
          ? { copyText: `npx frameyard still ${timelineId} --frame ${timelineMonitor.frame}` }
          : {}),
        sourceHref: source.url,
      },
    });
  }

  function refreshInspector(): void {
    if (!inspector.isOpen()) {
      return;
    }
    if (selectedClip !== null) {
      showClipInspector(selectedClip);
      return;
    }
    if (selectedElement !== null) {
      if (!selectedElement.isConnected) {
        selectedElement = null;
        syncingInspector = true;
        inspector.hide();
        syncingInspector = false;
        setPanelTab("props");
        return;
      }
      showElementInspector(selectedElement);
    }
  }

  function attachElementInspector(document: Document): void {
    if (inspectedDocuments.has(document)) {
      return;
    }
    inspectedDocuments.add(document);
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!target || typeof (target as Element).tagName !== "string") {
          return;
        }
        const element = target as Element;
        if (
          element === document.documentElement ||
          element === document.body ||
          element.tagName.toLowerCase() === "fy-composition"
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        showElementInspector(element);
      },
      true,
    );
    document.addEventListener("keydown", (event) => handleTransportKey(event, "source"));
  }

  function updateAssetSelection(): void {
    for (const element of document.querySelectorAll<HTMLElement>(".asset")) {
      const kind = element.dataset.assetKind;
      let selected = false;
      if (kind === "composition") {
        selected = element.dataset.assetId === selectedCompositionId && sourceKind !== "asset";
      } else if (kind === "timeline") {
        selected = element.dataset.assetId === selectedTimelineId;
      } else if (kind === "media") {
        selected = sourceKind === "asset" && element.dataset.assetSrc === selectedMedia?.src;
      }
      element.classList.toggle("selected", selected);
    }
  }

  function applyAssetFilter(): void {
    const query = assetFilter.value.trim().toLowerCase();
    for (const element of document.querySelectorAll<HTMLElement>(".asset")) {
      const text = element.textContent?.toLowerCase() ?? "";
      const src = element.dataset.assetSrc?.toLowerCase() ?? "";
      element.hidden = query.length > 0 && !text.includes(query) && !src.includes(query);
    }
  }

  function updateAssetCount(): void {
    assetCount.textContent = `${compositions.size + timelines.size} entries`;
  }

  function createCompositionThumb(entry: SourceCompositionEntry): HTMLElement {
    const thumb = document.createElement("span");
    thumb.className = "asset-thumb";
    const label = document.createElement("span");
    label.className = "asset-thumb-label";
    if (entry.metadata) {
      label.textContent =
        entry.metadata.static === true ? "static" : `${entry.metadata.width}×${entry.metadata.height}`;
    } else {
      label.textContent = "unresolved";
    }
    thumb.append(label);
    return thumb;
  }

  function createTimelineThumb(): HTMLElement {
    const thumb = document.createElement("span");
    thumb.className = "asset-thumb";
    const label = document.createElement("span");
    label.className = "asset-thumb-label";
    label.textContent = "timeline";
    thumb.append(label);
    return thumb;
  }

  function createMediaThumb(source: TimelinePreviewMediaSource): HTMLElement {
    const thumb = document.createElement("span");
    thumb.className = "asset-thumb";
    if (source.kind === "image") {
      const image = document.createElement("img");
      image.src = source.url;
      image.alt = "";
      image.loading = "lazy";
      thumb.append(image);
    } else if (source.kind === "video") {
      const video = document.createElement("video");
      video.src = `${source.url}#t=0.001`;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      thumb.append(video);
    } else {
      const label = document.createElement("span");
      label.className = "asset-thumb-label";
      label.textContent = "audio";
      thumb.append(label);
    }
    return thumb;
  }

  function assetButton(
    kind: "composition" | "timeline" | "media",
    id: string,
    name: string,
    sub: string,
    thumb: HTMLElement,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset";
    button.dataset.assetKind = kind;
    if (kind === "media") {
      button.dataset.assetSrc = id;
    } else {
      button.dataset.assetId = id;
    }
    const copy = document.createElement("span");
    copy.className = "asset-copy";
    const title = document.createElement("span");
    title.className = "asset-name";
    title.textContent = name;
    const detail = document.createElement("span");
    detail.className = "asset-sub";
    detail.textContent = sub;
    copy.append(title, detail);
    button.append(thumb, copy);
    button.title = `${name} · ${sub}`;
    button.addEventListener("click", onClick);
    return button;
  }

  function hint(text: string): HTMLElement {
    const element = document.createElement("span");
    element.className = "hint";
    element.textContent = text;
    return element;
  }

  function renderCatalog(): void {
    compositionAssets.replaceChildren();
    for (const composition of compositions.values()) {
      const sub = composition.metadata
        ? composition.metadata.static === true
          ? `${composition.metadata.width}×${composition.metadata.height} · static`
          : `${composition.metadata.fps} fps · ${composition.metadata.durationInFrames} frames`
        : composition.entry;
      compositionAssets.append(
        assetButton("composition", composition.id, composition.id, sub, createCompositionThumb(composition), () => {
          void openComposition(composition.id).catch((error: unknown) => showError(error, "source"));
        }),
      );
    }
    if (compositionAssets.childElementCount === 0) {
      compositionAssets.append(hint("no compositions"));
    }

    timelineAssets.replaceChildren();
    for (const timeline of timelines.values()) {
      timelineAssets.append(
        assetButton("timeline", timeline.id, timeline.id, timeline.entry, createTimelineThumb(), () => {
          void openTimeline(timeline.id).catch((error: unknown) => showError(error, "program"));
        }),
      );
    }
    if (timelineAssets.childElementCount === 0) {
      timelineAssets.append(hint("no timelines"));
    }

    renderMediaAssets();
    updateAssetCount();
    updateAssetSelection();
    applyAssetFilter();
  }

  function renderMediaAssets(): void {
    mediaAssets.replaceChildren();
    const sources = mediaSources(timelineData);
    for (const source of sources) {
      mediaAssets.append(
        assetButton(
          "media",
          source.src,
          source.src.split("/").pop() ?? source.src,
          `${source.kind} · ${source.src}`,
          createMediaThumb(source),
          () => {
            void openAsset(source).catch((error: unknown) => showError(error, "source"));
          },
        ),
      );
    }
    if (sources.length === 0) {
      mediaAssets.append(hint(timelineData ? "no media in this timeline" : "select a timeline"));
    }
    updateAssetSelection();
    applyAssetFilter();
  }

  function setPropsEditable(editable: boolean, hintText: string | null = null): void {
    propsEditor.readOnly = !editable;
    applyButton.disabled = !editable;
    propsHint.hidden = hintText === null;
    propsHint.textContent = hintText ?? "";
    if (!editable) {
      propsDirty.hidden = true;
      propsReset.disabled = true;
      propsSyntax.hidden = true;
    }
  }

  function setPropsBaseline(value: string, editable: boolean, hintText: string | null = null): void {
    propsBaseline = value;
    propsEditor.value = value;
    setPropsEditable(editable, hintText);
    updatePropsDirty();
    validatePropsSyntax();
  }

  function updatePropsDirty(): void {
    const dirty = !propsEditor.readOnly && propsEditor.value !== propsBaseline;
    propsDirty.hidden = !dirty;
    propsReset.disabled = !dirty;
  }

  function validatePropsSyntax(): void {
    const text = propsEditor.value.trim();
    if (text.length === 0) {
      propsSyntax.hidden = true;
      return;
    }
    try {
      JSON.parse(text);
      propsSyntax.hidden = true;
    } catch (error) {
      propsSyntax.hidden = false;
      propsSyntax.textContent = `invalid JSON: ${errorMessage(error)}`;
    }
  }

  sourceMonitor = createSourceMonitor({
    frame: byId("stage-frame"),
    stageWrap: byId("stage-wrap"),
    viewport: sourceViewport,
    scroll: sourceScrollElement,
    nestedFrame: byId("source-timeline-frame"),
    nestedWrap: byId("source-timeline-wrap"),
    mediaHost: byId("source-media"),
    empty: sourceEmpty,
    transport: sourceElements,
    defaultFps: () => timelineData?.format.fps ?? projectFormat?.fps ?? 30,
    callbacks: {
      onMetadata() {
        updateMeta();
        updateMonitorHeader();
        updateZoomUi();
      },
      onFrame() {
        if (!applyingHistory && mode === "composition") {
          scheduleFrameUrl();
        }
        refreshDiagnostics();
        refreshInspector();
        updateMeta();
        updateMonitorHeader();
      },
      onDiagnostics(diagnostics) {
        sourceDiagnostics = [...diagnostics];
        refreshDiagnostics();
      },
      onDocument(document) {
        attachElementInspector(document);
      },
      onKey(event) {
        handleTransportKey(event, "source");
      },
      onError(error) {
        showError(error, "source");
      },
      onPlay() {
        timelineMonitor.pause();
      },
    },
  });

  timelineMonitor = createTimelineMonitor({
    stage: byId("stage"),
    stageWrap: byId("program-stage-wrap"),
    viewport: programViewport,
    scroll: programScrollElement,
    timelineInner,
    timelineScroll,
    tracks: byId("tracks"),
    rulerScale: byId("ruler-scale"),
    playheadGrab: byId("playhead-grab"),
    empty: programEmpty,
    transport: programElements,
    callbacks: {
      onFrame() {
        if (!applyingHistory && mode === "timeline") {
          scheduleFrameUrl();
        }
        refreshDiagnostics();
        refreshInspector();
        updateMeta();
        updateMonitorHeader();
      },
      onSelectClip(clip) {
        void selectTimelineClip(clip).catch((error: unknown) => showError(error, "source"));
      },
      onKey(event) {
        handleTransportKey(event, "program");
      },
      onError(error) {
        showError(error, "program");
      },
      onDiagnostics(diagnostics) {
        timelineDiagnostics = [...diagnostics];
        refreshDiagnostics();
      },
      onPlay() {
        sourceMonitor.pause();
      },
      onActivateProgram() {
        setActiveMonitor("program");
      },
      onTimelineZoom(zoom) {
        updateTimelineZoomUi(zoom);
      },
    },
  });

  function scheduleFrameUrl(): void {
    if (applyingHistory) {
      return;
    }
    window.clearTimeout(frameTimer);
    frameTimer = window.setTimeout(() => {
      writeUrl(false);
    }, 120);
  }

  function buildUrl(): string {
    const url = new URL(window.location.href);
    url.hash = "";
    if (mode === "composition") {
      url.pathname = "/__frameyard/";
      url.search = "";
      if (selectedCompositionId !== null) {
        url.searchParams.set("composition", selectedCompositionId);
      }
      if (selectedTimelineId !== null) {
        url.searchParams.set("timeline", selectedTimelineId);
      }
      if (sourceKind !== null) {
        url.searchParams.set("frame", String(sourceMonitor.frame));
      }
      return url.href;
    }
    const id = selectedTimelineId ?? body.dataset.timelineId ?? "";
    url.pathname = `/__frameyard/timeline/${encodeURIComponent(id)}`;
    url.search = "";
    if (sourceKind === "composition" && selectedCompositionId !== null) {
      url.searchParams.set("composition", selectedCompositionId);
    }
    if (timelineData !== null) {
      url.searchParams.set("frame", String(timelineMonitor.frame));
    }
    return url.href;
  }

  function writeUrl(push: boolean): void {
    if (applyingHistory) {
      return;
    }
    const href = buildUrl();
    const current = `${window.location.pathname}${window.location.search}`;
    const next = new URL(href);
    if (current === `${next.pathname}${next.search}`) {
      return;
    }
    if (push) {
      window.history.pushState(null, "", href);
    } else {
      window.history.replaceState(null, "", href);
    }
  }

  function clampFrame(frame: number, duration: number): number {
    return Math.max(0, Math.min(Math.max(0, duration - 1), Math.floor(frame)));
  }

  interface OpenOptions {
    push?: boolean;
    frame?: number;
    switchMonitor?: boolean;
  }

  async function openComposition(
    id: string,
    props?: unknown,
    options: OpenOptions = {},
  ): Promise<LoadedCompositionState> {
    const composition = compositions.get(id);
    if (!composition) {
      throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${id}`);
    }
    selectedClip = null;
    selectedMedia = null;
    selectedElement = null;
    selectedCompositionId = id;
    currentComposition = composition;
    sourceKind = "composition";
    closeInspectorForSelection();
    refreshAvailability();
    updateMonitorHeader();
    updateAssetSelection();
    updateMeta();
    if (options.push === true) {
      writeUrl(true);
    } else {
      writeUrl(false);
    }
    const loaded = await sourceMonitor.loadComposition(composition, props);
    const baseline = JSON.stringify(loaded.props, null, 2);
    setPropsBaseline(baseline, true);
    if (options.switchMonitor !== false) {
      setActiveMonitor("source");
    }
    refreshAvailability();
    updateAssetSelection();
    updateMonitorHeader();
    updateMeta();
    refreshDiagnostics();
    clearError("source");
    if (options.frame !== undefined) {
      const duration =
        loaded.metadata.static === true
          ? 1
          : Math.max(
              1,
              (loaded.metadata as ResolvedCompositionMetadata & { durationInFrames: number }).durationInFrames,
            );
      try {
        await sourceMonitor.seek(clampFrame(options.frame, duration));
      } catch {
        // A stale frame in the URL falls back to frame zero through the host.
      }
    }
    if (options.push === true) {
      writeUrl(true);
    } else {
      writeUrl(false);
    }
    document.title =
      mode === "timeline" ? `${selectedTimelineId ?? id} — Frameyard Timeline` : `${id} — Frameyard Preview`;
    return loaded;
  }

  async function openCompositionByEntry(entry: string, props?: unknown): Promise<LoadedCompositionState> {
    const normalized = entry.replace(/^\.\//, "");
    const composition = [...compositions.values()].find(
      (candidate) => candidate.entry === entry || candidate.entry.replace(/^\.\//, "") === normalized,
    );
    if (!composition) {
      throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${entry}`);
    }
    return openComposition(composition.id, props, { push: false });
  }

  async function openTimelineNow(id: string, options: OpenOptions = {}): Promise<void> {
    if (!timelines.has(id)) {
      throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${id}" is not listed in fy.config.js.`);
    }
    const data = await fetchTimelineData(id);
    timelineData = data;
    timelineDiagnostics = data.diagnostics;
    selectedTimelineId = id;
    programError = null;
    closeInspectorForSelection();
    refreshAvailability();
    renderMediaAssets();
    updateAssetSelection();
    updateTimelineTitle();
    updateMeta();
    if (options.push === true) {
      writeUrl(true);
    } else {
      writeUrl(false);
    }
    try {
      await timelineMonitor.load(data);
    } catch (error) {
      await timelineMonitor.dispose();
      timelineData = null;
      timelineDiagnostics = [];
      selectedTimelineId = null;
      refreshAvailability();
      renderMediaAssets();
      refreshDiagnostics();
      throw error;
    }
    refreshAvailability();
    renderMediaAssets();
    updateAssetSelection();
    updateTimelineTitle();
    updateMeta();
    refreshDiagnostics();
    clearError("program");
    if (options.switchMonitor !== false) {
      setActiveMonitor("program");
    }
    if (options.frame !== undefined) {
      try {
        await timelineMonitor.seek(clampFrame(options.frame, data.durationInFrames));
      } catch {
        // A stale frame in the URL falls back to frame zero through the host.
      }
    }
    if (options.push === true) {
      writeUrl(true);
    } else {
      writeUrl(false);
    }
    if (mode === "timeline") {
      document.title = `${id} — Frameyard Timeline`;
    }
  }

  function openTimeline(id: string, options: OpenOptions = {}): Promise<void> {
    const run = timelineQueue.then(
      () => openTimelineNow(id, options),
      () => openTimelineNow(id, options),
    );
    timelineQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function openAsset(source: TimelinePreviewMediaSource): Promise<void> {
    selectedClip = null;
    selectedElement = null;
    selectedCompositionId = null;
    currentComposition = null;
    selectedMedia = source;
    sourceKind = "asset";
    closeInspectorForSelection();
    await sourceMonitor.loadMedia(source);
    setPropsBaseline("", false, "Select a composition to edit props.");
    setActiveMonitor("source");
    refreshAvailability();
    updateAssetSelection();
    updateMonitorHeader();
    refreshDiagnostics();
    updateMeta();
    clearError("source");
  }

  async function selectTimelineClip(clip: TimelinePreviewClip): Promise<void> {
    selectedClip = clip;
    selectedElement = null;
    selectedMedia = null;
    sourceKind = "clip";
    closeInspectorForSelection();
    if (clip.source.kind === "composition") {
      const composition = compositions.get(clip.source.id);
      if (!composition) {
        throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${clip.source.id}`);
      }
      selectedCompositionId = clip.source.id;
      currentComposition = composition;
      await sourceMonitor.loadComposition(composition, clip.props);
      await sourceMonitor.seek(clip.sourceIn);
    } else if (clip.source.kind === "timeline") {
      selectedCompositionId = null;
      currentComposition = null;
      await sourceMonitor.loadNestedTimeline(clip.source, clip.sourceIn);
    } else {
      selectedCompositionId = null;
      currentComposition = null;
      await sourceMonitor.loadMedia(clip.source, clip.sourceIn);
    }
    setPropsBaseline("", false, "Clip props are read-only in the inspector.");
    setActiveMonitor("source");
    refreshAvailability();
    updateAssetSelection();
    updateMonitorHeader();
    refreshDiagnostics();
    updateMeta();
    clearError("source");
    showClipInspector(clip);
    document.title =
      mode === "timeline"
        ? `${selectedTimelineId ?? clip.id} — Frameyard Timeline`
        : `${selectedCompositionId ?? clip.id} — Frameyard Preview`;
  }

  async function closeProgram(): Promise<void> {
    if (mode !== "composition" || !programAvailable()) {
      return;
    }
    await timelineMonitor.dispose();
    timelineData = null;
    selectedTimelineId = null;
    timelineDiagnostics = [];
    programError = null;
    inspector.hide();
    renderMediaAssets();
    refreshAvailability();
    setActiveMonitor("source");
    updateTimelineTitle();
    updateMeta();
    refreshDiagnostics();
    writeUrl(true);
  }

  async function closeSource(): Promise<void> {
    if (mode !== "timeline" || !sourceAvailable()) {
      return;
    }
    await sourceMonitor.dispose();
    sourceKind = null;
    selectedClip = null;
    selectedMedia = null;
    selectedElement = null;
    selectedCompositionId = null;
    currentComposition = null;
    sourceError = null;
    sourceDiagnostics = [];
    closeInspectorForSelection();
    setPanelTab("props");
    setPropsBaseline("", false, "Select a composition to edit props.");
    refreshAvailability();
    setActiveMonitor("program");
    updateAssetSelection();
    updateMonitorHeader();
    updateMeta();
    refreshDiagnostics();
    writeUrl(true);
  }

  function updatePanOverlay(): void {
    const source = activeMonitor === "source";
    const overlay = source ? sourcePan : programPan;
    const other = source ? programPan : sourcePan;
    other.hidden = true;
    const can = source ? sourceMonitor.canZoom : timelineMonitor.data !== null;
    overlay.hidden = !(can && (panMode || spaceDown));
  }

  function activeScroll(): HTMLElement {
    return activeMonitor === "source" ? sourceScrollElement : programScrollElement;
  }

  function zoomActive(operation: "in" | "out" | "fit" | "actual"): void {
    const monitor = activeMonitor === "source" ? sourceMonitor : timelineMonitor;
    if (operation === "in") {
      monitor.zoomIn();
    } else if (operation === "out") {
      monitor.zoomOut();
    } else if (operation === "fit") {
      activeScroll().scrollLeft = 0;
      activeScroll().scrollTop = 0;
      monitor.fit();
    } else {
      activeScroll().scrollLeft = 0;
      activeScroll().scrollTop = 0;
      monitor.actualSize();
    }
    updateZoomUi();
  }

  function handleTransportKey(event: KeyboardEvent, forced?: MonitorName): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) {
      return;
    }
    if (event.type === "keyup") {
      if (event.code === "Space") {
        spaceDown = false;
        updatePanOverlay();
      }
      return;
    }
    if (event.code === "Space") {
      const target = event.target as Element | null;
      if (
        target !== null &&
        typeof target.closest === "function" &&
        target.closest("button, a, input, textarea, select, [contenteditable='true']") !== null
      ) {
        return;
      }
      if (!event.repeat) {
        spaceDown = true;
        updatePanOverlay();
      }
      event.preventDefault();
      return;
    }
    let route = forced;
    if (route === undefined) {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && (programView.contains(target) || timelinePanel.contains(target))) {
        route = "program";
      } else if (target !== null && sourceView.contains(target)) {
        route = "source";
      } else {
        route = activeMonitor;
      }
    }
    if (event.key === "1" || event.key === "2") {
      event.preventDefault();
      setActiveMonitor(event.key === "1" ? "source" : "program");
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    if (route === "program") {
      timelineMonitor.step(direction * (event.shiftKey ? Math.max(1, Math.round(timelineData?.format.fps ?? 30)) : 1));
    } else {
      sourceMonitor.step(direction * (event.shiftKey ? Math.max(1, Math.round(sourceMonitor.metadata?.fps ?? 30)) : 1));
    }
  }

  function setupTheme(): void {
    const systemQuery = window.matchMedia("(prefers-color-scheme: light)");
    const apply = (next: ThemeMode, persist: boolean): void => {
      themeMode = next;
      const resolved = next === "system" ? (systemQuery.matches ? "light" : "dark") : next;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = next;
      for (const button of themeToggle.querySelectorAll<HTMLButtonElement>("[data-theme-mode]")) {
        button.setAttribute("aria-pressed", String(button.dataset.themeMode === next));
      }
      if (persist) {
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // A blocked localStorage only loses the preference.
        }
      }
    };
    for (const button of themeToggle.querySelectorAll<HTMLButtonElement>("[data-theme-mode]")) {
      button.addEventListener("click", () => {
        const next = button.dataset.themeMode;
        if (next === "system" || next === "light" || next === "dark") {
          apply(next, true);
        }
      });
    }
    systemQuery.addEventListener("change", () => {
      if (themeMode === "system") {
        apply("system", false);
      }
    });
    const stored = document.documentElement.dataset.themeMode;
    apply(stored === "light" || stored === "dark" ? stored : "system", false);
  }

  function bindPan(overlay: HTMLElement): void {
    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const scroll = activeScroll();
      panDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scroll.scrollLeft,
        top: scroll.scrollTop,
        scroll,
      };
      overlay.classList.add("dragging");
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (panDrag === null || event.pointerId !== panDrag.pointerId) {
        return;
      }
      panDrag.scroll.scrollLeft = panDrag.left - (event.clientX - panDrag.x);
      panDrag.scroll.scrollTop = panDrag.top - (event.clientY - panDrag.y);
    });
    const end = (event: PointerEvent): void => {
      if (panDrag === null || event.pointerId !== panDrag.pointerId) {
        return;
      }
      overlay.classList.remove("dragging");
      panDrag = null;
      overlay.releasePointerCapture(event.pointerId);
    };
    overlay.addEventListener("pointerup", end);
    overlay.addEventListener("pointercancel", end);
  }

  async function applyInitialLocation(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const requestedFrame = parseFrame(params.get("frame"));
    if (compositions.size === 0 && timelines.size === 0) {
      throw new FrameyardError("CONFIG_INVALID", "The project has no compositions or timelines.");
    }

    if (mode === "composition") {
      const requestedComposition = body.dataset.initialComposition ?? params.get("composition") ?? undefined;
      const requestedTimeline = body.dataset.initialTimeline ?? params.get("timeline") ?? undefined;
      const compositionId =
        requestedComposition !== undefined && compositions.has(requestedComposition)
          ? requestedComposition
          : ([...compositions.keys()][0] as string | undefined);
      if (compositionId !== undefined) {
        await openComposition(compositionId, undefined, { push: false, frame: requestedFrame });
      }
      const timelineId =
        requestedTimeline !== undefined && timelines.has(requestedTimeline) ? requestedTimeline : undefined;
      if (timelineId !== undefined) {
        await openTimeline(timelineId, { push: false });
      } else if (compositionId === undefined) {
        const firstTimeline = [...timelines.keys()][0];
        if (firstTimeline !== undefined) {
          await openTimeline(firstTimeline, { push: false, frame: requestedFrame });
        }
      }
    } else {
      const requestedTimeline =
        body.dataset.timelineId ??
        decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop() ?? "") ??
        ([...timelines.keys()][0] as string | undefined);
      const timelineId = timelines.has(requestedTimeline) ? requestedTimeline : [...timelines.keys()][0];
      if (timelineId !== undefined) {
        await openTimeline(timelineId, { push: false, frame: requestedFrame });
      }
      const requestedComposition = params.get("composition");
      if (requestedComposition !== null && compositions.has(requestedComposition)) {
        await openComposition(requestedComposition, undefined, { push: false });
      }
    }

    refreshAvailability();
    if (activeMonitor === "source" && !sourceAvailable() && programAvailable()) {
      setActiveMonitor("program");
    } else if (activeMonitor === "program" && !programAvailable() && sourceAvailable()) {
      setActiveMonitor("source");
    }
    writeUrl(false);
  }

  // The API is published only after project.json has populated the entry list,
  // so a caller that waits for window.__frameyardPreview can load immediately.
  const api: PreviewApi = {
    load(entry: string, props?: unknown): Promise<LoadedCompositionState> {
      return openCompositionByEntry(entry, props).catch((error: unknown) => {
        throw browserCommandError(error);
      });
    },
    seek(frame: number): void {
      try {
        sourceMonitor.seek(frame);
      } catch (error) {
        throw browserCommandError(error);
      }
    },
    async settle(): Promise<void> {
      try {
        await sourceMonitor.settle();
      } catch (error) {
        throw browserCommandError(error);
      }
    },
    async dispose(): Promise<void> {
      try {
        inspector.hide();
        await sourceMonitor.dispose();
        propsEditor.value = "";
        sourceKind = null;
        selectedCompositionId = null;
        currentComposition = null;
        selectedClip = null;
        selectedMedia = null;
        refreshAvailability();
        updateAssetSelection();
      } catch (error) {
        throw browserCommandError(error);
      }
    },
    audioDebug(): SourceAudioDebug {
      return sourceMonitor.debugAudio();
    },
  };

  setupTheme();
  bindPan(sourcePan);
  bindPan(programPan);

  const response = await fetch("/__frameyard/project.json", { cache: "no-store" });
  if (!response.ok) {
    throw new FrameyardError("CONFIG_INVALID", `Could not load project.json (${response.status}).`);
  }
  const data = (await response.json()) as {
    format?: unknown;
    compositions?: Array<{
      id?: unknown;
      entry?: unknown;
      metadata?: unknown;
      controller?: unknown;
      diagnostics?: unknown;
    }>;
    timelines?: Array<{ id?: unknown; entry?: unknown }>;
  };
  projectFormat =
    data.format !== null &&
    typeof data.format === "object" &&
    typeof (data.format as Record<string, unknown>).width === "number" &&
    typeof (data.format as Record<string, unknown>).height === "number" &&
    typeof (data.format as Record<string, unknown>).fps === "number"
      ? (data.format as { width: number; height: number; fps: number })
      : null;

  for (const item of data.compositions ?? []) {
    if (typeof item.id !== "string" || typeof item.entry !== "string") {
      continue;
    }
    const metadata = isCompositionMetadata(item.metadata) ? item.metadata : undefined;
    const controller =
      item.controller === null || item.controller === undefined
        ? null
        : (item.controller as SourceCompositionEntry["controller"]);
    const diagnostics = Array.isArray(item.diagnostics) ? (item.diagnostics as CompositionDiagnostic[]) : [];
    const composition: SourceCompositionEntry = {
      id: item.id,
      entry: item.entry,
      ...(metadata !== undefined ? { metadata } : {}),
      controller,
      diagnostics,
    };
    compositions.set(item.id, composition);
  }

  for (const item of data.timelines ?? []) {
    if (typeof item.id !== "string" || typeof item.entry !== "string") {
      continue;
    }
    timelines.set(item.id, { id: item.id, entry: item.entry });
  }

  renderCatalog();
  setPropsBaseline("", false, "Select a composition to edit props.");
  setPanelTab("props");
  refreshAvailability();
  updateAssetCount();
  window.__frameyardPreview = api;
  const timelineFacade = {
    ready: Promise.resolve(),
    get format() {
      return timelineData?.format ?? projectFormat ?? { width: 0, height: 0, fps: 30 };
    },
    get durationInFrames() {
      return timelineData?.durationInFrames ?? 0;
    },
    load: async () => {
      const id = selectedTimelineId ?? ([...timelines.keys()][0] as string | undefined);
      if (id !== undefined) {
        await openTimeline(id, { push: false });
      }
    },
    seek: (frame: number) => timelineMonitor.seek(frame),
    settle: async () => undefined,
    dispose: () => timelineMonitor.dispose(),
    audioDebug: () => timelineMonitor.debugAudio(),
  };
  window.__fyTimeline = timelineFacade;

  sourceMonitor.refreshTransport();
  updateMonitorHeader();
  updateMeta();
  updateTimelineZoomUi(timelineMonitor.timelineZoom);

  const apply = async (): Promise<void> => {
    await applyInitialLocation();
    refreshAvailability();
    updateMonitorHeader();
    updateMeta();
    refreshDiagnostics();
  };
  await apply();

  assetFilter.addEventListener("input", applyAssetFilter);
  tabSource.addEventListener("click", () => setActiveMonitor("source"));
  tabProgram.addEventListener("click", () => setActiveMonitor("program"));
  tabProps.addEventListener("click", () => {
    if (panelTab === "props") {
      return;
    }
    if (inspector.isOpen()) {
      syncingInspector = true;
      inspector.hide();
      syncingInspector = false;
    }
    setPanelTab("props");
  });
  tabInspector.addEventListener("click", () => setPanelTab("inspector"));
  closeSourceButton.addEventListener("click", () => {
    void closeSource().catch((error: unknown) => showError(error, "source"));
  });
  closeProgramButton.addEventListener("click", () => {
    void closeProgram().catch((error: unknown) => showError(error, "program"));
  });
  panToggle.addEventListener("click", () => {
    panMode = !panMode;
    panToggle.setAttribute("aria-pressed", String(panMode));
    updatePanOverlay();
  });
  zoomOut.addEventListener("click", () => zoomActive("out"));
  zoomIn.addEventListener("click", () => zoomActive("in"));
  zoomFit.addEventListener("click", () => zoomActive("fit"));
  zoomActual.addEventListener("click", () => zoomActive("actual"));
  timelineZoomOut.addEventListener("click", () => timelineMonitor.timelineZoomOut());
  timelineZoomIn.addEventListener("click", () => timelineMonitor.timelineZoomIn());
  timelineZoomFit.addEventListener("click", () => timelineMonitor.timelineZoomFit());
  fullscreenButton.addEventListener("click", () => {
    void (async () => {
      try {
        if (document.fullscreenElement === monitorPanel) {
          await document.exitFullscreen();
        } else if (monitorPanel.requestFullscreen) {
          await monitorPanel.requestFullscreen();
        }
      } catch (error) {
        showError(error, activeMonitor);
      }
    })();
  });
  document.addEventListener("fullscreenchange", () => {
    const fullscreen = document.fullscreenElement === monitorPanel;
    fullscreenButton.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.title = fullscreen ? "Exit fullscreen" : "Fullscreen";
    sourceMonitor.layout();
    timelineMonitor.layout();
  });

  applyButton.addEventListener("click", () => {
    if (!currentComposition || sourceKind !== "composition") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsEditor.value.trim() || "{}");
    } catch (error) {
      propsSyntax.hidden = false;
      propsSyntax.textContent = `invalid JSON: ${errorMessage(error)}`;
      showError(new FrameyardError("PROPS_INVALID", `Props are not valid JSON: ${errorMessage(error)}`), "source");
      return;
    }
    void openComposition(currentComposition.id, parsed, { push: false }).catch((error: unknown) =>
      showError(error, "source"),
    );
  });
  formatButton.addEventListener("click", () => {
    try {
      propsEditor.value = JSON.stringify(JSON.parse(propsEditor.value.trim() || "{}"), null, 2);
      updatePropsDirty();
      validatePropsSyntax();
      clearError("source");
    } catch (error) {
      propsSyntax.hidden = false;
      propsSyntax.textContent = `invalid JSON: ${errorMessage(error)}`;
    }
  });
  propsReset.addEventListener("click", () => {
    propsEditor.value = propsBaseline;
    updatePropsDirty();
    validatePropsSyntax();
  });
  propsEditor.addEventListener("input", () => {
    updatePropsDirty();
    validatePropsSyntax();
  });
  window.addEventListener("keydown", (event) => handleTransportKey(event));
  window.addEventListener("keyup", (event) => handleTransportKey(event));
  window.addEventListener("blur", () => {
    spaceDown = false;
    panDrag = null;
    updatePanOverlay();
  });
  window.addEventListener("resize", () => {
    sourceMonitor.layout();
    timelineMonitor.layout();
    updateZoomUi();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      return;
    }
    sourceMonitor.refresh();
    timelineMonitor.refresh();
  });
  window.addEventListener("popstate", () => {
    window.location.reload();
  });
}
