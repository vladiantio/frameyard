/**
 * Shared visual language for the composition and timeline preview pages.
 *
 * Ink-black surfaces, paper-white type, a single lime signal, hairline rules,
 * and small monospace instrument labels. The chrome bundles its own Figtree and
 * Space Mono faces (`src/preview/fonts/`), so the preview UI does not depend on
 * the project's font manifest; the stacks fall back to system faces if a face
 * fails to load.
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
    --line: rgba(238, 245, 235, 0.12);
    --line-strong: rgba(238, 245, 235, 0.28);
    --paper: #f2f5ee;
    --muted: #8b9892;
    --muted-strong: #b8c2bc;
    --accent: #b8f36b;
    --accent-ink: #0a1005;
    --danger: #ff9b8a;
    --warning: #e8c76a;
    --mono: "Space Mono", ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
    --sans: "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
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
  a:hover { color: var(--accent); }
  :focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

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

  /* Form controls */
  select, textarea, input { font: inherit; }
  select {
    appearance: none;
    background-color: var(--ink);
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
    background: var(--ink);
    color: var(--paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    tab-size: 2;
  }

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
  .primary:hover:not(:disabled) { background: #c9ff7e; border-color: #c9ff7e; color: var(--accent-ink); }
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
  .play:hover:not(:disabled) { background: #c9ff7e; border-color: #c9ff7e; color: var(--accent-ink); }

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
  .readout .dim { color: #5b6660; }
  .readout .clock { color: var(--accent); margin-left: 2px; }
  .audio { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--muted); white-space: nowrap; }
  .audio input[type="checkbox"] { width: 12px; height: 12px; accent-color: var(--accent); }
  .audio input[type="range"] { width: 72px; }

  /* Messages */
  #error {
    border: 1px solid rgba(255, 155, 138, 0.35);
    background: rgba(255, 155, 138, 0.06);
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
    display: grid;
    place-items: center;
    padding: 28px;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 50% 38%, rgba(184, 243, 107, 0.05), transparent 58%),
      linear-gradient(rgba(238, 245, 235, 0.028) 1px, transparent 1px) 0 0 / 32px 32px,
      linear-gradient(90deg, rgba(238, 245, 235, 0.028) 1px, transparent 1px) 0 0 / 32px 32px,
      var(--ink);
  }
  #stage-wrap {
    position: relative;
    outline: 1px solid var(--line);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    background: var(--ink);
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
  }
`;
