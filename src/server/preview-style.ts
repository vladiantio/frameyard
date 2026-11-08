/**
 * Shared visual language for the composition and timeline preview pages.
 *
 * Ink-and-paper surfaces, a single lime signal, hairline rules, and small
 * monospace instrument labels. System, Light, and Dark themes share the same
 * tokens; the composition and timeline canvases stay black in every mode. The
 * chrome bundles its own Figtree and Space Mono faces (`src/preview/fonts/`), so
 * the preview UI does not depend on the project's font manifest; the stacks fall
 * back to system faces if a face fails to load.
 *
 * The theme is applied through `data-theme` on the root element. The inline
 * boot script in the page shell resolves System/Light/Dark before first paint.
 */

export const PREVIEW_CSS = `
  @font-face {
    font-family: "Figtree";
    font-style: normal;
    font-display: swap;
    font-weight: 300 900;
    src: url("/__frameyard/framework/preview/fonts/figtree-latin-wght-normal.woff2") format("woff2");
  }
  @font-face {
    font-family: "Space Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 400;
    src: url("/__frameyard/framework/preview/fonts/space-mono-latin-400-normal.woff2") format("woff2");
  }
  @font-face {
    font-family: "Space Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 700;
    src: url("/__frameyard/framework/preview/fonts/space-mono-latin-700-normal.woff2") format("woff2");
  }
  :root {
    color-scheme: dark;
    --ink: #06080b;
    --bg: #080b0e;
    --panel: #0c1013;
    --panel-2: #11171b;
    --field: #06080b;
    --canvas: #000000;
    --viewport-bg: #06080b;
    --grid-line: rgba(238, 245, 235, 0.028);
    --viewport-glow: rgba(184, 243, 107, 0.05);
    --line: rgba(238, 245, 235, 0.12);
    --line-strong: rgba(238, 245, 235, 0.28);
    --paper: #f2f5ee;
    --muted: #8b9892;
    --muted-strong: #b8c2bc;
    --accent: #b8f36b;
    --accent-hover: #c9ff7e;
    --accent-ink: #0a1005;
    --accent-text: #b8f36b;
    --focus: #b8f36b;
    --danger: #ff9b8a;
    --danger-soft: rgba(255, 155, 138, 0.06);
    --danger-line: rgba(255, 155, 138, 0.35);
    --warning: #e8c76a;
    --warning-soft: rgba(232, 199, 106, 0.08);
    --shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    --shadow-soft: 0 24px 70px rgba(0, 0, 0, 0.55);
    --clip-bg: linear-gradient(180deg, rgba(74, 96, 118, 0.5), rgba(38, 52, 66, 0.55));
    --clip-border: rgba(140, 170, 195, 0.38);
    --clip-text: #dce8f5;
    --clip-comp-bg: linear-gradient(180deg, rgba(184, 243, 107, 0.2), rgba(184, 243, 107, 0.07));
    --clip-comp-border: rgba(184, 243, 107, 0.45);
    --clip-comp-text: var(--paper);
    --clip-audio-bg: linear-gradient(180deg, rgba(232, 199, 106, 0.2), rgba(232, 199, 106, 0.06));
    --clip-audio-border: rgba(232, 199, 106, 0.42);
    --clip-audio-text: #f4e7c4;
    --clip-nested-bg: linear-gradient(180deg, rgba(168, 130, 200, 0.22), rgba(168, 130, 200, 0.07));
    --clip-nested-border: rgba(168, 130, 200, 0.45);
    --clip-nested-text: #e8d9f5;
    --mono: "Space Mono", ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
    --sans: "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --ink: #eef1e9;
    --bg: #f3f4ef;
    --panel: #ffffff;
    --panel-2: #eceee7;
    --field: #f7f8f3;
    --canvas: #000000;
    --viewport-bg: #e8eae2;
    --grid-line: rgba(18, 23, 16, 0.05);
    --viewport-glow: rgba(63, 107, 0, 0.05);
    --line: rgba(18, 23, 16, 0.12);
    --line-strong: rgba(18, 23, 16, 0.28);
    --paper: #121710;
    --muted: #65705f;
    --muted-strong: #3d4739;
    --accent: #b8f36b;
    --accent-hover: #a6e84f;
    --accent-ink: #0a1005;
    --accent-text: #3f6b00;
    --focus: #3f6b00;
    --danger: #b3261e;
    --danger-soft: rgba(179, 38, 30, 0.07);
    --danger-line: rgba(179, 38, 30, 0.3);
    --warning: #8a6100;
    --warning-soft: rgba(138, 97, 0, 0.08);
    --shadow: 0 24px 80px rgba(18, 23, 16, 0.18);
    --shadow-soft: 0 24px 70px rgba(18, 23, 16, 0.16);
    --clip-bg: linear-gradient(180deg, rgba(74, 96, 118, 0.18), rgba(38, 52, 66, 0.1));
    --clip-border: rgba(60, 82, 104, 0.38);
    --clip-text: #1a2733;
    --clip-comp-bg: linear-gradient(180deg, rgba(74, 124, 0, 0.2), rgba(74, 124, 0, 0.08));
    --clip-comp-border: rgba(63, 107, 0, 0.45);
    --clip-comp-text: #1c2a0a;
    --clip-audio-bg: linear-gradient(180deg, rgba(138, 97, 0, 0.18), rgba(138, 97, 0, 0.07));
    --clip-audio-border: rgba(138, 97, 0, 0.42);
    --clip-audio-text: #3a2a00;
    --clip-nested-bg: linear-gradient(180deg, rgba(96, 64, 128, 0.18), rgba(96, 64, 128, 0.07));
    --clip-nested-border: rgba(96, 64, 128, 0.42);
    --clip-nested-text: #2a1a3a;
  }
  * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--line-strong); }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--paper);
    font-family: var(--sans);
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
    overflow: hidden;
  }
  a { color: var(--muted-strong); text-decoration: none; }
  a:hover { color: var(--accent-text); }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }

  /* Instrument labels */
  .eyebrow, .tag, .meta, .field-head label, .track-label, .readout-label, .comp, .audio {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .eyebrow, .tag, .track-label, .readout-label { font-size: 10px; color: var(--muted); }
  .tag { color: var(--muted-strong); }

  /* Header */
  header, .topbar {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 0 22px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, var(--panel), var(--bg));
  }
  .brand { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
  .mark {
    display: grid;
    grid-template-columns: repeat(2, 6px);
    grid-template-rows: repeat(2, 6px);
    gap: 2px;
    width: 14px;
    height: 14px;
  }
  .mark i { display: block; border: 1px solid var(--line-strong); }
  .mark i:nth-child(2) {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 10px rgba(184, 243, 107, 0.55);
  }
  .wordmark {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.24em;
    text-transform: uppercase;
  }
  .slash { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .topbar-rule { width: 1px; height: 20px; background: var(--line); flex: 0 0 auto; }
  .meta { margin-left: auto; font-size: 10px; color: var(--muted-strong); white-space: nowrap; }
  .title { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: 0.14em; text-transform: uppercase; }
  .comp { display: flex; align-items: center; gap: 9px; font-size: 10px; color: var(--muted); white-space: nowrap; }

  /* Theme control */
  .theme-toggle {
    display: flex;
    flex: 0 0 auto;
    border: 1px solid var(--line);
    background: var(--field);
  }
  .theme-toggle button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--muted);
    padding: 5px 7px;
    font-size: 9px;
  }
  .theme-toggle button + button { border-left: 1px solid var(--line); }
  .theme-toggle button:hover:not(:disabled) { color: var(--paper); border-color: transparent; }
  .theme-toggle button[aria-pressed="true"] {
    background: var(--accent);
    color: var(--accent-ink);
  }

  /* Form controls */
  select, textarea, input { font: inherit; }
  input[type="search"] {
    width: 100%;
    min-width: 0;
    background: var(--field);
    color: var(--paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 7px 9px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
  }
  input[type="search"]::placeholder { color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
  input[type="search"]:hover { border-color: var(--line-strong); }
  select {
    appearance: none;
    background-color: var(--field);
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 13px) 50%, calc(100% - 8px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    color: var(--paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 7px 26px 7px 10px;
    min-width: 148px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  select:hover, textarea:hover { border-color: var(--line-strong); }
  select:disabled { opacity: 0.45; cursor: default; }
  textarea {
    flex: 1;
    min-height: 140px;
    resize: none;
    background: var(--field);
    color: var(--paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    tab-size: 2;
  }
  textarea:read-only { color: var(--muted-strong); }

  /* Buttons */
  button {
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--muted-strong);
    border-radius: 2px;
    padding: 8px 12px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;
  }
  button:hover:not(:disabled) { border-color: var(--line-strong); color: var(--paper); }
  button:disabled { opacity: 0.35; cursor: default; }
  .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-ink); }
  .ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .ghost:hover:not(:disabled) { color: var(--paper); border-color: var(--line); }
  .small { padding: 3px 6px; font-size: 9px; }

  /* Transport */
  footer, .transport {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 22px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .step, .jump { width: 30px; height: 30px; padding: 0; color: var(--muted); font-size: 16px; line-height: 1; }
  .jump { width: auto; padding: 0 9px; font-size: 10px; }
  .step:hover:not(:disabled), .jump:hover:not(:disabled) { color: var(--paper); }
  .play {
    width: 34px; height: 34px; padding: 0; font-size: 13px;
    background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
  }
  .play:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-ink); }

  /* Tick-marked range rail */
  input[type="range"] { -webkit-appearance: none; appearance: none; background: transparent; margin: 0; cursor: pointer; }
  input[type="range"]:disabled { opacity: 0.35; cursor: default; }
  input[type="range"]::-webkit-slider-runnable-track { height: 2px; background: var(--line-strong); }
  input[type="range"]::-moz-range-track { height: 2px; background: var(--line-strong); }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 8px; height: 8px; margin-top: -3px;
    background: var(--accent); border: 0; border-radius: 0;
  }
  input[type="range"]::-moz-range-thumb { width: 8px; height: 8px; background: var(--accent); border: 0; border-radius: 0; }
  .scrub-wrap { position: relative; flex: 1; min-width: 60px; height: 34px; display: flex; align-items: center; }
  .scrub-wrap::before {
    content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 8px;
    transform: translateY(-50%);
    background-image: linear-gradient(90deg, var(--line-strong) 0 1px, transparent 1px);
    background-size: 10% 100%;
    opacity: 0.45;
    pointer-events: none;
  }
  .scrub { width: 100%; height: 34px; position: relative; z-index: 1; --progress: 0%; }
  .scrub::-webkit-slider-runnable-track {
    height: 2px;
    background: linear-gradient(90deg, var(--accent) 0 var(--progress), var(--line-strong) var(--progress) 100%);
  }
  .scrub::-moz-range-track {
    height: 2px;
    background: linear-gradient(90deg, var(--accent) 0 var(--progress), var(--line-strong) var(--progress) 100%);
  }
  .scrub::-webkit-slider-thumb {
    width: 3px; height: 16px; margin-top: -7px; border-radius: 0;
    box-shadow: 0 0 10px rgba(184, 243, 107, 0.75);
  }
  .scrub::-moz-range-thumb {
    width: 3px; height: 16px; border-radius: 0;
    box-shadow: 0 0 10px rgba(184, 243, 107, 0.75);
  }

  /* Readouts */
  .readout {
    display: flex; align-items: baseline; gap: 6px;
    font-family: var(--mono); font-size: 11px; font-variant-numeric: tabular-nums;
    white-space: nowrap; color: var(--muted);
  }
  .readout b, .readout #frame { color: var(--paper); font-weight: 500; }
  .readout .dim { color: var(--muted); }
  .readout .clock { color: var(--accent-text); margin-left: 2px; }
  .audio { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--muted); white-space: nowrap; }
  .audio input[type="checkbox"] { width: 12px; height: 12px; accent-color: var(--accent); }
  .audio input[type="range"] { width: 72px; }

  /* Messages */
  #error {
    border: 1px solid var(--danger-line);
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: 2px;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    max-height: 30vh;
    overflow: auto;
  }
  #diagnostics {
    border: 1px solid var(--line);
    background: var(--panel-2);
    border-radius: 2px;
    padding: 9px 11px;
    max-height: 26vh;
    overflow: auto;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.7;
    color: var(--muted);
  }
  #error[hidden], #diagnostics[hidden] { display: none; }
  .diagnostic { display: block; white-space: pre-wrap; }
  .diagnostic.warning { color: var(--warning); }
  .diagnostic.error { color: var(--danger); }

  /* Viewfinder */
  #viewport, .viewport {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 50% 38%, var(--viewport-glow), transparent 58%),
      linear-gradient(var(--grid-line) 1px, transparent 1px) 0 0 / 32px 32px,
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px) 0 0 / 32px 32px,
      var(--viewport-bg);
  }
  .viewport-scroll {
    position: absolute;
    inset: 0;
    display: flex;
    overflow: auto;
    padding: 16px;
    scrollbar-gutter: stable;
  }
  .stage-wrap {
    position: relative;
    flex: 0 0 auto;
    margin: auto;
    outline: 1px solid var(--line);
    box-shadow: var(--shadow);
    background: var(--canvas);
  }
  .stage-wrap[hidden] { display: none; }
  .stage-frame {
    position: absolute; top: 0; left: 0; border: 0;
    transform-origin: top left; background: var(--canvas); color-scheme: light;
  }
  .source-timeline-frame {
    position: absolute; top: 0; left: 0; border: 0;
    transform-origin: top left; background: transparent;
  }
  #stage {
    position: relative;
    transform-origin: top left;
    overflow: hidden;
    background: var(--canvas);
    isolation: isolate;
  }
  .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
  .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }
  .source-media {
    position: relative;
    flex: 0 0 auto;
    margin: auto;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: var(--canvas);
  }
  .source-media[hidden] { display: none; }
  .source-media img, .source-media video {
    display: block;
    width: 100%;
    height: 100%;
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
  .pan-overlay {
    position: absolute;
    inset: 0;
    z-index: 4;
    cursor: grab;
    background: transparent;
  }
  .pan-overlay[hidden] { display: none; }
  .pan-overlay.dragging { cursor: grabbing; }

  /* Inspector */
  .inspector {
    position: fixed; top: 64px; right: 18px; bottom: 76px; width: 360px;
    z-index: 50; display: flex; flex-direction: column; gap: 10px;
    padding: 14px; overflow: auto; color: var(--paper);
    border: 1px solid var(--line-strong); background: var(--panel);
    box-shadow: var(--shadow-soft);
    font-family: var(--sans); font-size: 12px;
  }
  .inspector[hidden] { display: none; }
  .inspector.docked {
    position: static; inset: auto; width: auto; max-height: none;
    padding: 0; border: 0; background: transparent; box-shadow: none;
    overflow: visible;
  }
  .inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .inspector-close {
    width: 24px; height: 24px; padding: 0; border: 1px solid var(--line);
    background: transparent; color: var(--muted-strong); cursor: pointer;
    font: 16px/1 var(--mono);
  }
  .inspector-close:hover { color: var(--accent-text); border-color: var(--focus); }
  .inspector-title { margin: 0; font-size: 16px; line-height: 1.2; letter-spacing: -0.02em; }
  .inspector-subtitle { margin: -4px 0 0; color: var(--muted); font-family: var(--mono); font-size: 10px; }
  .inspector-content { display: flex; flex-direction: column; gap: 12px; }
  .inspector-section { border-top: 1px solid var(--line); padding-top: 9px; }
  .inspector-section h3 {
    margin: 0 0 6px; color: var(--muted-strong); font-family: var(--mono);
    font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
  }
  .inspector-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; padding: 2px 0; }
  .inspector-label { color: var(--muted); font-size: 10px; }
  .inspector-value {
    color: var(--paper); font-size: 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .inspector-value.mono { font-family: var(--mono); }
  .inspector-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
  .inspector-actions a { text-decoration: none; }
  .inspector-actions .ghost:disabled { opacity: 0.4; cursor: default; }
  .inspector-diagnostics { display: flex; flex-direction: column; gap: 5px; border-top: 1px solid var(--line); padding-top: 9px; }
  .inspector-diagnostic { font-family: var(--mono); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
  .inspector-diagnostic.warning { color: var(--warning); }
  .inspector-diagnostic.error { color: var(--danger); }
  .inspector-diagnostic a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .inspector-status { min-height: 14px; margin: 0; color: var(--accent-text); font-family: var(--mono); font-size: 9px; }
  @media (max-width: 760px) {
    .inspector {
      top: auto; left: 12px; right: 12px; bottom: 64px; width: auto; max-height: 48vh;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
  }
`;
