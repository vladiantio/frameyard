import { PREVIEW_CSS } from "./preview-style.js";

const IMPORT_MAP = JSON.stringify(
  {
    imports: {
      frameyard: "/__frameyard/framework/index.js",
      "frameyard/runtime": "/__frameyard/framework/runtime/index.js",
    },
  },
  null,
  2,
);

const THEME_BOOT = `(() => {
  try {
    const key = "frameyard.preview.theme";
    const stored = localStorage.getItem(key);
    const mode = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    const resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "system";
  }
})();`;

export type PreviewMode = "composition" | "timeline";

export interface PreviewPageOptions {
  mode: PreviewMode;
  initialComposition?: string;
  initialTimeline?: string;
}

const PAGE_CSS = `
  #app {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr) 320px;
    grid-template-rows: 54px minmax(0, 1fr);
    gap: 10px;
    height: 100vh;
    padding: 0 10px 10px;
  }
  .topbar { grid-column: 1 / -1; margin: 0 -10px; }
  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--panel);
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .panel-head .eyebrow { color: var(--muted-strong); }
  .panel-index {
    font-family: var(--mono); font-size: 9px; color: var(--muted);
    letter-spacing: 0.14em; text-transform: uppercase;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .panel-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    padding: 12px;
    overflow: auto;
  }
  .assets-panel { grid-column: 1; grid-row: 2; }
  .monitor-column {
    grid-column: 2; grid-row: 2;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    gap: 10px;
    min-height: 0;
  }
  .monitor-column.program-open {
    grid-template-rows: minmax(0, 1fr) minmax(210px, 0.55fr);
  }
  .inspector-panel { grid-column: 3; grid-row: 2; }

  /* Assets */
  .assets-filters { display: flex; flex-direction: column; gap: 4px; }
  .asset-group { display: flex; flex-direction: column; gap: 5px; }
  .asset-group h3 {
    margin: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 400;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .asset-list { display: flex; flex-direction: column; gap: 3px; }
  .asset {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 9px;
    align-items: center;
    width: 100%;
    padding: 3px;
    border: 1px solid transparent;
    border-radius: 2px;
    background: transparent;
    color: var(--paper);
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
  }
  .asset[hidden] { display: none; }
  .asset:hover:not(:disabled) { border-color: var(--line-strong); color: var(--paper); }
  .asset.selected { border-color: var(--accent); }
  .asset-thumb {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    height: 41px;
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--panel-2);
  }
  .asset-thumb img, .asset-thumb video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .asset-thumb-label {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.1em;
    line-height: 1.4;
    text-align: center;
    text-transform: uppercase;
    padding: 2px;
  }
  .asset-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .asset-name {
    overflow: hidden;
    font-family: var(--mono);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .asset-sub {
    overflow: hidden;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Monitor */
  .monitor-panel { min-height: 0; }
  .monitor-tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 0 0 auto;
    padding: 6px 10px 0;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .monitor-tab {
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 2px 2px 0 0;
    background: transparent;
    color: var(--muted);
    padding: 6px 12px;
  }
  .monitor-tab[aria-selected="true"] {
    color: var(--paper);
    background: var(--panel-2);
    border-color: var(--line);
  }
  .monitor-tab[hidden] { display: none; }
  .monitor-tabs-spacer { flex: 1; }
  .tab-close {
    align-self: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    text-transform: none;
  }
  .tab-close[hidden] { display: none; }
  .tab-close:hover:not(:disabled) { color: var(--accent-text); border-color: var(--line); }
  .monitor-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .monitor-head .eyebrow { flex: 0 0 auto; }
  .monitor-head .panel-index { min-width: 0; }
  .monitor-tools {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex: 0 0 auto;
  }
  .monitor-tools .tool {
    padding: 4px 7px;
    font-size: 9px;
  }
  .monitor-tools .tool[aria-pressed="true"] {
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .zoom-controls {
    display: flex;
    align-items: center;
    border: 1px solid var(--line);
    background: var(--field);
  }
  .zoom-controls button {
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 4px 6px;
    font-size: 9px;
  }
  .zoom-controls button + button,
  .zoom-controls .zoom-readout + button { border-left: 1px solid var(--line); }
  .zoom-readout {
    min-width: 38px;
    padding: 0 4px;
    color: var(--muted-strong);
    font-family: var(--mono);
    font-size: 9px;
    text-align: center;
    white-space: nowrap;
  }
  .monitor-body {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .monitor-view {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .monitor-view[hidden] { display: none; }
  .monitor-view .viewport { flex: 1 1 auto; min-height: 0; }
  .monitor-view .transport { flex: 0 0 auto; }
  .monitor-status {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    max-height: 30vh;
    overflow: auto;
  }
  .monitor-status[hidden] { display: none; }
  .monitor-status #error, .monitor-status #diagnostics { max-height: none; }
  .monitor-status #error[hidden], .monitor-status #diagnostics[hidden] { display: none; }
  .player-transport {
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 10px;
  }
  .player-transport .scrub-wrap { flex-basis: 100%; order: 10; }
  .player-transport .readout { order: 11; }
  .player-transport .audio { order: 12; }
  .transport .readout { font-size: 10px; }
  .transport .audio { font-size: 9px; }
  .transport .audio input[type="range"] { width: 56px; }

  /* Props and inspector */
  .panel-tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 0 0 auto;
    padding: 6px 10px 0;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .panel-tab {
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 2px 2px 0 0;
    background: transparent;
    color: var(--muted);
    padding: 6px 12px;
  }
  .panel-tab[aria-selected="true"] {
    color: var(--paper);
    background: var(--panel-2);
    border-color: var(--line);
  }
  .props-view { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .props-view[hidden] { display: none; }
  .props-view .field { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  .props-view textarea { min-height: 120px; }
  .props-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge {
    padding: 1px 4px;
    border: 1px solid var(--warning);
    color: var(--warning);
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .badge[hidden] { display: none; }
  .hint {
    margin: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 9px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .hint[hidden] { display: none; }
  .hint.error { color: var(--danger); }
  .inspector-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    flex: 1;
  }
  .inspector-view[hidden] { display: none; }
  .inspector-host { display: block; min-height: 0; }
  .inspector-empty {
    display: grid;
    place-items: center;
    min-height: 120px;
    padding: 16px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-align: center;
    text-transform: uppercase;
  }
  .inspector-empty[hidden] { display: none; }

  /* Timeline strip */
  .timeline-panel { min-height: 0; }
  .timeline-panel[hidden] { display: none; }
  .strip-tools { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .strip-tools button {
    padding: 3px 6px;
    font-size: 9px;
  }
  .strip-tools .zoom-readout { min-width: 34px; font-size: 9px; }
  .timeline-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 18px 16px; }
  .ruler {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 10px;
    height: 20px;
  }
  .ruler-scale { position: relative; border-bottom: 1px solid var(--line); cursor: crosshair; }
  .ruler-scale::before {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 7px;
    background-image: linear-gradient(90deg, var(--line-strong) 0 1px, transparent 1px);
    background-size: 10% 100%;
    opacity: 0.55;
    pointer-events: none;
  }
  .ruler-tick {
    position: absolute; top: -1px; transform: translateX(-50%);
    font-family: var(--mono); font-size: 9px; color: var(--muted);
    letter-spacing: 0.06em; pointer-events: none;
  }
  .ruler-tick:first-child { transform: none; }
  .ruler-tick:last-child { transform: translateX(-100%); }
  #timeline-inner { position: relative; width: calc(100% * var(--timeline-zoom, 1)); min-width: 100%; }
  #tracks { position: relative; display: flex; flex-direction: column; }
  .track { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; min-height: 30px; }
  .track-label {
    display: flex; align-items: center; justify-content: flex-end;
    font-size: 9px; white-space: nowrap;
  }
  .lane {
    position: relative; border: 1px solid var(--line);
    background: var(--field); overflow: hidden;
  }
  .clip {
    position: absolute; top: 3px; bottom: 3px; border-radius: 1px;
    background: var(--clip-bg);
    border: 1px solid var(--clip-border); color: var(--clip-text);
    font: 10px/1 var(--mono); padding: 6px 8px; overflow: visible;
    white-space: nowrap;
  }
  .clip-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clip.composition {
    background: var(--clip-comp-bg);
    border-color: var(--clip-comp-border); color: var(--clip-comp-text);
  }
  .clip.audio {
    background: var(--clip-audio-bg);
    border-color: var(--clip-audio-border); color: var(--clip-audio-text);
  }
  .clip.nested {
    background: var(--clip-nested-bg);
    border-color: var(--clip-nested-border); color: var(--clip-nested-text);
  }
  .clip.selected {
    outline: 2px solid var(--accent); outline-offset: -2px;
    box-shadow: 0 0 14px rgba(184, 243, 107, 0.5);
  }
  .clip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .keyframe-marker {
    position: absolute; top: 50%; width: 7px; height: 7px;
    background: var(--accent); border: 1px solid var(--canvas); border-radius: 1px;
    transform: translate(-50%, -50%) rotate(45deg); cursor: pointer; z-index: 2;
  }
  .keyframe-marker:hover { background: var(--paper); }
  .transition {
    position: absolute; top: 6px; bottom: 6px; border-radius: 1px; z-index: 1;
    background: repeating-linear-gradient(
      45deg,
      rgba(184, 243, 107, 0.22) 0 4px,
      rgba(184, 243, 107, 0.06) 4px 8px
    );
    border: 1px solid rgba(184, 243, 107, 0.5); pointer-events: none;
  }
  .playhead {
    position: absolute; top: 0; bottom: 0; width: 1px;
    left: calc(106px + (100% - 106px) * var(--playhead-factor, 0));
    background: var(--accent);
    box-shadow: 0 0 10px rgba(184, 243, 107, 0.7);
    pointer-events: none;
    z-index: 3;
  }
  .playhead::before {
    content: ""; position: absolute; top: 0; left: -3px;
    width: 7px; height: 7px; background: var(--accent);
    transform: rotate(45deg);
  }
  .playhead-grab {
    position: absolute; top: 0; height: 20px; width: 14px;
    left: calc(106px + (100% - 106px) * var(--playhead-factor, 0));
    transform: translateX(-50%);
    cursor: ew-resize;
    z-index: 4;
    background: transparent;
  }
  .playhead-grab:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
  .timeline-panel #error, .timeline-panel #diagnostics { margin-top: 2px; }

  :fullscreen.monitor-panel {
    width: 100vw;
    height: 100vh;
    border: 0;
    background: var(--bg);
  }
  :fullscreen.monitor-panel .monitor-body { min-height: 0; }

  @media (max-width: 1180px) {
    #app { grid-template-columns: 240px minmax(0, 1fr) 280px; }
    .asset { grid-template-columns: 60px minmax(0, 1fr); }
    .asset-thumb { width: 60px; height: 34px; }
  }
  @media (max-width: 960px) {
    body { overflow: auto; }
    #app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 54px auto minmax(420px, 1fr) minmax(240px, 0.6fr) auto;
      height: auto;
      min-height: 100vh;
      overflow: auto;
    }
    .topbar { grid-column: 1; grid-row: 1; position: sticky; top: 0; z-index: 20; }
    .assets-panel { grid-column: 1; grid-row: 2; max-height: 210px; }
    .monitor-column { grid-column: 1; grid-row: 3; }
    .timeline-panel { grid-column: 1; grid-row: 4; min-height: 240px; }
    .inspector-panel { grid-column: 1; grid-row: 5; min-height: 300px; }
    .monitor-column.program-open { grid-template-rows: minmax(0, 1fr) minmax(240px, 0.6fr); }
    .topbar { flex-wrap: wrap; gap: 8px 14px; padding: 9px 14px; }
    .topbar-rule { display: none; }
  }
  @media (max-width: 640px) {
    .meta { display: none; }
    .monitor-head { flex-wrap: wrap; }
    .monitor-tools { width: 100%; margin-left: 0; flex-wrap: wrap; }
    .player-transport .scrub-wrap { flex-basis: 100%; }
    .asset { grid-template-columns: 52px minmax(0, 1fr); }
    .asset-thumb { width: 52px; height: 30px; }
  }
`;

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function transportId(monitor: "source" | "program", primary: boolean, name: string): string {
  if (primary) {
    return name;
  }
  return `${monitor === "source" ? "source" : "timeline"}-${name}`;
}

function transportHtml(monitor: "source" | "program", primary: boolean): string {
  const id = (name: string): string => transportId(monitor, primary, name);
  const playId = monitor === "source" ? "play" : "play-button";
  return `<footer class="transport player-transport ${monitor}-transport">
    <button id="${id("jump-back")}" class="jump" type="button" aria-label="Back one second" aria-keyshortcuts="Shift+ArrowLeft" title="Back one second (Shift+←)">&#8722;1s</button>
    <button id="${id("step-back")}" class="step" type="button" aria-label="Previous frame" aria-keyshortcuts="ArrowLeft" title="Previous frame (←)">&#8249;</button>
    <button id="${playId}" class="play" type="button" aria-label="Play">&#9654;</button>
    <button id="${id("step-forward")}" class="step" type="button" aria-label="Next frame" aria-keyshortcuts="ArrowRight" title="Next frame (→)">&#8250;</button>
    <button id="${id("jump-forward")}" class="jump" type="button" aria-label="Forward one second" aria-keyshortcuts="Shift+ArrowRight" title="Forward one second (Shift+→)">+1s</button>
    <div class="scrub-wrap"><input id="${id("scrub")}" class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="${monitor === "source" ? "Source frame" : "Timeline frame"}" /></div>
    <div class="readout">
      <span class="readout-label">frame</span>
      <span id="${id("frame")}">0</span><span class="dim">/</span><span id="${id("duration")}">0</span><span class="dim">f</span>
      <span class="dim">·</span><span id="${id("clock")}" class="clock">0.00s</span>
    </div>
    <label class="audio">
      <input id="${id("mute")}" type="checkbox" /> mute
      <input id="${id("volume")}" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Audio volume" />
    </label>
  </footer>`;
}

export function renderPreviewPage(options: PreviewPageOptions): string {
  const sourcePrimary = options.mode === "composition";
  const programPrimary = options.mode === "timeline";
  const tag = options.mode === "timeline" ? "timeline" : "preview";
  const title = options.mode === "timeline" ? "Frameyard Timeline" : "Frameyard Preview";
  const initialComposition =
    options.initialComposition !== undefined
      ? ` data-initial-composition="${escapeAttribute(options.initialComposition)}"`
      : "";
  const initialTimeline =
    options.initialTimeline !== undefined ? ` data-initial-timeline="${escapeAttribute(options.initialTimeline)}"` : "";
  const timelineId =
    options.mode === "timeline" && options.initialTimeline !== undefined
      ? ` data-timeline-id="${escapeAttribute(options.initialTimeline)}"`
      : "";
  const script = options.mode === "timeline" ? "timeline-main.js" : "main.js";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<script>${THEME_BOOT}</script>
<script type="importmap">${IMPORT_MAP}</script>
<style>
${PREVIEW_CSS}
${PAGE_CSS}
</style>
</head>
<body data-preview-mode="${options.mode}" data-embed="0"${initialComposition}${initialTimeline}${timelineId}>
<div id="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="wordmark">frameyard</span>
      <span class="slash">/</span>
      <span class="tag">${tag}</span>
    </div>
    <span class="topbar-rule"></span>
    <div id="meta" class="meta"></div>
    <div id="theme-toggle" class="theme-toggle" role="group" aria-label="Theme mode">
      <button id="theme-system" type="button" data-theme-mode="system" aria-pressed="true" title="Follow the system theme">system</button>
      <button id="theme-light" type="button" data-theme-mode="light" aria-pressed="false" title="Use the light theme">light</button>
      <button id="theme-dark" type="button" data-theme-mode="dark" aria-pressed="false" title="Use the dark theme">dark</button>
    </div>
  </header>

  <aside class="panel assets-panel" aria-label="Assets">
    <div class="panel-head">
      <span class="eyebrow">assets</span>
      <span id="asset-count" class="panel-index"></span>
    </div>
    <div class="panel-body">
      <div class="assets-filters">
        <input id="asset-filter" type="search" placeholder="filter assets" aria-label="Filter assets" autocomplete="off" spellcheck="false" />
      </div>
      <div class="asset-group">
        <h3>compositions</h3>
        <div id="composition-assets" class="asset-list"></div>
      </div>
      <div class="asset-group">
        <h3>timelines</h3>
        <div id="timeline-assets" class="asset-list"></div>
      </div>
      <div class="asset-group">
        <h3>media</h3>
        <div id="media-assets" class="asset-list"></div>
      </div>
    </div>
  </aside>

  <main class="monitor-column" id="monitor-column">
    <section id="monitor-panel" class="panel monitor-panel" aria-label="Monitor">
      <div class="monitor-tabs" role="tablist" aria-label="Monitor">
        <button id="tab-source" class="monitor-tab" type="button" role="tab" aria-controls="source-view" aria-selected="false">source</button>
        <button id="tab-program" class="monitor-tab" type="button" role="tab" aria-controls="program-view" aria-selected="false">program</button>
        <span class="monitor-tabs-spacer"></span>
        <button id="close-source" class="tab-close" type="button" title="Close source monitor" aria-label="Close source monitor" hidden>&times;</button>
        <button id="close-program" class="tab-close" type="button" title="Close program monitor" aria-label="Close program monitor" hidden>&times;</button>
      </div>
      <div class="monitor-head">
        <span id="monitor-eyebrow" class="eyebrow">source</span>
        <span id="monitor-title" class="panel-index"></span>
        <div class="monitor-tools">
          <button id="pan-toggle" class="tool" type="button" aria-pressed="false" title="Pan the monitor (hold Space)">hand</button>
          <div class="zoom-controls" role="group" aria-label="Monitor zoom">
            <button id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out">&minus;</button>
            <span id="zoom-readout" class="zoom-readout" aria-live="polite">fit</span>
            <button id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>
            <button id="zoom-fit" type="button" aria-label="Fit source" title="Fit source">fit</button>
            <button id="zoom-actual" type="button" aria-label="Actual size" title="Actual size">100%</button>
          </div>
          <button id="monitor-fullscreen" class="tool" type="button" aria-label="Enter fullscreen" title="Fullscreen">&#9974;</button>
        </div>
      </div>
      <div class="monitor-body">
        <div id="source-view" class="monitor-view" role="tabpanel" aria-labelledby="tab-source" hidden>
          <div id="source-viewport" class="viewport">
            <div class="viewport-scroll" data-monitor-scroll="source">
              <div id="stage-wrap" class="stage-wrap" hidden>
                <iframe id="stage-frame" class="stage-frame" title="Composition source" hidden></iframe>
              </div>
              <div id="source-timeline-wrap" class="stage-wrap" hidden>
                <iframe id="source-timeline-frame" class="source-timeline-frame" title="Nested timeline source" hidden></iframe>
              </div>
              <div id="source-media" class="source-media" hidden></div>
            </div>
            <div id="source-empty" class="empty-state">select a composition, clip, or asset</div>
            <div id="source-pan" class="pan-overlay" hidden aria-hidden="true"></div>
          </div>
          ${transportHtml("source", sourcePrimary)}
        </div>
        <div id="program-view" class="monitor-view" role="tabpanel" aria-labelledby="tab-program" hidden>
          <div id="program-viewport" class="viewport">
            <div class="viewport-scroll" data-monitor-scroll="program">
              <div id="program-stage-wrap" class="stage-wrap" hidden>
                <div id="stage"></div>
              </div>
            </div>
            <div id="program-empty" class="empty-state">select a timeline</div>
            <div id="program-pan" class="pan-overlay" hidden aria-hidden="true"></div>
          </div>
          ${transportHtml("program", programPrimary)}
        </div>
      </div>
      <div id="monitor-status" class="monitor-status" hidden>
        <div id="error" role="alert" hidden></div>
        <div id="diagnostics" hidden></div>
      </div>
    </section>

    <section id="timeline" class="panel timeline-panel" aria-label="Timeline" hidden>
      <div class="panel-head">
        <span class="eyebrow">timeline</span>
        <span id="timeline-meta" class="panel-index"></span>
        <div class="strip-tools" role="group" aria-label="Timeline zoom">
          <button id="timeline-zoom-out" type="button" aria-label="Zoom timeline out" title="Zoom out">&minus;</button>
          <span id="timeline-zoom-readout" class="zoom-readout" aria-live="polite">100%</span>
          <button id="timeline-zoom-in" type="button" aria-label="Zoom timeline in" title="Zoom in">+</button>
          <button id="timeline-zoom-fit" type="button" aria-label="Fit timeline" title="Fit timeline">fit</button>
        </div>
      </div>
      <div id="timeline-scroll" class="timeline-scroll">
        <div id="timeline-inner">
          <div class="ruler">
            <span class="ruler-spacer" aria-hidden="true"></span>
            <div id="ruler-scale" class="ruler-scale"></div>
          </div>
          <div id="tracks"></div>
          <div id="playhead" class="playhead" aria-hidden="true"></div>
          <div id="playhead-grab" class="playhead-grab" tabindex="0" role="slider" aria-label="Timeline playhead" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></div>
        </div>
      </div>
    </section>
  </main>

  <aside class="panel props-panel inspector-panel" aria-label="Props and inspector">
    <div class="panel-head">
      <span class="eyebrow">props + inspector</span>
      <span class="panel-index">json / read-only</span>
    </div>
    <div class="panel-tabs" role="tablist" aria-label="Props and inspector">
      <button id="tab-props" class="panel-tab" type="button" role="tab" aria-controls="props-view" aria-selected="true">props</button>
      <button id="tab-inspector" class="panel-tab" type="button" role="tab" aria-controls="inspector-view" aria-selected="false">inspector</button>
    </div>
    <div class="panel-body">
      <div id="props-view" class="props-view">
        <div class="field">
          <div class="field-head">
            <label for="props">props</label>
            <span id="props-dirty" class="badge" hidden>dirty</span>
            <button id="format" class="ghost small" type="button">format</button>
          </div>
          <textarea id="props" spellcheck="false" autocomplete="off"></textarea>
        </div>
        <div class="props-actions">
          <button id="apply" class="primary" type="button">apply props</button>
          <button id="props-reset" class="ghost small" type="button">reset</button>
        </div>
        <p id="props-syntax" class="hint error" hidden></p>
        <p id="props-hint" class="hint" hidden></p>
      </div>
      <div id="inspector-view" class="inspector-view" hidden>
        <div id="inspector-empty" class="inspector-empty">click an element or clip</div>
        <div id="inspector-host" class="inspector-host"></div>
      </div>
    </div>
  </aside>
</div>
<script type="module" src="/__frameyard/framework/preview/${script}"></script>
</body>
</html>`;
}
