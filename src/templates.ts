export type TemplateKind = "composition" | "timeline";

export interface ProjectTemplate {
  name: string;
  kind: TemplateKind;
  description: string;
  /** Project-relative entry path for a new id. */
  entry: (id: string) => string;
  content: string;
  /** Project-relative files the template expects the user to provide. */
  prerequisites?: string[];
}

const staticPoster = `<script type="application/json" data-fy="props">{
  "title": "A quiet signal",
  "subtitle": "Frameyard static poster",
  "accent": "#ff7a45"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  .poster {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 50% 35%, #1d2a44, #080d16 70%);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
  }
  .card { width: 78%; text-align: center; }
  h1 {
    margin: 0;
    font-size: 8vmin;
    line-height: 1.05;
    color: var(--fy-prop-accent, #ff7a45);
  }
  p {
    margin: 3vmin 0 0;
    font-size: 3vmin;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #9fb0c8;
  }
</style>
<fy-composition>
  <main class="poster">
    <div class="card">
      <h1 data-fy-text="title"></h1>
      <p data-fy-text="subtitle"></p>
    </div>
  </main>
</fy-composition>
`;

const titleCard = `<script type="application/json" data-fy="props">{
  "title": "Chapter one",
  "subtitle": "A deterministic title card"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(4vmin); }
    to { opacity: 1; transform: translateY(0); }
  }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #0c1220, #18243a);
    color: #f4f7fb;
    font-family: system-ui, sans-serif;
    text-align: center;
  }
  h1 { margin: 0; font-size: 9vmin; line-height: 1.05; animation: rise 1s linear both; }
  p { margin: 3vmin 0 0; font-size: 3vmin; color: #8fa4c4; animation: rise 1s linear both; }
</style>
<fy-composition duration-in-frames="150">
  <main class="stage">
    <div>
      <h1 data-fy-text="title" data-fy-anim-start="0" data-fy-anim-duration="36"></h1>
      <p data-fy-text="subtitle" data-fy-anim-start="18" data-fy-anim-duration="36"></p>
    </div>
  </main>
</fy-composition>
`;

const lowerThird = `<script type="application/json" data-fy="props">{
  "name": "Ada Lovelace",
  "role": "Computing pioneer",
  "accent": "#ff7a45"
}</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  @keyframes slide {
    from { opacity: 0; transform: translateX(-6vmin); }
    to { opacity: 1; transform: translateX(0); }
  }
  .stage {
    position: absolute;
    inset: 0;
    background: transparent;
    font-family: system-ui, sans-serif;
  }
  .bar {
    position: absolute;
    left: 6vmin;
    bottom: 9vmin;
    padding: 2.4vmin 3.2vmin;
    border-left: 0.8vmin solid var(--fy-prop-accent, #ff7a45);
    background: color-mix(in srgb, #0c1220 88%, transparent);
    color: #f4f7fb;
    animation: slide 1s ease both;
  }
  strong { display: block; font-size: 4.2vmin; line-height: 1.1; }
  span { display: block; margin-top: 0.8vmin; font-size: 2.4vmin; color: #9fb0c8; }
</style>
<fy-composition duration-in-frames="120">
  <main class="stage">
    <div class="bar" data-fy-anim-start="0" data-fy-anim-duration="30">
      <strong data-fy-text="name"></strong>
      <span data-fy-text="role"></span>
    </div>
  </main>
</fy-composition>
`;

const slideshowTimeline = `{
  "version": 1,
  "tracks": [
    { "id": "v1", "kind": "video" }
  ],
  "clips": [
    {
      "id": "slide-1",
      "track": "v1",
      "source": { "kind": "image", "src": "assets/slide-1.png" },
      "start": 0,
      "duration": 90
    },
    {
      "id": "slide-2",
      "track": "v1",
      "source": { "kind": "image", "src": "assets/slide-2.png" },
      "start": 90,
      "duration": 90
    },
    {
      "id": "slide-3",
      "track": "v1",
      "source": { "kind": "image", "src": "assets/slide-3.png" },
      "start": 180,
      "duration": 90
    }
  ],
  "transitions": []
}
`;

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    name: "static-poster",
    kind: "composition",
    description: "A timeless poster with title, subtitle, and accent props; renders to PNG.",
    entry: (id) => `compositions/${id}.html`,
    content: staticPoster,
  },
  {
    name: "title-card",
    kind: "composition",
    description: "A 150-frame title card with staggered CSS entrance animations.",
    entry: (id) => `compositions/${id}.html`,
    content: titleCard,
  },
  {
    name: "lower-third",
    kind: "composition",
    description: "A 120-frame lower third for a name and role.",
    entry: (id) => `compositions/${id}.html`,
    content: lowerThird,
  },
  {
    name: "slideshow",
    kind: "timeline",
    description: "A three-slide image timeline with 90-frame clips.",
    entry: (id) => `timelines/${id}.timeline.json`,
    content: slideshowTimeline,
    prerequisites: ["assets/slide-1.png", "assets/slide-2.png", "assets/slide-3.png"],
  },
];

export function findTemplate(name: string): ProjectTemplate | undefined {
  return TEMPLATES.find((template) => template.name === name);
}

export function listTemplates(kind?: TemplateKind): ProjectTemplate[] {
  return TEMPLATES.filter((template) => kind === undefined || template.kind === kind);
}

export function templateRegistration(
  template: ProjectTemplate,
  id: string,
): Record<"compositions" | "timelines", Record<string, string> | undefined> {
  const entry = template.entry(id);
  return template.kind === "composition"
    ? { compositions: { [id]: `./${entry}` }, timelines: undefined }
    : { compositions: undefined, timelines: { [id]: `./${entry}` } };
}
