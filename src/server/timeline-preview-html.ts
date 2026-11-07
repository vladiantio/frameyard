import { PREVIEW_CSS } from "./preview-style.js";

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

const PAGE_CSS = `
  #app {
    display: grid;
    grid-template-rows: 54px minmax(0, 1fr) 216px 58px;
    height: 100vh;
  }
  #viewport { min-height: 0; }
  #stage-wrap { overflow: hidden; }
  #stage {
    position: relative;
    width: 100%; height: 100%;
    transform-origin: top left;
    overflow: hidden;
    background: #000;
    isolation: isolate;
  }
  .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
  .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }

  #timeline {
    position: relative;
    min-height: 0;
    border-top: 1px solid var(--line);
    background: var(--panel);
    overflow: auto;
    padding: 12px 18px 16px;
  }
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
  #timeline #error, #timeline #diagnostics { margin-top: 10px; }

  @media (max-width: 760px) {
    #app { grid-template-rows: 54px minmax(0, 1fr) 180px auto; }
    footer { flex-wrap: wrap; padding: 9px 14px; }
    .meta { display: none; }
  }
`;

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
      #stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: transparent; isolation: isolate; }
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
${PREVIEW_CSS}
${PAGE_CSS}
    </style>
    <script type="importmap" data-fy-host>${IMPORT_MAP}</script>
  </head>
  <body data-timeline-id="${id}" data-embed="0">
    <div id="app">
      <header>
        <div class="brand">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="wordmark">frameyard</span>
          <span class="slash">/</span>
          <span class="tag">timeline</span>
        </div>
        <span class="topbar-rule"></span>
        <a href="/__frameyard/">&larr; compositions</a>
        <span id="title" class="title"></span>
        <div id="meta" class="meta"></div>
      </header>
      <main id="viewport">
        <div id="stage-wrap">
          <div id="stage"></div>
        </div>
      </main>
      <section id="timeline">
        <div id="timeline-inner">
          <div class="ruler">
            <span class="ruler-spacer" aria-hidden="true"></span>
            <div id="ruler-scale" class="ruler-scale"></div>
          </div>
          <div id="tracks"></div>
          <div id="playhead" class="playhead" aria-hidden="true"></div>
        </div>
        <div id="error" role="alert" hidden></div>
        <div id="diagnostics" hidden></div>
      </section>
      <footer>
        <button id="jump-back" class="jump" type="button" aria-label="Back one second" aria-keyshortcuts="Shift+ArrowLeft" title="Back one second (Shift+←)">&#8722;1s</button>
        <button id="step-back" class="step" type="button" aria-label="Previous frame" aria-keyshortcuts="ArrowLeft" title="Previous frame (←)">&#8249;</button>
        <button id="play-button" class="play" type="button" aria-label="Play">&#9654;</button>
        <button id="step-forward" class="step" type="button" aria-label="Next frame" aria-keyshortcuts="ArrowRight" title="Next frame (→)">&#8250;</button>
        <button id="jump-forward" class="jump" type="button" aria-label="Forward one second" aria-keyshortcuts="Shift+ArrowRight" title="Forward one second (Shift+→)">+1s</button>
        <div class="scrub-wrap"><input id="scrub" class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Timeline frame"></div>
        <div class="readout"><span class="readout-label">frame</span><span id="frame">0</span><span class="dim">/</span><span id="duration">0</span><span class="dim">f</span><span class="dim">·</span><span id="clock" class="clock">0.00s</span></div>
        <label class="audio"><input id="mute" type="checkbox"> mute <input id="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Audio volume"></label>
      </footer>
    </div>
    <script type="module" src="/__frameyard/framework/preview/timeline-main.js"></script>
  </body>
</html>`;
}
