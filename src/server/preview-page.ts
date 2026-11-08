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

export type PreviewMode = "composition" | "timeline";

export interface PreviewPageOptions {
  mode: PreviewMode;
  initialComposition?: string;
  initialTimeline?: string;
}

const PAGE_CSS = `
  #app {
    display: grid;
    grid-template-columns: minmax(230px, 300px) minmax(0, 1.25fr) minmax(270px, 0.95fr);
    grid-template-rows: 54px minmax(0, 1.05fr) minmax(200px, 0.95fr);
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
    justify-content: space-between;
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
  .field { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .assets-panel { grid-column: 1; grid-row: 2; }
  .source-panel { grid-column: 2; grid-row: 2; }
  .program-panel { grid-column: 3; grid-row: 2; }
  .props-panel { grid-column: 1; grid-row: 3; }
  .timeline-panel { grid-column: 2 / 4; grid-row: 3; }
  .player-panel { overflow: hidden; }
  .player-panel .viewport {
    flex: 1 1 auto;
    min-height: 0;
    padding: 16px;
  }
  .stage-frame {
    position: absolute; top: 0; left: 0; border: 0;
    transform-origin: top left; background: #000; color-scheme: light;
  }
  .source-timeline-frame {
    position: absolute; top: 0; left: 0; border: 0;
    transform-origin: top left; background: transparent;
  }
  .stage-wrap {
    position: relative;
    outline: 1px solid var(--line);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    background: var(--ink);
  }
  #stage {
    position: relative;
    transform-origin: top left;
    overflow: hidden;
    background: #000;
    isolation: isolate;
  }
  .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
  .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }
  .source-media {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .source-media img, .source-media video {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .media-placeholder {
    display: grid;
    place-items: center;
    gap: 8px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.6;
    text-align: center;
    overflow-wrap: anywhere;
    padding: 20px;
  }
  .media-placeholder strong { color: var(--muted-strong); font-weight: 400; }
  .empty-state {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-height: 80px;
    padding: 16px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-align: center;
    text-transform: uppercase;
  }
  .empty-state[hidden] { display: none; }
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

  .assets-filters {
    display: grid;
    gap: 4px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--line);
  }
  .assets-filters .field-head { display: flex; align-items: center; justify-content: space-between; }
  .assets-filters .field-head label { font-size: 9px; color: var(--muted); }
  .assets-filters select { width: 100%; min-width: 0; }
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
    grid-template-columns: 84px minmax(0, 1fr);
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
  .asset:hover:not(:disabled) { border-color: var(--line-strong); color: var(--paper); }
  .asset.selected { border-color: var(--accent); }
  .asset-thumb {
    position: relative;
    display: grid;
    place-items: center;
    width: 84px;
    height: 47px;
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--ink);
  }
  .asset-thumb iframe {
    position: absolute;
    border: 0;
    transform-origin: top left;
    background: #000;
    color-scheme: light;
    pointer-events: none;
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
    letter-spacing: 0.12em;
    text-transform: uppercase;
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

  .props-view { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .props-panel[data-inspecting="true"] .props-view { display: none; }
  .props-view .field { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  .props-view textarea { min-height: 90px; }
  .hint {
    margin: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 9px;
    line-height: 1.6;
  }
  .hint[hidden] { display: none; }
  .inspector-host { display: block; min-height: 0; }
  .inspector.docked {
    position: static; inset: auto; width: auto; max-height: none;
    padding: 0; border: 0; background: transparent; box-shadow: none;
    overflow: visible;
  }

  .timeline-panel { overflow: hidden; }
  .timeline-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 18px 16px; }
  .ruler {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 10px;
    height: 20px;
  }
  .ruler-scale { position: relative; border-bottom: 1px solid var(--line); }
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
  #timeline-inner { position: relative; }
  #tracks { position: relative; display: flex; flex-direction: column; }
  .track { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; min-height: 30px; }
  .track-label {
    display: flex; align-items: center; justify-content: flex-end;
    font-size: 9px; white-space: nowrap;
  }
  .lane {
    position: relative; border: 1px solid var(--line);
    background: var(--ink); overflow: hidden;
  }
  .clip {
    position: absolute; top: 3px; bottom: 3px; border-radius: 1px;
    background: linear-gradient(180deg, rgba(74, 96, 118, 0.5), rgba(38, 52, 66, 0.55));
    border: 1px solid rgba(140, 170, 195, 0.38); color: #dce8f5;
    font: 10px/1 var(--mono); padding: 6px 8px; overflow: visible;
    white-space: nowrap;
  }
  .clip-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clip.composition {
    background: linear-gradient(180deg, rgba(184, 243, 107, 0.20), rgba(184, 243, 107, 0.07));
    border-color: rgba(184, 243, 107, 0.45); color: var(--paper);
  }
  .clip.audio {
    background: linear-gradient(180deg, rgba(232, 199, 106, 0.20), rgba(232, 199, 106, 0.06));
    border-color: rgba(232, 199, 106, 0.42); color: #f4e7c4;
  }
  .clip.nested {
    background: linear-gradient(180deg, rgba(168, 130, 200, 0.22), rgba(168, 130, 200, 0.07));
    border-color: rgba(168, 130, 200, 0.45); color: #e8d9f5;
  }
  .clip.selected {
    outline: 2px solid var(--accent); outline-offset: -2px;
    box-shadow: 0 0 14px rgba(184, 243, 107, 0.5);
  }
  .clip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .keyframe-marker {
    position: absolute; top: 50%; width: 7px; height: 7px;
    background: var(--accent); border: 1px solid var(--ink); border-radius: 1px;
    transform: translate(-50%, -50%) rotate(45deg); cursor: pointer; z-index: 2;
  }
  .keyframe-marker:hover { background: #ffffff; }
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
  .props-panel #error, .props-panel #diagnostics { margin-top: 2px; }

  @media (max-width: 900px) {
    #app {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-rows: auto auto minmax(260px, 1fr) minmax(240px, 1fr);
      height: auto;
      min-height: 100vh;
      overflow: auto;
    }
    .assets-panel { grid-column: 1 / -1; grid-row: 2; max-height: 190px; }
    .source-panel { grid-column: 1; grid-row: 3; }
    .program-panel { grid-column: 2; grid-row: 3; }
    .props-panel { grid-column: 1; grid-row: 4; }
    .timeline-panel { grid-column: 2; grid-row: 4; min-height: 260px; }
    .topbar { flex-wrap: wrap; gap: 8px 14px; padding: 9px 14px; }
    .topbar-rule { display: none; }
  }
  @media (max-width: 640px) {
    #app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 54px auto repeat(4, minmax(220px, 1fr));
    }
    .assets-panel, .source-panel, .program-panel, .props-panel, .timeline-panel {
      grid-column: 1;
    }
    .assets-panel { grid-row: 2; }
    .source-panel { grid-row: 3; }
    .program-panel { grid-row: 4; }
    .props-panel { grid-row: 5; }
    .timeline-panel { grid-row: 6; }
    .player-transport .scrub-wrap { flex-basis: 100%; }
    .meta { display: none; }
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
  </header>

  <aside class="panel assets-panel" aria-label="Assets, compositions, and timelines">
    <div class="panel-head">
      <span class="eyebrow">assets</span>
      <span id="asset-count" class="panel-index"></span>
    </div>
    <div class="panel-body">
      <div class="assets-filters">
        <div class="field-head"><label for="composition">composition</label></div>
        <select id="composition"></select>
        <div class="field-head"><label for="timeline">timeline</label></div>
        <select id="timeline"></select>
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
        <h3>assets</h3>
        <div id="media-assets" class="asset-list"></div>
      </div>
    </div>
  </aside>

  <section class="panel player-panel source-panel" aria-label="Asset, clip, and composition preview player">
    <div class="panel-head">
      <span class="eyebrow">asset / clip / composition</span>
      <span id="source-title" class="panel-index"></span>
    </div>
    <div id="source-viewport" class="viewport">
      <div id="stage-wrap" class="stage-wrap" hidden>
        <iframe id="stage-frame" class="stage-frame" title="Composition source" hidden></iframe>
      </div>
      <div id="source-timeline-wrap" class="stage-wrap" hidden>
        <iframe id="source-timeline-frame" class="source-timeline-frame" title="Nested timeline source" hidden></iframe>
      </div>
      <div id="source-media" class="source-media" hidden></div>
      <div id="source-empty" class="empty-state">select a composition, clip, or asset</div>
    </div>
    ${transportHtml("source", sourcePrimary)}
  </section>

  <section class="panel player-panel program-panel" aria-label="Timeline player">
    <div class="panel-head">
      <span class="eyebrow">timeline player</span>
      <span id="title" class="panel-index"></span>
    </div>
    <div id="program-viewport" class="viewport">
      <div id="program-stage-wrap" class="stage-wrap" hidden>
        <div id="stage"></div>
      </div>
      <div id="program-empty" class="empty-state">select a timeline</div>
    </div>
    ${transportHtml("program", programPrimary)}
  </section>

  <aside class="panel props-panel" aria-label="Props and inspector">
    <div class="panel-head">
      <span class="eyebrow">props + inspector</span>
      <span class="panel-index">json / read-only</span>
    </div>
    <div class="panel-body">
      <div id="props-view" class="props-view">
        <div class="field">
          <div class="field-head">
            <label for="props">props</label>
            <button id="format" class="ghost small" type="button">format</button>
          </div>
          <textarea id="props" spellcheck="false" autocomplete="off"></textarea>
        </div>
        <button id="apply" class="primary" type="button">apply props</button>
        <p id="props-hint" class="hint" hidden></p>
      </div>
      <div id="inspector-host" class="inspector-host"></div>
      <div id="error" role="alert" hidden></div>
      <div id="diagnostics" hidden></div>
    </div>
  </aside>

  <section id="timeline" class="panel timeline-panel" aria-label="Timeline">
    <div class="panel-head">
      <span class="eyebrow">timeline</span>
      <span id="timeline-meta" class="panel-index"></span>
    </div>
    <div class="timeline-scroll">
      <div id="timeline-inner">
        <div class="ruler">
          <span class="ruler-spacer" aria-hidden="true"></span>
          <div id="ruler-scale" class="ruler-scale"></div>
        </div>
        <div id="tracks"></div>
        <div id="playhead" class="playhead" aria-hidden="true"></div>
      </div>
    </div>
  </section>
</div>
<script type="module" src="/__frameyard/framework/preview/${script}"></script>
</body>
</html>`;
}
