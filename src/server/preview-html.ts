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

export function renderPreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Frameyard Preview</title>
<script type="importmap">${IMPORT_MAP}</script>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #11151a;
    --panel-2: #171c23;
    --line: #252c35;
    --text: #e8edf3;
    --muted: #8a97a6;
    --accent: #b8f36b;
    --accent-ink: #101408;
    --danger: #ff8a8a;
    --mono: "SFMono-Regular", ui-monospace, "Cascadia Code", "Liberation Mono", monospace;
    --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    overflow: hidden;
  }
  #app {
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    grid-template-rows: 54px minmax(0, 1fr) 58px;
    height: 100vh;
  }
  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 0 18px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #11151a, #0d1014);
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -0.01em; }
  .mark {
    width: 17px; height: 17px; border-radius: 4px;
    background: linear-gradient(135deg, var(--accent), #5fd6ff);
    box-shadow: 0 0 18px rgba(184, 243, 107, 0.3);
  }
  .tag { color: var(--muted); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
  .comp { display: flex; align-items: center; gap: 8px; color: var(--muted); }
  select, textarea, input { font: inherit; }
  select {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 9px;
    min-width: 160px;
  }
  .meta { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .panel {
    grid-row: 2 / 4;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border-right: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .field { display: flex; flex-direction: column; gap: 7px; min-height: 0; flex: 1; }
  .field-head { display: flex; align-items: center; justify-content: space-between; color: var(--muted); }
  .field-head label { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  textarea {
    flex: 1;
    min-height: 160px;
    resize: none;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 11px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    tab-size: 2;
  }
  textarea:focus, select:focus, input:focus-visible, button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
    outline-offset: 1px;
  }
  button {
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--text);
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
  }
  button:hover { border-color: #3a4654; }
  button:disabled { opacity: 0.45; cursor: default; }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
  }
  .ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .ghost:hover { color: var(--text); border-color: var(--line); }
  .small { padding: 3px 7px; font-size: 11px; }
  .error {
    border: 1px solid color-mix(in srgb, var(--danger) 42%, var(--line));
    background: color-mix(in srgb, var(--danger) 9%, var(--panel));
    color: var(--danger);
    border-radius: 7px;
    padding: 10px 11px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    max-height: 30vh;
    overflow: auto;
  }
  .hint { color: var(--muted); font-size: 11px; line-height: 1.5; }
  .hint code { font-family: var(--mono); color: #b9c5d2; }
  .viewport {
    grid-row: 2;
    grid-column: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 24px;
    background:
      radial-gradient(circle at 50% 40%, #161b22 0%, transparent 55%),
      repeating-conic-gradient(#0d1014 0% 25%, #0b0d10 0% 50%) 50% / 24px 24px;
  }
  .stage-wrap { position: relative; flex: 0 0 auto; }
  .stage { transform-origin: top left; overflow: hidden; background: #000; }
  .transport {
    grid-row: 3;
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 18px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .play {
    width: 34px; height: 34px; padding: 0; border-radius: 50%;
    background: var(--text); color: var(--bg); font-size: 12px; font-weight: 800;
  }
  .scrub { flex: 1; accent-color: var(--accent); }
  .readout { display: flex; align-items: baseline; gap: 5px; font-family: var(--mono); font-size: 11px; white-space: nowrap; }
  .readout .dim { color: #5c6875; }
  .clock { margin-left: 8px; color: var(--accent); }
  .audio { display: flex; align-items: center; gap: 7px; color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .audio input[type="range"] { width: 72px; accent-color: var(--accent); }

  body.render #app { display: block; height: auto; }
  body.render .topbar, body.render .panel, body.render .transport { display: none; }
  body.render .viewport {
    position: fixed;
    inset: 0;
    display: block;
    padding: 0;
    overflow: hidden;
    background: #000;
  }
  body.render .stage-wrap { position: absolute; inset: 0; width: auto !important; height: auto !important; }
  body.render .stage { transform: none !important; }
</style>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="brand"><span class="mark"></span>frameyard <span class="tag">preview</span></div>
    <label class="comp">Composition <select id="composition"></select></label>
    <div id="meta" class="meta"></div>
  </header>
  <aside id="panel" class="panel">
    <div class="field">
      <div class="field-head">
        <label for="props">Props (JSON)</label>
        <button id="format" class="ghost small" type="button">Format</button>
      </div>
      <textarea id="props" spellcheck="false" autocomplete="off"></textarea>
    </div>
    <button id="apply" class="primary" type="button">Apply props</button>
    <div id="error" class="error" role="alert" hidden></div>
    <div class="hint">
      Frames are derived from <code>frame</code> and <code>props</code> only.
      Wall-clock animation and unseeded randomness are not deterministic.
    </div>
  </aside>
  <main id="viewport" class="viewport">
    <div id="stage-wrap" class="stage-wrap"><div id="stage" class="stage"></div></div>
  </main>
  <footer class="transport">
    <button id="play" class="play" type="button" aria-label="Play">&#9654;</button>
    <input id="scrub" class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Frame" />
    <div class="readout">
      <span id="frame">0</span><span class="dim">/</span><span id="duration">0</span><span class="dim">f</span>
      <span id="clock" class="clock">0.00s</span>
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
