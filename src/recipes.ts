import { findTemplate, type TemplateKind } from "./templates.js";

export type RecipeKind = "composition" | "timeline" | "bundle";

export interface RecipeFile {
  /** Project-relative path template; `{id}` is replaced with the project id. */
  path: string;
  /** File content for a project id. */
  content: (id: string) => string;
}

export interface RecipeEntry {
  kind: TemplateKind;
  /** Project id template; `{id}` is replaced with the project id. */
  id: string;
  /** Project-relative entry path template; `{id}` is replaced with the project id. */
  entry: string;
}

export interface ProjectRecipe {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  kind: RecipeKind;
  files: readonly RecipeFile[];
  entries: readonly RecipeEntry[];
  prerequisites?: readonly string[];
}

export interface RecipeInstallFile {
  path: string;
  content: string;
}

export interface RecipeInstallEntry {
  kind: TemplateKind;
  id: string;
  entry: string;
}

export interface RecipeInstallPlan {
  files: RecipeInstallFile[];
  entries: RecipeInstallEntry[];
}

function builtInTemplate(name: string): string {
  const template = findTemplate(name);
  if (template === undefined) {
    throw new Error(`Built-in template "${name}" is missing.`);
  }
  return template.content;
}

function hydrate(template: string, id: string): string {
  return template.replaceAll("{id}", id);
}

function renderFiles(files: readonly RecipeFile[], id: string): RecipeInstallFile[] {
  return files.map((file) => ({
    path: hydrate(file.path, id),
    content: file.content(id),
  }));
}

function compositionReadme(options: {
  id: string;
  title: string;
  description: string;
  extraFiles?: readonly string[];
  notes?: readonly string[];
}): string {
  const { id, title, description, extraFiles = [], notes = [] } = options;
  const files = [`compositions/${id}.html`, `props/${id}.json`, ...extraFiles.map((file) => hydrate(file, id))];
  return [
    `# ${id}`,
    "",
    `Recipe: **${title}**`,
    "",
    description,
    "",
    "Files:",
    ...files.map((file) => `- \`${file}\``),
    "",
    "Register in `fy.config.js`:",
    "",
    "```js",
    "export default {",
    "  format: { width: 1920, height: 1080, fps: 30 },",
    `  compositions: { "${id}": "./compositions/${id}.html" },`,
    "};",
    "```",
    "",
    "Preview and render:",
    "",
    "```sh",
    "npx frameyard dev",
    `npx frameyard check ${id}`,
    `npx frameyard still ${id} --frame 30 --out out/${id}.png`,
    `npx frameyard render ${id}`,
    "```",
    "",
    "Agent prompt:",
    "",
    `> Start from the \`${id}\` recipe. Keep the layout, replace the props and copy, and verify with \`npx frameyard check ${id}\`.`,
    "",
    ...(notes.length > 0 ? ["Notes:", "", ...notes.map((note) => `- ${note}`), ""] : []),
  ].join("\n");
}

function bundleReadme(options: {
  id: string;
  title: string;
  description: string;
  extraFiles?: readonly string[];
  notes?: readonly string[];
}): string {
  const { id, title, description, extraFiles = [], notes = [] } = options;
  const timelineId = `${id}-timeline`;
  const files = [
    `compositions/${id}.html`,
    `timelines/${timelineId}.timeline.json`,
    `props/${id}.json`,
    ...extraFiles.map((file) => hydrate(file, id)),
  ];
  return [
    `# ${id}`,
    "",
    `Recipe: **${title}**`,
    "",
    description,
    "",
    "Files:",
    ...files.map((file) => `- \`${file}\``),
    "",
    "Register both entries in `fy.config.js`:",
    "",
    "```js",
    "export default {",
    "  format: { width: 1920, height: 1080, fps: 30 },",
    `  compositions: { "${id}": "./compositions/${id}.html" },`,
    `  timelines: { "${timelineId}": "./timelines/${timelineId}.timeline.json" },`,
    "};",
    "```",
    "",
    "Preview and render:",
    "",
    "```sh",
    "npx frameyard dev",
    `npx frameyard check ${timelineId}`,
    `npx frameyard still ${id} --frame 30 --out out/${id}.png`,
    `npx frameyard render ${timelineId}`,
    "```",
    "",
    "Agent prompt:",
    "",
    `> Start from the \`${id}\` recipe. Keep the composition and timeline, replace the props and copy, and verify with \`npx frameyard check ${timelineId}\`.`,
    "",
    ...(notes.length > 0 ? ["Notes:", "", ...notes.map((note) => `- ${note}`), ""] : []),
  ].join("\n");
}

function compositionRecipe(options: {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  composition: string | ((id: string) => string);
  props: string;
  extraFiles?: readonly RecipeFile[];
  notes?: readonly string[];
  prerequisites?: readonly string[];
}): ProjectRecipe {
  const extraFiles = options.extraFiles ?? [];
  return {
    id: options.id,
    title: options.title,
    description: options.description,
    tags: options.tags,
    kind: "composition",
    files: [
      {
        path: "compositions/{id}.html",
        content: (id) => (typeof options.composition === "function" ? options.composition(id) : options.composition),
      },
      {
        path: "props/{id}.json",
        content: () => options.props,
      },
      {
        path: "recipes/{id}.md",
        content: (id) =>
          compositionReadme({
            id,
            title: options.title,
            description: options.description,
            extraFiles: extraFiles.map((file) => file.path),
            notes: options.notes,
          }),
      },
      ...extraFiles,
    ],
    entries: [{ kind: "composition", id: "{id}", entry: "compositions/{id}.html" }],
    ...(options.prerequisites !== undefined ? { prerequisites: options.prerequisites } : {}),
  };
}

function bundleRecipe(options: {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  composition: string | ((id: string) => string);
  timeline: (id: string) => string;
  props: string;
  notes?: readonly string[];
  prerequisites?: readonly string[];
}): ProjectRecipe {
  return {
    id: options.id,
    title: options.title,
    description: options.description,
    tags: options.tags,
    kind: "bundle",
    files: [
      {
        path: "compositions/{id}.html",
        content: (id) => (typeof options.composition === "function" ? options.composition(id) : options.composition),
      },
      {
        path: "timelines/{id}-timeline.timeline.json",
        content: options.timeline,
      },
      {
        path: "props/{id}.json",
        content: () => options.props,
      },
      {
        path: "recipes/{id}.md",
        content: (id) =>
          bundleReadme({
            id,
            title: options.title,
            description: options.description,
            notes: options.notes,
          }),
      },
    ],
    entries: [
      { kind: "composition", id: "{id}", entry: "compositions/{id}.html" },
      { kind: "timeline", id: "{id}-timeline", entry: "timelines/{id}-timeline.timeline.json" },
    ],
    ...(options.prerequisites !== undefined ? { prerequisites: options.prerequisites } : {}),
  };
}

const lowerThirdProps = `{
  "name": "Ada Lovelace",
  "role": "Computing pioneer",
  "accent": "#ff7a45"
}
`;

function lowerThirdTimeline(id: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "lower-third",
          track: "v1",
          source: { kind: "composition", id },
          start: 0,
          duration: 120,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

const titleCardProps = `{
  "title": "Chapter one",
  "subtitle": "A deterministic title card"
}
`;

const captionsProps = `{
  "title": "Captions",
  "accent": "#b8f36b"
}
`;

function captionsComposition(id: string): string {
  return `<script type="application/json" data-fy="props">{
  "title": "Captions",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    align-items: end;
    justify-items: center;
    padding: 8vmin;
    box-sizing: border-box;
    background: radial-gradient(circle at 50% 20%, #1b2a3a, #080b10 70%);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  .caption {
    width: min(86%, 72ch);
    padding: 2.2vmin 3vmin;
    border-radius: 1.2vmin;
    background: color-mix(in srgb, #05080d 82%, transparent);
    font-size: 4.4vmin;
    line-height: 1.35;
    text-align: center;
  }
  .word {
    display: inline-block;
    margin-right: 0.55ch;
    color: #93a4b8;
    transition: none;
  }
  .word.active { color: var(--fy-prop-accent, #b8f36b); }
  .eyebrow {
    position: absolute;
    top: 7vmin;
    left: 8vmin;
    font-size: 2vmin;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #93a4b8;
  }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <div class="eyebrow" data-fy-text="title"></div>
    <fy-transcript src="assets/${id}.transcript.json" words hidden></fy-transcript>
    <div id="caption" class="caption" aria-live="polite"></div>
  </main>
</fy-composition>
<script type="text/fy-controller">
let transcript;
let caption;

function activeWord(words, timeMs) {
  const index = words.findIndex((word) => timeMs >= word.startMs && timeMs < word.endMs);
  if (index >= 0) return index;
  const next = words.findIndex((word) => timeMs < word.startMs);
  return next >= 0 ? next : words.length - 1;
}

export default {
  async mount({ root }) {
    transcript = await (await fetch(new URL("../assets/${id}.transcript.json", import.meta.url))).json();
    caption = root.querySelector("#caption");
  },
  update({ frame }) {
    if (!transcript || !caption) return;
    const fps = window.__fy?.metadata?.fps ?? 30;
    const words = transcript.words ?? [];
    if (words.length === 0) return;
    const index = activeWord(words, (frame / fps) * 1000);
    const pageSize = 4;
    const page = Math.max(0, Math.floor(index / pageSize));
    const pageWords = words.slice(page * pageSize, page * pageSize + pageSize);
    const active = words[index];
    caption.replaceChildren(
      ...pageWords.map((word) => {
        const span = document.createElement("span");
        span.textContent = word.text;
        span.className = word === active ? "word active" : "word";
        return span;
      }),
    );
  },
};
</script>
`;
}

function captionsTranscript(id: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      text: "Make every frame count. Keep it simple.",
      language: "en",
      source: {
        path: `assets/${id}.wav`,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        bytes: 1,
      },
      segments: [
        { startMs: 0, endMs: 2600, text: "Make every frame count." },
        { startMs: 2800, endMs: 4500, text: "Keep it simple." },
      ],
      words: [
        { startMs: 0, endMs: 500, text: "Make" },
        { startMs: 550, endMs: 1100, text: "every" },
        { startMs: 1150, endMs: 1800, text: "frame" },
        { startMs: 1850, endMs: 2600, text: "count." },
        { startMs: 2800, endMs: 3400, text: "Keep" },
        { startMs: 3450, endMs: 4000, text: "it" },
        { startMs: 4050, endMs: 4500, text: "simple." },
      ],
    },
    null,
    2,
  )}\n`;
}

const audioVisualizerComposition = `<script type="application/json" data-fy="props">{
  "title": "Signal / 01",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #080b10;
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .title { position: absolute; left: 7vmin; top: 6vmin; font-size: 4vmin; font-weight: 700; letter-spacing: -0.03em; }
  .label {
    position: absolute;
    left: 7vmin;
    bottom: 6vmin;
    font-size: 2.2vmin;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #93a4b8;
  }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <canvas id="canvas"></canvas>
    <div class="title" data-fy-text="title"></div>
    <div class="label">Synthetic envelope - replace with decoded audio</div>
  </main>
</fy-composition>
<script type="text/fy-controller">
let canvas;
let ctx;

export default {
  mount({ root }) {
    canvas = root.querySelector("#canvas");
    ctx = canvas.getContext("2d");
  },
  update({ frame, props }) {
    if (!canvas || !ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    const bars = 48;
    const gap = width / bars;
    const accent = props.accent ?? "#b8f36b";
    for (let index = 0; index < bars; index += 1) {
      const phase = frame / 30;
      const envelope =
        0.28 +
        0.72 * Math.abs(Math.sin(phase * 1.7 + index * 0.31) * Math.cos(phase * 0.9 - index * 0.17));
      const barHeight = Math.max(4, envelope * height * 0.58);
      const x = index * gap + gap * 0.22;
      const y = height * 0.5 - barHeight * 0.5;
      ctx.fillStyle = index % 5 === 0 ? accent : "#2b3a4a";
      ctx.fillRect(x, y, gap * 0.56, barHeight);
    }
  },
};
</script>
`;

const countdownComposition = `<script type="application/json" data-fy="props">{
  "title": "Launching soon",
  "from": 10,
  "accent": "#ff7a45"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 50% 40%, #202a3a, #080b10 70%);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  .ring {
    position: absolute;
    width: 54vmin;
    height: 54vmin;
    border-radius: 50%;
    background: conic-gradient(var(--fy-prop-accent, #ff7a45) calc(var(--fy-progress) * 1turn), #1a2432 0);
    mask: radial-gradient(circle, transparent 62%, #000 63%);
  }
  .count { position: relative; font-size: 22vmin; font-weight: 800; line-height: 1; }
  .label {
    position: absolute;
    bottom: 10vmin;
    font-size: 2.4vmin;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #93a4b8;
  }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <div class="ring"></div>
    <div id="count" class="count">10</div>
    <div class="label" data-fy-text="title"></div>
  </main>
</fy-composition>
<script type="text/fy-controller">
let count;

export default {
  mount({ root }) {
    count = root.querySelector("#count");
  },
  update({ frame, props }) {
    if (!count) return;
    const total = Number(props.from ?? 10);
    const remaining = Math.max(0, total - Math.floor(frame / 15));
    count.textContent = String(remaining).padStart(2, "0");
  },
};
</script>
`;

const statCardComposition = `<script type="application/json" data-fy="props">{
  "label": "Frames rendered",
  "value": 108000,
  "suffix": "",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #0b1220, #182a3f);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  .card {
    width: 76%;
    padding: 6vmin;
    border: 1px solid #2c3e55;
    background: #0d1624;
    box-shadow: 0 3vmin 8vmin #0008;
  }
  .value { font-size: 14vmin; font-weight: 800; letter-spacing: -0.06em; color: var(--fy-prop-accent, #b8f36b); }
  .label { margin-top: 1.4vmin; font-size: 2.6vmin; letter-spacing: 0.16em; text-transform: uppercase; color: #93a4b8; }
  .bar { height: 1.2vmin; margin-top: 4vmin; background: #1a2a3d; }
  .bar span { display: block; width: calc(var(--fy-progress) * 100%); height: 100%; background: var(--fy-prop-accent, #b8f36b); }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <div class="card">
      <div id="value" class="value">0</div>
      <div class="label" data-fy-text="label"></div>
      <div class="bar"><span></span></div>
    </div>
  </main>
</fy-composition>
<script type="text/fy-controller">
let value;

export default {
  mount({ root }) {
    value = root.querySelector("#value");
  },
  update({ frame, props }) {
    if (!value) return;
    const progress = Math.min(1, frame / 45);
    const eased = 1 - Math.pow(1 - progress, 3);
    const next = Math.round(Number(props.value ?? 0) * eased);
    value.textContent = next.toLocaleString("en-US") + String(props.suffix ?? "");
  },
};
</script>
`;

const productShowcaseComposition = `<script type="application/json" data-fy="props">{
  "name": "Field Notes",
  "tagline": "A quieter way to capture ideas.",
  "accent": "#ff7a45"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: radial-gradient(circle at 70% 30%, #26384c, #080b10 68%);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  .copy { position: absolute; left: 8vmin; top: 50%; transform: translateY(-50%); width: 42%; }
  .eyebrow { font-size: 2vmin; letter-spacing: 0.24em; text-transform: uppercase; color: var(--fy-prop-accent, #ff7a45); }
  h1 { margin: 1.4vmin 0 2vmin; font-size: 8vmin; line-height: 0.95; letter-spacing: -0.05em; }
  p { margin: 0; font-size: 3vmin; line-height: 1.4; color: #a8b8ca; }
  .chips { display: flex; gap: 1.2vmin; margin-top: 4vmin; flex-wrap: wrap; }
  .chips span { padding: 1vmin 1.6vmin; border: 1px solid #3a4c61; border-radius: 99px; font-size: 1.8vmin; color: #d5dfeb; }
  .product {
    position: absolute;
    right: 9vmin;
    top: 50%;
    width: 28vmin;
    height: 44vmin;
    transform: translateY(-50%) rotate(8deg);
    border: 1px solid #53687e;
    border-radius: 4vmin;
    background: linear-gradient(160deg, #1b2a3b, #0d1520);
    box-shadow: 0 4vmin 10vmin #0009;
  }
  .product::before {
    content: "";
    position: absolute;
    inset: 2vmin 2vmin 8vmin;
    border-radius: 2.4vmin;
    background: linear-gradient(145deg, var(--fy-prop-accent, #ff7a45), #7d3f2a 65%, #182536);
    opacity: 0.9;
  }
  .product::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 3.8vmin;
    width: 8vmin;
    height: 0.8vmin;
    transform: translateX(-50%);
    border-radius: 99px;
    background: #53687e;
  }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <div class="copy">
      <div class="eyebrow">New / 01</div>
      <h1 data-fy-text="name"></h1>
      <p data-fy-text="tagline"></p>
      <div class="chips"><span>Deterministic</span><span>Local-first</span><span>HTML</span></div>
    </div>
    <div class="product"></div>
  </main>
</fy-composition>
`;

const logoStingComposition = `<script type="application/json" data-fy="props">{
  "brand": "Yard",
  "tagline": "Make the frame",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: #080b10;
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
    text-align: center;
  }
  .mark { width: 34vmin; height: 34vmin; }
  .mark circle, .mark path {
    fill: none;
    stroke: var(--fy-prop-accent, #b8f36b);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark circle { stroke-dasharray: 220; stroke-dashoffset: 220; animation: draw 1.2s ease-out both; }
  .mark path { stroke-dasharray: 120; stroke-dashoffset: 120; animation: draw 1s 0.25s ease-out both; }
  .brand { margin-top: 4vmin; font-size: 6vmin; font-weight: 800; letter-spacing: -0.04em; }
  .tagline { margin-top: 1vmin; font-size: 2vmin; letter-spacing: 0.24em; text-transform: uppercase; color: #93a4b8; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
</style>
<fy-composition duration-in-frames="120">
  <main class="stage">
    <div>
      <svg class="mark" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="34"></circle>
        <path d="M30 62 L50 32 L70 62"></path>
      </svg>
      <div class="brand" data-fy-text="brand"></div>
      <div class="tagline" data-fy-text="tagline"></div>
    </div>
  </main>
</fy-composition>
`;

const splitScreenComposition = `<script type="application/json" data-fy="props">{
  "left": "Before",
  "right": "After",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage { position: absolute; inset: 0; overflow: hidden; background: #080b10; color: #f4f7fb; font-family: system-ui, sans-serif; }
  .panel { position: absolute; inset: 0; display: grid; place-items: center; }
  .left {
    background: linear-gradient(135deg, #152536, #0b111a);
    clip-path: polygon(0 0, 58% 0, 42% 100%, 0 100%);
  }
  .right {
    background: linear-gradient(135deg, #26384c, #111c2b);
    clip-path: polygon(58% 0, 100% 0, 100% 100%, 42% 100%);
  }
  .label { font-size: 9vmin; font-weight: 800; letter-spacing: -0.05em; }
  .left .label { color: #93a4b8; }
  .right .label { color: var(--fy-prop-accent, #b8f36b); }
  .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 0.5vmin;
    background: var(--fy-prop-accent, #b8f36b);
    transform: skewX(-8deg);
  }
  .caption {
    position: absolute;
    left: 8vmin;
    bottom: 8vmin;
    font-size: 2vmin;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #93a4b8;
  }
</style>
<fy-composition duration-in-frames="120">
  <main class="stage">
    <div class="panel left"><div class="label" data-fy-text="left"></div></div>
    <div class="panel right"><div class="label" data-fy-text="right"></div></div>
    <div class="divider"></div>
    <div class="caption">One frame / two stories</div>
  </main>
</fy-composition>
`;

const slideshowComposition = `<script type="application/json" data-fy="props">{
  "slide": 0,
  "title": "Three slides",
  "accent": "#b8f36b"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .stage { position: absolute; inset: 0; overflow: hidden; background: #080b10; color: #f4f7fb; font-family: system-ui, sans-serif; }
  .slide { position: absolute; inset: 0; display: none; place-items: center; }
  fy-composition[data-slide="0"] .slide-0,
  fy-composition[data-slide="1"] .slide-1,
  fy-composition[data-slide="2"] .slide-2 { display: grid; }
  .slide-0 { background: radial-gradient(circle at 30% 30%, #24384c, #080b10 70%); }
  .slide-1 { background: radial-gradient(circle at 70% 40%, #4a2a2a, #080b10 70%); }
  .slide-2 { background: radial-gradient(circle at 50% 70%, #2b3b2a, #080b10 70%); }
  .num { position: absolute; right: 8vmin; bottom: 2vmin; font-size: 20vmin; font-weight: 800; opacity: 0.14; }
  .copy { position: relative; text-align: center; }
  .copy h2 { margin: 0; font-size: 8vmin; letter-spacing: -0.05em; }
  .copy p { margin: 2vmin 0 0; font-size: 2.6vmin; color: #a8b8ca; }
</style>
<fy-composition duration-in-frames="90">
  <main class="stage">
    <section class="slide slide-0"><div class="num">01</div><div class="copy"><h2>First look</h2><p>Set the scene.</p></div></section>
    <section class="slide slide-1"><div class="num">02</div><div class="copy"><h2>Second beat</h2><p>Change the rhythm.</p></div></section>
    <section class="slide slide-2"><div class="num">03</div><div class="copy"><h2>Last frame</h2><p>Leave a mark.</p></div></section>
  </main>
</fy-composition>
<script type="text/fy-controller">
export default {
  mount({ root, props }) {
    root.dataset.slide = String(props.slide ?? 0);
  },
};
</script>
`;

function slideshowTimeline(id: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "slide-1",
          track: "v1",
          source: { kind: "composition", id },
          start: 0,
          duration: 90,
          props: { slide: 0 },
        },
        {
          id: "slide-2",
          track: "v1",
          source: { kind: "composition", id },
          start: 75,
          duration: 90,
          props: { slide: 1 },
        },
        {
          id: "slide-3",
          track: "v1",
          source: { kind: "composition", id },
          start: 150,
          duration: 90,
          props: { slide: 2 },
        },
      ],
      transitions: [
        { from: "slide-1", to: "slide-2", kind: "dissolve" },
        { from: "slide-2", to: "slide-3", kind: "dissolve" },
      ],
    },
    null,
    2,
  )}\n`;
}

export const RECIPES: readonly ProjectRecipe[] = [
  bundleRecipe({
    id: "lower-third",
    title: "Lower third",
    description: "A 120-frame name and role lower third, its timeline, props, and README.",
    tags: ["lower-third", "overlay", "title"],
    composition: builtInTemplate("lower-third"),
    timeline: lowerThirdTimeline,
    props: lowerThirdProps,
    notes: ["Use `props/hero.json` as the starting copy and keep the accent prop in sync with your brand."],
  }),
  compositionRecipe({
    id: "title-card",
    title: "Title card",
    description: "A 150-frame title card with staggered CSS entrance animations.",
    tags: ["title", "intro", "chapter"],
    composition: builtInTemplate("title-card"),
    props: titleCardProps,
  }),
  compositionRecipe({
    id: "captions",
    title: "Captions",
    description: "A transcript-driven caption card with word highlighting and a sample transcript.",
    tags: ["captions", "subtitles", "karaoke", "transcript"],
    composition: captionsComposition,
    props: captionsProps,
    extraFiles: [
      {
        path: "assets/{id}.transcript.json",
        content: captionsTranscript,
      },
    ],
    notes: [
      "The installed transcript is a sample. Replace it with a canonical transcript from `npx frameyard transcribe --words`.",
      "The controller reads the transcript in `mount()` and highlights the active word from the current frame.",
    ],
  }),
  compositionRecipe({
    id: "audio-visualizer",
    title: "Audio visualizer",
    description: "A deterministic Canvas waveform with a replaceable synthetic envelope.",
    tags: ["audio", "visualizer", "canvas", "music"],
    composition: audioVisualizerComposition,
    props: `{
  "title": "Signal / 01",
  "accent": "#b8f36b"
}
`,
    notes: [
      "The template uses a synthetic envelope so it renders without an audio asset.",
      "Replace the envelope calculation with decoded audio peaks when you connect real media.",
    ],
  }),
  compositionRecipe({
    id: "countdown",
    title: "Countdown",
    description: "A large countdown with a progress ring driven by the frame clock.",
    tags: ["countdown", "intro", "timer"],
    composition: countdownComposition,
    props: `{
  "title": "Launching soon",
  "from": 10,
  "accent": "#ff7a45"
}
`,
  }),
  compositionRecipe({
    id: "stat-card",
    title: "Stat card",
    description: "An animated number and progress bar for metrics and recaps.",
    tags: ["stat", "metric", "data", "counter"],
    composition: statCardComposition,
    props: `{
  "label": "Frames rendered",
  "value": 108000,
  "suffix": "",
  "accent": "#b8f36b"
}
`,
  }),
  compositionRecipe({
    id: "product-showcase",
    title: "Product showcase",
    description: "A split product layout with a phone mockup and feature chips.",
    tags: ["product", "showcase", "launch", "marketing"],
    composition: productShowcaseComposition,
    props: `{
  "name": "Field Notes",
  "tagline": "A quieter way to capture ideas.",
  "accent": "#ff7a45"
}
`,
  }),
  compositionRecipe({
    id: "logo-sting",
    title: "Logo sting",
    description: "A short SVG logo reveal with a drawn mark and brand line.",
    tags: ["logo", "sting", "brand", "intro"],
    composition: logoStingComposition,
    props: `{
  "brand": "Yard",
  "tagline": "Make the frame",
  "accent": "#b8f36b"
}
`,
  }),
  compositionRecipe({
    id: "split-screen",
    title: "Split screen",
    description: "A diagonal before/after split with two large labels.",
    tags: ["split", "comparison", "before-after", "layout"],
    composition: splitScreenComposition,
    props: `{
  "left": "Before",
  "right": "After",
  "accent": "#b8f36b"
}
`,
  }),
  bundleRecipe({
    id: "slideshow",
    title: "Slideshow",
    description: "A three-slide composition with a timeline that dissolves between slides.",
    tags: ["slideshow", "slides", "timeline", "transition"],
    composition: slideshowComposition,
    timeline: slideshowTimeline,
    props: `{
  "slide": 0,
  "title": "Three slides",
  "accent": "#b8f36b"
}
`,
    notes: ["The timeline uses a 15-frame overlap and a dissolve between each slide."],
  }),
];

export function findRecipe(id: string): ProjectRecipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}

export function listRecipes(): ProjectRecipe[] {
  return [...RECIPES];
}

export function recipeInstallPlan(recipe: ProjectRecipe, id: string): RecipeInstallPlan {
  return {
    files: renderFiles(recipe.files, id),
    entries: recipe.entries.map((entry) => ({
      kind: entry.kind,
      id: hydrate(entry.id, id),
      entry: hydrate(entry.entry, id),
    })),
  };
}

export function recipeRegistration(
  recipe: ProjectRecipe,
  id: string,
): Record<"compositions" | "timelines", Record<string, string> | undefined> {
  const compositions: Record<string, string> = {};
  const timelines: Record<string, string> = {};

  for (const entry of recipeInstallPlan(recipe, id).entries) {
    const target = `./${entry.entry}`;
    if (entry.kind === "composition") {
      compositions[entry.id] = target;
    } else {
      timelines[entry.id] = target;
    }
  }

  return {
    compositions: Object.keys(compositions).length > 0 ? compositions : undefined,
    timelines: Object.keys(timelines).length > 0 ? timelines : undefined,
  };
}
