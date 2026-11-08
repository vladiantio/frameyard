import type { CompositionDiagnostic, Props, ResolvedCompositionMetadata } from "../index.js";
import { errorMessage, FrameyardError, isFrameyardError } from "../errors.js";
import { createInspector, type InspectorRow, type InspectorSection } from "./inspector.js";
import {
  createSourceMonitor,
  type LoadedCompositionState,
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
}

declare global {
  interface Window {
    __frameyardPreview: PreviewApi;
  }
}

type PreviewMode = "composition" | "timeline";
type SourceKind = "composition" | "clip" | "asset" | null;

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

function metadataLabel(metadata: ResolvedCompositionMetadata | undefined): string {
  if (!metadata) {
    return "unresolved";
  }
  if (metadata.static === true) {
    return `${metadata.width}×${metadata.height} · static`;
  }
  return `${metadata.width}×${metadata.height} · ${metadata.fps} fps`;
}

function projectUrl(entry: string): string {
  return new URL(entry.replace(/^\.\//, ""), `${window.location.origin}/`).href;
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

export async function bootPreview(): Promise<void> {
  const body = document.body;
  const mode: PreviewMode = body.dataset.previewMode === "timeline" ? "timeline" : "composition";
  const sourcePrimary = mode === "composition";
  const programPrimary = mode === "timeline";
  const sourceTransportId = (name: string): string => (sourcePrimary ? name : `source-${name}`);
  const programTransportId = (name: string): string => (programPrimary ? name : `timeline-${name}`);

  const metaLabel = byId<HTMLElement>("meta");
  const compositionSelect = byId<HTMLSelectElement>("composition");
  const timelineSelect = byId<HTMLSelectElement>("timeline");
  const compositionAssets = byId<HTMLElement>("composition-assets");
  const timelineAssets = byId<HTMLElement>("timeline-assets");
  const mediaAssets = byId<HTMLElement>("media-assets");
  const assetCount = byId<HTMLElement>("asset-count");
  const sourceTitle = byId<HTMLElement>("source-title");
  const timelineTitle = byId<HTMLElement>("title");
  const timelineMeta = byId<HTMLElement>("timeline-meta");
  const propsEditor = byId<HTMLTextAreaElement>("props");
  const applyButton = byId<HTMLButtonElement>("apply");
  const formatButton = byId<HTMLButtonElement>("format");
  const propsHint = byId<HTMLElement>("props-hint");
  const propsPanel = byId<HTMLElement>("inspector-host").closest<HTMLElement>(".props-panel") as HTMLElement;
  const inspectorHost = byId<HTMLElement>("inspector-host");
  const errorBox = byId<HTMLDivElement>("error");
  const diagnosticsBox = byId<HTMLDivElement>("diagnostics");
  const sourceEmpty = byId<HTMLElement>("source-empty");
  const programEmpty = byId<HTMLElement>("program-empty");
  const programStageWrap = byId<HTMLElement>("program-stage-wrap");
  const sourcePanel = byId<HTMLElement>("source-viewport").closest<HTMLElement>(".source-panel") as HTMLElement;
  const programPanel = byId<HTMLElement>("program-viewport").closest<HTMLElement>(".program-panel") as HTMLElement;
  const timelinePanel = byId<HTMLElement>("timeline");

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
  let currentComposition: SourceCompositionEntry | null = null;
  let timelineQueue: Promise<unknown> = Promise.resolve();

  const inspectedDocuments = new WeakSet<Document>();

  const inspector = createInspector({
    container: inspectorHost,
    onVisibilityChange(open) {
      propsPanel.dataset.inspecting = open ? "true" : "false";
    },
  });

  const sourceMonitor: SourceMonitor = createSourceMonitor({
    frame: byId("stage-frame"),
    stageWrap: byId("stage-wrap"),
    viewport: byId("source-viewport"),
    nestedFrame: byId("source-timeline-frame"),
    nestedWrap: byId("source-timeline-wrap"),
    mediaHost: byId("source-media"),
    empty: sourceEmpty,
    transport: sourceElements,
    defaultFps: () => timelineData?.format.fps ?? projectFormat?.fps ?? 30,
    callbacks: {
      onMetadata() {
        updateMeta();
        updateSourceTitle();
      },
      onFrame() {
        refreshDiagnostics();
        refreshInspector();
        updateMeta();
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
        showError(error);
      },
    },
  });

  const timelineMonitor: TimelineMonitor = createTimelineMonitor({
    stage: byId("stage"),
    stageWrap: programStageWrap,
    viewport: byId("program-viewport"),
    timelineInner: byId("timeline-inner"),
    tracks: byId("tracks"),
    rulerScale: byId("ruler-scale"),
    empty: programEmpty,
    transport: programElements,
    callbacks: {
      onFrame() {
        refreshDiagnostics();
        refreshInspector();
        updateMeta();
      },
      onSelectClip(clip) {
        void selectTimelineClip(clip).catch(showError);
      },
      onKey(event) {
        handleTransportKey(event, "program");
      },
      onError(error) {
        showError(error);
      },
      onDiagnostics(diagnostics) {
        timelineDiagnostics = [...diagnostics];
        refreshDiagnostics();
      },
    },
  });

  function showError(error: unknown): void {
    errorBox.hidden = false;
    errorBox.textContent = errorMessage(error);
    console.error(error);
  }

  function clearError(): void {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function updateMeta(): void {
    const focused =
      mode === "timeline"
        ? (timelineMetaText() ?? compositionMetaText())
        : (compositionMetaText() ?? timelineMetaText());
    metaLabel.textContent = focused ?? "";
  }

  function compositionMetaText(): string | null {
    const metadata = sourceMonitor.metadata;
    if (!metadata) {
      return null;
    }
    if (metadata.kind !== "composition") {
      return `${metadata.width}×${metadata.height} · ${metadata.kind}`;
    }
    if (metadata.static === true) {
      return `${metadata.width}×${metadata.height} · static`;
    }
    return `${metadata.width}×${metadata.height} · ${metadata.fps} fps · ${metadata.durationInFrames} frames · ${(
      (metadata.durationInFrames ?? 0) / (metadata.fps ?? 30)
    ).toFixed(2)}s`;
  }

  function timelineMetaText(): string | null {
    if (!timelineData) {
      return null;
    }
    return `${timelineData.format.width}×${timelineData.format.height} · ${timelineData.format.fps} fps · ${timelineData.durationInFrames} frames · ${(
      timelineData.durationInFrames / timelineData.format.fps
    ).toFixed(2)}s`;
  }

  function updateSourceTitle(): void {
    if (sourceKind === "clip" && selectedClip) {
      sourceTitle.textContent = `clip · ${selectedClip.id} · ${selectedClip.source.kind}`;
    } else if (sourceKind === "asset" && selectedMedia) {
      sourceTitle.textContent = `asset · ${selectedMedia.kind} · ${selectedMedia.src}`;
    } else if (selectedCompositionId) {
      sourceTitle.textContent = `composition · ${selectedCompositionId}`;
    } else {
      sourceTitle.textContent = "";
    }
  }

  function updateTimelineTitle(): void {
    timelineTitle.textContent = selectedTimelineId ?? "";
    timelineMeta.textContent = timelineData
      ? `${timelineData.durationInFrames} frames · ${(timelineData.durationInFrames / timelineData.format.fps).toFixed(2)}s`
      : "";
  }

  function setPropsEditable(editable: boolean, hint: string | null = null): void {
    propsEditor.readOnly = !editable;
    applyButton.disabled = !editable;
    propsHint.hidden = hint === null;
    propsHint.textContent = hint ?? "";
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

  function refreshDiagnostics(): void {
    const all = mergeDiagnostics(sourceDiagnostics, timelineDiagnostics);
    diagnosticsBox.hidden = all.length === 0;
    diagnosticsBox.replaceChildren(...all.map(renderDiagnostic));
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
      composition === null ? undefined : `npx frameyard still ${composition.id} --frame ${sourceMonitor.frame}`;

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
            showError(error);
          }
        },
        jumpEnd: () => {
          try {
            void sourceMonitor.seek(lastFrame);
          } catch (error) {
            showError(error);
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
        inspector.hide();
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
        event.preventDefault();
        event.stopPropagation();
        showElementInspector(target as Element);
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        inspector.hide();
      }
    });
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

  function createCompositionThumb(entry: SourceCompositionEntry): HTMLElement {
    const thumb = document.createElement("span");
    thumb.className = "asset-thumb";
    if (!entry.metadata) {
      const label = document.createElement("span");
      label.className = "asset-thumb-label";
      label.textContent = "unresolved";
      thumb.append(label);
      return thumb;
    }
    const width = 84;
    const height = 47;
    const scale = Math.min(width / entry.metadata.width, height / entry.metadata.height);
    const frame = document.createElement("iframe");
    frame.src = projectUrl(entry.entry);
    frame.loading = "lazy";
    frame.tabIndex = -1;
    frame.title = entry.id;
    frame.setAttribute("aria-hidden", "true");
    frame.style.width = `${entry.metadata.width}px`;
    frame.style.height = `${entry.metadata.height}px`;
    frame.style.left = `${(width - entry.metadata.width * scale) / 2}px`;
    frame.style.top = `${(height - entry.metadata.height * scale) / 2}px`;
    frame.style.transform = `scale(${scale})`;
    thumb.append(frame);
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

  function renderCatalog(): void {
    compositionAssets.replaceChildren();
    for (const composition of compositions.values()) {
      compositionAssets.append(
        assetButton(
          "composition",
          composition.id,
          composition.id,
          metadataLabel(composition.metadata),
          createCompositionThumb(composition),
          () => {
            void openComposition(composition.id).catch(showError);
          },
        ),
      );
    }
    if (compositionAssets.childElementCount === 0) {
      compositionAssets.append(hint("no compositions"));
    }

    timelineAssets.replaceChildren();
    for (const timeline of timelines.values()) {
      const thumb = document.createElement("span");
      thumb.className = "asset-thumb";
      const label = document.createElement("span");
      label.className = "asset-thumb-label";
      label.textContent = "timeline";
      thumb.append(label);
      timelineAssets.append(
        assetButton("timeline", timeline.id, timeline.id, timeline.entry, thumb, () => {
          void openTimeline(timeline.id).catch(showError);
        }),
      );
    }
    if (timelineAssets.childElementCount === 0) {
      timelineAssets.append(hint("no timelines"));
    }

    renderMediaAssets();
    assetCount.textContent = `${compositions.size + timelines.size} entries`;
    updateAssetSelection();
  }

  function hint(text: string): HTMLElement {
    const element = document.createElement("span");
    element.className = "hint";
    element.textContent = text;
    return element;
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
            void openAsset(source).catch(showError);
          },
        ),
      );
    }
    if (sources.length === 0) {
      mediaAssets.append(hint(timelineData ? "no media in this timeline" : "select a timeline"));
    }
    updateAssetSelection();
  }

  function setProgramTransportEnabled(enabled: boolean): void {
    programElements.play.disabled = !enabled;
    programElements.stepBack.disabled = !enabled;
    programElements.stepForward.disabled = !enabled;
    programElements.jumpBack.disabled = !enabled;
    programElements.jumpForward.disabled = !enabled;
    programElements.scrub.disabled = !enabled;
  }

  async function openComposition(id: string, props?: unknown): Promise<LoadedCompositionState> {
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
    inspector.hide();
    if (compositionSelect.value !== id) {
      compositionSelect.value = id;
    }
    const loaded = await sourceMonitor.loadComposition(composition, props);
    propsEditor.value = JSON.stringify(loaded.props, null, 2);
    setPropsEditable(true);
    updateSourceTitle();
    updateTimelineTitle();
    updateAssetSelection();
    refreshDiagnostics();
    updateMeta();
    clearError();
    document.title =
      mode === "timeline" ? `${selectedTimelineId ?? id} — Frameyard Timeline` : `${id} — Frameyard Preview`;
    return loaded;
  }

  async function openCompositionByEntry(entry: string, props?: unknown): Promise<LoadedCompositionState> {
    const composition = [...compositions.values()].find((candidate) => candidate.entry === entry);
    if (!composition) {
      throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${entry}`);
    }
    return openComposition(composition.id, props);
  }

  async function openTimelineNow(id: string): Promise<void> {
    if (!timelines.has(id)) {
      throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${id}" is not listed in fy.config.js.`);
    }
    const previousId = selectedTimelineId;
    let data: TimelinePreviewData;
    try {
      data = await fetchTimelineData(id);
    } catch (error) {
      if (previousId !== null && timelines.has(previousId)) {
        selectedTimelineId = previousId;
        timelineSelect.value = previousId;
      }
      throw error;
    }
    inspector.hide();
    selectedTimelineId = id;
    timelineSelect.value = id;
    timelineData = data;
    timelineDiagnostics = data.diagnostics;
    try {
      await timelineMonitor.load(data);
    } catch (error) {
      timelineData = null;
      timelineDiagnostics = [];
      await timelineMonitor.dispose();
      programStageWrap.hidden = true;
      programEmpty.hidden = false;
      setProgramTransportEnabled(false);
      updateTimelineTitle();
      updateMeta();
      renderMediaAssets();
      refreshDiagnostics();
      throw error;
    }
    programStageWrap.hidden = false;
    setProgramTransportEnabled(true);
    updateTimelineTitle();
    updateMeta();
    renderMediaAssets();
    updateAssetSelection();
    refreshDiagnostics();
    clearError();
    if (mode === "timeline") {
      document.title = `${id} — Frameyard Timeline`;
    }
  }

  function openTimeline(id: string): Promise<void> {
    const run = timelineQueue.then(
      () => openTimelineNow(id),
      () => openTimelineNow(id),
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
    selectedMedia = source;
    sourceKind = "asset";
    inspector.hide();
    await sourceMonitor.loadMedia(source);
    propsEditor.value = "";
    setPropsEditable(false, "Select a composition to edit props.");
    updateSourceTitle();
    updateAssetSelection();
    refreshDiagnostics();
    updateMeta();
    clearError();
  }

  async function selectTimelineClip(clip: TimelinePreviewClip): Promise<void> {
    selectedClip = clip;
    selectedElement = null;
    sourceKind = "clip";
    selectedMedia = null;
    selectedCompositionId = null;
    currentComposition = null;
    inspector.hide();
    let compositionId: string | null = null;
    if (clip.source.kind === "composition") {
      compositionId = clip.source.id;
      const composition = compositions.get(compositionId);
      if (!composition) {
        throw new FrameyardError("COMPOSITION_NOT_FOUND", `Composition entry is not listed: ${compositionId}`);
      }
      selectedCompositionId = compositionId;
      currentComposition = composition;
      compositionSelect.value = compositionId;
      const loaded = await sourceMonitor.loadComposition(composition, clip.props);
      propsEditor.value = JSON.stringify(loaded.props, null, 2);
      await sourceMonitor.seek(clip.sourceIn);
    } else if (clip.source.kind === "timeline") {
      propsEditor.value = clip.props === undefined ? "" : JSON.stringify(clip.props, null, 2);
      await sourceMonitor.loadNestedTimeline(clip.source, clip.sourceIn);
    } else {
      propsEditor.value = clip.props === undefined ? "" : JSON.stringify(clip.props, null, 2);
      await sourceMonitor.loadMedia(clip.source, clip.sourceIn);
    }
    setPropsEditable(false, "Clip props are read-only in preview.");
    updateSourceTitle();
    updateAssetSelection();
    refreshDiagnostics();
    updateMeta();
    showClipInspector(clip);
    clearError();
    if (compositionId !== null) {
      document.title =
        mode === "timeline"
          ? `${selectedTimelineId ?? compositionId} — Frameyard Timeline`
          : `${compositionId} — Frameyard Preview`;
    }
  }

  function sourceFps(): number {
    return sourceMonitor.metadata?.fps ?? projectFormat?.fps ?? 30;
  }

  function programFps(): number {
    return timelineData?.format.fps ?? projectFormat?.fps ?? 30;
  }

  function handleTransportKey(event: KeyboardEvent, forced?: "source" | "program"): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) {
      return;
    }
    let route = forced;
    if (route === undefined) {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && (programPanel.contains(target) || timelinePanel.contains(target))) {
        route = "program";
      } else if (target !== null && sourcePanel.contains(target)) {
        route = "source";
      } else {
        route = mode === "timeline" ? "program" : "source";
      }
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    if (route === "program") {
      timelineMonitor.step(direction * (event.shiftKey ? Math.max(1, Math.round(programFps())) : 1));
    } else {
      sourceMonitor.step(direction * (event.shiftKey ? Math.max(1, Math.round(sourceFps())) : 1));
    }
  }

  compositionSelect.addEventListener("change", () => {
    const id = compositionSelect.value;
    if (id) {
      void openComposition(id).catch(showError);
    }
  });
  timelineSelect.addEventListener("change", () => {
    const id = timelineSelect.value;
    if (id) {
      void openTimeline(id).catch(showError);
    }
  });
  applyButton.addEventListener("click", () => {
    if (!currentComposition || sourceKind !== "composition") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsEditor.value.trim() || "{}");
    } catch (error) {
      showError(new FrameyardError("PROPS_INVALID", `Props are not valid JSON: ${errorMessage(error)}`));
      return;
    }
    void openComposition(currentComposition.id, parsed).catch(showError);
  });
  formatButton.addEventListener("click", () => {
    try {
      propsEditor.value = JSON.stringify(JSON.parse(propsEditor.value.trim() || "{}"), null, 2);
      clearError();
    } catch (error) {
      showError(new FrameyardError("PROPS_INVALID", `Props are not valid JSON: ${errorMessage(error)}`));
    }
  });
  window.addEventListener("keydown", (event) => handleTransportKey(event));
  window.addEventListener("resize", () => {
    sourceMonitor.fit();
    timelineMonitor.fit();
  });

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
        selectedCompositionId = null;
        currentComposition = null;
        sourceKind = null;
        selectedClip = null;
        selectedMedia = null;
        sourceTitle.textContent = "";
        updateAssetSelection();
      } catch (error) {
        throw browserCommandError(error);
      }
    },
  };
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

  compositionSelect.replaceChildren();
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
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = metadata ? `${item.id} — ${metadataLabel(metadata)}` : item.id;
    compositionSelect.append(option);
  }
  if (compositions.size === 0) {
    compositionSelect.disabled = true;
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No compositions";
    compositionSelect.append(option);
  }

  timelineSelect.replaceChildren();
  for (const item of data.timelines ?? []) {
    if (typeof item.id !== "string" || typeof item.entry !== "string") {
      continue;
    }
    timelines.set(item.id, { id: item.id, entry: item.entry });
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.id;
    timelineSelect.append(option);
  }
  if (timelines.size === 0) {
    timelineSelect.disabled = true;
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No timelines";
    timelineSelect.append(option);
    programEmpty.hidden = false;
    programStageWrap.hidden = true;
    timelineMeta.textContent = "";
    setProgramTransportEnabled(false);
  }

  renderCatalog();
  window.__frameyardPreview = api;
  setPropsEditable(false, "Select a composition to edit props.");

  const requestedComposition =
    body.dataset.initialComposition ?? new URLSearchParams(window.location.search).get("composition") ?? undefined;
  const requestedTimeline =
    body.dataset.initialTimeline ?? new URLSearchParams(window.location.search).get("timeline") ?? undefined;
  const firstComposition = [...compositions.keys()][0];
  const firstTimeline = [...timelines.keys()][0];
  const initialComposition =
    requestedComposition !== undefined && compositions.has(requestedComposition)
      ? requestedComposition
      : firstComposition;
  const initialTimeline = requestedTimeline !== undefined ? requestedTimeline : firstTimeline;

  if (compositions.size === 0 && timelines.size === 0) {
    throw new FrameyardError("CONFIG_INVALID", "The project has no compositions or timelines.");
  }

  setProgramTransportEnabled(false);
  programStageWrap.hidden = true;

  if (initialComposition) {
    void openComposition(initialComposition).catch(showError);
  } else {
    sourceEmpty.hidden = false;
  }

  if (initialTimeline) {
    void openTimeline(initialTimeline).catch((error: unknown) => {
      showError(error);
      programEmpty.hidden = false;
      programStageWrap.hidden = true;
      setProgramTransportEnabled(false);
    });
  } else {
    setProgramTransportEnabled(false);
  }

  window.__fyTimeline = {
    ready: Promise.resolve(),
    get format() {
      return timelineData?.format ?? projectFormat ?? { width: 0, height: 0, fps: 30 };
    },
    get durationInFrames() {
      return timelineData?.durationInFrames ?? 0;
    },
    load: async () => {
      if (selectedTimelineId) {
        await openTimeline(selectedTimelineId);
      }
    },
    seek: (frame: number) => timelineMonitor.seek(frame),
    settle: async () => undefined,
    dispose: () => timelineMonitor.dispose(),
  };
}
