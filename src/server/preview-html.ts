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

const PAGE_CSS = `
  #app {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    grid-template-rows: 54px minmax(0, 1fr) 58px;
    height: 100vh;
  }
  .topbar { grid-column: 1 / -1; }
  .panel {
    grid-row: 2 / 4;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
    border-right: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .panel-head { display: flex; align-items: center; justify-content: space-between; }
  .panel-head .eyebrow { color: var(--muted-strong); }
  .panel-index {
    font-family: var(--mono); font-size: 9px; color: var(--muted);
    letter-spacing: 0.14em; text-transform: uppercase;
  }
  .field { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  .field-head { display: flex; align-items: center; justify-content: space-between; }
  .field-head label { font-size: 10px; color: var(--muted); }
  .stage-frame {
    position: absolute; top: 0; left: 0; border: 0;
    transform-origin: top left; background: #000; color-scheme: light;
  }
  .viewport { grid-row: 2; grid-column: 2; }
  .transport { grid-row: 3; grid-column: 2; }

  @media (max-width: 760px) {
    #app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto minmax(0, 38vh);
    }
    .topbar { flex-wrap: wrap; gap: 8px 14px; padding: 9px 14px; }
    .transport { flex-wrap: wrap; padding: 9px 14px; }
    .topbar-rule { display: none; }
    select { min-width: 120px; max-width: 100%; }
    .panel {
      grid-row: 4; grid-column: 1;
      border-right: 0; border-top: 1px solid var(--line);
      overflow: auto;
    }
    .panel > * { flex-shrink: 0; }
    .field { flex: 0 0 auto; }
    textarea { flex: 0 0 auto; height: 120px; min-height: 0; }
    .viewport { grid-row: 2; grid-column: 1; }
    .transport { grid-row: 3; grid-column: 1; }
    .meta { display: none; }
  }
`;

export function renderPreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Frameyard Preview</title>
<script type="importmap">${IMPORT_MAP}</script>
<style>
${PREVIEW_CSS}
${PAGE_CSS}
</style>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="wordmark">frameyard</span>
      <span class="slash">/</span>
      <span class="tag">preview</span>
    </div>
    <span class="topbar-rule"></span>
    <label class="comp">composition <select id="composition"></select></label>
    <label class="comp">timeline <select id="timeline"></select></label>
    <div id="meta" class="meta"></div>
  </header>
  <aside id="panel" class="panel">
    <div class="panel-head">
      <span class="eyebrow">input</span>
      <span class="panel-index">props / json</span>
    </div>
    <div class="field">
      <div class="field-head">
        <label for="props">props</label>
        <button id="format" class="ghost small" type="button">format</button>
      </div>
      <textarea id="props" spellcheck="false" autocomplete="off"></textarea>
    </div>
    <button id="apply" class="primary" type="button">apply props</button>
    <div id="error" role="alert" hidden></div>
    <div id="diagnostics" hidden></div>
  </aside>
  <main id="viewport" class="viewport">
    <div id="stage-wrap" class="stage-wrap">
      <iframe id="stage-frame" class="stage-frame" title="Composition" hidden></iframe>
    </div>
  </main>
  <footer class="transport">
    <button id="jump-back" class="jump" type="button" aria-label="Back one second" aria-keyshortcuts="Shift+ArrowLeft" title="Back one second (Shift+←)">&#8722;1s</button>
    <button id="step-back" class="step" type="button" aria-label="Previous frame" aria-keyshortcuts="ArrowLeft" title="Previous frame (←)">&#8249;</button>
    <button id="play" class="play" type="button" aria-label="Play">&#9654;</button>
    <button id="step-forward" class="step" type="button" aria-label="Next frame" aria-keyshortcuts="ArrowRight" title="Next frame (→)">&#8250;</button>
    <button id="jump-forward" class="jump" type="button" aria-label="Forward one second" aria-keyshortcuts="Shift+ArrowRight" title="Forward one second (Shift+→)">+1s</button>
    <div class="scrub-wrap"><input id="scrub" class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Frame" /></div>
    <div class="readout">
      <span class="readout-label">frame</span>
      <span id="frame">0</span><span class="dim">/</span><span id="duration">0</span><span class="dim">f</span>
      <span class="dim">·</span><span id="clock" class="clock">0.00s</span>
    </div>
    <label class="audio">
      <input id="mute" type="checkbox" /> mute
      <input id="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Audio volume" />
    </label>
  </footer>
</div>
<script type="module" src="/__frameyard/framework/preview/main.js"></script>
</body>
</html>`;
}
