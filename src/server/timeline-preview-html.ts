function escapeHtml(value: string): string {
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

const IMPORT_MAP = JSON.stringify({
  imports: {
    frameyard: "/__frameyard/framework/index.js",
    "frameyard/runtime": "/__frameyard/framework/runtime/index.js",
  },
});

export function renderTimelinePreviewHtml(timelineId: string, options: { embed?: boolean } = {}): string {
  const id = escapeHtml(timelineId);
  if (options.embed) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frameyard timeline ${id}</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
      .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }
    </style>
    <script type="importmap" data-fy-host>${IMPORT_MAP}</script>
  </head>
  <body data-timeline-id="${id}" data-embed="1">
    <div id="stage"></div>
    <script type="module" src="/__frameyard/framework/preview/timeline-main.js"></script>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frameyard timeline ${id}</title>
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
        grid-template-rows: 54px minmax(0, 1fr) 210px 58px;
        height: 100vh;
      }
      header {
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 0 18px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, #11151a, #0d1014);
      }
      .brand { display: flex; align-items: center; gap: 9px; font-weight: 650; }
      .mark {
        width: 17px; height: 17px; border-radius: 4px;
        background: linear-gradient(135deg, var(--accent), #5fd6ff);
        box-shadow: 0 0 18px rgba(184, 243, 107, 0.3);
      }
      .tag { color: var(--muted); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .meta { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 11px; }
      #viewport {
        min-height: 0;
        display: grid;
        place-items: center;
        padding: 20px;
        overflow: hidden;
        background:
          radial-gradient(circle at 50% 20%, #141b24 0, transparent 55%),
          #080a0d;
      }
      #stage-wrap {
        position: relative;
        overflow: hidden;
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.55);
        background: #000;
      }
      #stage {
        position: relative;
        transform-origin: top left;
        overflow: hidden;
        background: #000;
      }
      .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
      .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }
      #timeline {
        position: relative;
        min-height: 0;
        border-top: 1px solid var(--line);
        background: var(--panel);
        overflow: auto;
        padding: 10px 16px 16px;
      }
      #tracks { position: relative; display: flex; flex-direction: column; gap: 6px; }
      .track { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; min-height: 30px; }
      .track-label {
        display: flex; align-items: center; justify-content: flex-end;
        color: var(--muted); font-family: var(--mono); font-size: 10px;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .lane {
        position: relative; border: 1px solid var(--line); border-radius: 6px;
        background: #0d1116; overflow: hidden;
      }
      .clip {
        position: absolute; top: 3px; bottom: 3px; border-radius: 4px;
        background: linear-gradient(180deg, #2a4058, #1d2c3d);
        border: 1px solid #3b5672; color: #dce8f5;
        font: 10px/1 var(--mono); padding: 6px 7px; overflow: hidden;
        white-space: nowrap; text-overflow: ellipsis;
      }
      .clip.composition { background: linear-gradient(180deg, #314a33, #203120); border-color: #4d704d; }
      .clip.audio { background: linear-gradient(180deg, #4a3b22, #302516); border-color: #6e5631; }
      .clip.nested { background: linear-gradient(180deg, #443152, #2c2036); border-color: #63477a; }
      #playhead {
        position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent);
        box-shadow: 0 0 12px rgba(184, 243, 107, 0.7); pointer-events: none;
      }
      #error, #diagnostics {
        margin-top: 10px; border: 1px solid #4b3030; border-radius: 6px;
        padding: 9px 11px; background: #1b1111; color: var(--danger);
        font-family: var(--mono); font-size: 11px; white-space: pre-wrap;
      }
      #diagnostics { border-color: var(--line); background: var(--panel-2); color: var(--muted); }
      footer {
        display: flex; align-items: center; gap: 12px; padding: 0 18px;
        border-top: 1px solid var(--line); background: var(--panel);
      }
      button {
        border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
        border-radius: 6px; padding: 8px 12px; cursor: pointer;
      }
      button:hover { border-color: #3a4654; }
      .play {
        width: 38px; height: 38px; border-radius: 50%; border: 0;
        background: var(--accent); color: var(--accent-ink);
        font-size: 15px; font-weight: 700;
      }
      .scrub { flex: 1; accent-color: var(--accent); }
      .readout { min-width: 150px; text-align: right; color: var(--muted); font-family: var(--mono); font-size: 11px; }
      .readout b { color: var(--text); font-weight: 600; }
      .audio { display: flex; align-items: center; gap: 8px; color: var(--muted); font-family: var(--mono); font-size: 11px; }
      .audio input[type="range"] { width: 80px; accent-color: var(--accent); }
      .hint { color: var(--muted); font-family: var(--mono); font-size: 10px; }
    </style>
    <script type="importmap" data-fy-host>${IMPORT_MAP}</script>
  </head>
  <body data-timeline-id="${id}" data-embed="0">
    <div id="app">
      <header>
        <div class="brand"><span class="mark"></span>frameyard <span class="tag">timeline</span></div>
        <a href="/__frameyard/">← compositions</a>
        <span id="title" class="hint"></span>
        <div id="meta" class="meta"></div>
      </header>
      <main id="viewport">
        <div id="stage-wrap"><div id="stage"></div></div>
      </main>
      <section id="timeline">
        <div id="tracks"></div>
        <div id="playhead"></div>
        <div id="error" role="alert" hidden></div>
        <div id="diagnostics" hidden></div>
      </section>
      <footer>
        <button id="play-button" class="play" type="button" aria-label="Play">&#9654;</button>
        <input id="scrub" class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Timeline frame">
        <div class="readout"><b id="frame">0</b> / <span id="duration">0</span> f <span id="clock">0.00s</span></div>
        <label class="audio"><input id="mute" type="checkbox"> mute <input id="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Audio volume"></label>
      </footer>
    </div>
    <script type="module" src="/__frameyard/framework/preview/timeline-main.js"></script>
  </body>
</html>`;
}
