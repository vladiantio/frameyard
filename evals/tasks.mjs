const FORMAT = "format: { width: 320, height: 180, fps: 10 }";

function config(compositions, timelines = {}) {
  return `export default {\n  ${FORMAT},\n  compositions: ${JSON.stringify(compositions, null, 2)},\n  timelines: ${JSON.stringify(timelines, null, 2)}\n};\n`;
}

const probe = `<fy-composition width="320" height="180">
  <div style="width: 100%; height: 100%; background: #0b1220"></div>
</fy-composition>
`;

const probeFiles = {
  "fy.config.js": config({ probe: "./compositions/probe.html" }),
  "compositions/probe.html": probe,
};

function card(id, color, label, duration = 60) {
  return `<script type="application/json" data-fy="props">{ "label": "${label}" }</script>
<fy-composition width="320" height="180" duration-in-frames="${duration}">
  <div style="position: absolute; inset: 0; background: ${color}; color: white; font: 28px system-ui; display: grid; place-items: center" data-fy-text="label"></div>
</fy-composition>
`;
}

const staticPoster = `<script type="application/json" data-fy="props">{ "title": "Poster", "subtitle": "Static" }</script>
<fy-composition width="320" height="180">
  <main style="position: absolute; inset: 0; background: #101820; color: #ff7a45; display: grid; place-items: center; font-family: system-ui">
    <div style="text-align: center">
      <h1 style="margin: 0; font-size: 42px" data-fy-text="title"></h1>
      <p style="margin: 8px 0 0; font-size: 18px; color: #9fb0c8" data-fy-text="subtitle"></p>
    </div>
  </main>
</fy-composition>
`;

const typoComposition = `<script type="application/json" data-fy="props">{ "title": "Hello" }</script>
<fy-composition width="320" height="180">
  <div style="position: absolute; inset: 0; background: #101820; color: white; font: 28px system-ui; display: grid; place-items: center" data-fy-text="titel"></div>
</fy-composition>
`;

const badTimeline = {
  version: 1,
  tracks: [{ id: "v1", kind: "video" }],
  clips: [
    {
      id: "card",
      track: "v1",
      source: { kind: "composition", id: "card" },
      start: 0,
      keyframes: {
        opacity: [
          { frame: 0, value: 1 },
          { frame: 90, value: 1 },
        ],
      },
    },
  ],
  transitions: [],
};

export const TASKS = [
  {
    name: "static-poster",
    brief:
      "Add a static composition with id `poster`. It must use props `title` and `subtitle`, render a full-bleed background with centered text, and be registered in fy.config.js. Use a static composition (no duration-in-frames or fps).",
    target: "poster",
    files: probeFiles,
    expect: { maxWarnings: 0, stillFrame: 0, requireContent: true },
  },
  {
    name: "title-card",
    brief:
      "Add a 60-frame animated composition with id `title`. It must use props `title` and `subtitle`, animate the title in with CSS `@keyframes`, and be registered in fy.config.js. Keep the text visible by frame 15.",
    target: "title",
    files: probeFiles,
    expect: { maxWarnings: 0, stillFrame: 15, requireContent: true },
  },
  {
    name: "lower-third",
    brief:
      "Add a 60-frame composition with id `lower-third`. It must use props `name` and `role`, render a transparent stage with a lower-third bar, animate the bar in with CSS, and be registered in fy.config.js. Keep the bar visible by frame 15.",
    target: "lower-third",
    files: probeFiles,
    expect: { maxWarnings: 0, stillFrame: 15, requireContent: true },
  },
  {
    name: "timeline-assembly",
    brief:
      "Add a timeline with id `main`. Put composition `a` on video track `v1` at frame 0 for 60 frames and composition `b` at frame 30 for 60 frames. Declare a `dissolve` transition from `a` to `b`; the transition window is the overlap. Register the timeline in fy.config.js.",
    target: "main",
    files: {
      "fy.config.js": config({
        a: "./compositions/a.html",
        b: "./compositions/b.html",
      }),
      "compositions/a.html": card("a", "#1d4ed8", "A"),
      "compositions/b.html": card("b", "#be123c", "B"),
    },
    expect: { maxWarnings: 0, stillFrame: 45, requireContent: true },
  },
  {
    name: "keyframes",
    brief:
      "Add a timeline with id `main`. Put composition `card` on video track `v1` at frame 0 for 60 frames. Animate the clip's `x` from 0 to 80 and `opacity` from 0.2 to 1 with clip-local keyframes. Register the timeline in fy.config.js.",
    target: "main",
    files: {
      "fy.config.js": config({ card: "./compositions/card.html" }),
      "compositions/card.html": card("card", "#0f766e", "Card"),
    },
    expect: { maxWarnings: 0, stillFrame: 30, requireContent: true },
  },
  {
    name: "static-in-timeline",
    brief:
      "Add a timeline with id `main`. Put the static composition `poster` on video track `v1` at frame 0 for 60 frames with `sourceIn: 0`. Register the timeline in fy.config.js. Do not add audio.",
    target: "main",
    files: {
      "fy.config.js": config({ poster: "./compositions/poster.html" }),
      "compositions/poster.html": staticPoster,
    },
    expect: { maxWarnings: 0, stillFrame: 0, requireContent: true },
  },
  {
    name: "fix-binding",
    brief:
      "Fix the composition `hello` so the visible text uses the `title` prop and no binding warning remains. Keep the composition static and keep the id registered.",
    target: "hello",
    files: {
      "fy.config.js": config({ hello: "./compositions/hello.html" }),
      "compositions/hello.html": typoComposition,
    },
    expect: { maxWarnings: 0, stillFrame: 0, requireContent: true },
  },
  {
    name: "fix-timeline",
    brief:
      "Fix the timeline `main`: the `opacity` keyframe at clip-local frame 90 is outside the 60-frame clip. Keep the clip at 60 frames and keep the id registered.",
    target: "main",
    files: {
      "fy.config.js": config({ card: "./compositions/card.html" }, { main: "./timelines/main.timeline.json" }),
      "compositions/card.html": card("card", "#7c3aed", "Card"),
      "timelines/main.timeline.json": `${JSON.stringify(badTimeline, null, 2)}\n`,
    },
    expect: { maxWarnings: 0, stillFrame: 0, requireContent: true },
  },
];

export function findTask(name) {
  return TASKS.find((task) => task.name === name);
}
