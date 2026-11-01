import { VERSION } from "./version.js";

const AGENTS_GUIDE = `# AGENTS.md

This project produces deterministic, parameterized video with Frameyard. Follow this guide when editing or rendering it.

## Project layout

- \`video.config.js\` explicitly maps project IDs to sources. There is no directory scanning. It declares the project \`format\`, \`compositions\`, and \`timelines\`.
- \`compositions/\` contains HTML/CSS compositions. An optional controller lives beside the document as a \`.controller.js\` module; import \`frameyard/runtime\` for \`random("stable:key")\` and other browser APIs.
- \`timelines/\` contains JSON timeline documents that assemble composition and media clips into one video.
- \`props/hello.json\` contains composition props; \`props/main.json\` contains timeline clip overrides keyed by composition clip ID.
- \`out/\` contains rendered MP4s and is gitignored. \`render\` writes \`out/<id>.mp4\` by default.
- \`assets/\` (create it when needed) contains audio, images, fonts, and generated assets.
- \`package.json\` pins the CLI version in \`dev\`, \`check\`, \`render\`, and \`still\` scripts. Run \`dev\` with \`npm run dev\` or \`pnpm dev\`; for the others, pass the timeline or composition id: \`npm run check -- main\` (npm) or \`pnpm check main\` (pnpm).

\`width\`, \`height\`, \`fps\`, and \`duration-in-frames\` are fixed on \`<fy-composition>\`. Do not derive them from props.

## Composition skeleton

\`\`\`html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">{ "title": "Hello" }</script>
  </head>
  <body>
    <fy-composition width="1280" height="720" fps="30" duration-in-frames="150">
      <h1 data-fy-text="title"></h1>
    </fy-composition>
  </body>
</html>
\`\`\`

## Timeline skeleton

\`timelines/main.timeline.json\` assembles clips in the project format:

\`\`\`json
{
  "version": 1,
  "tracks": [
    { "id": "v1", "kind": "video" },
    { "id": "a1", "kind": "audio" }
  ],
  "clips": [
    {
      "id": "hello",
      "track": "v1",
      "source": { "kind": "composition", "id": "hello" },
      "start": 0
    },
    {
      "id": "music",
      "track": "a1",
      "source": { "kind": "audio", "src": "assets/music.wav" },
      "start": 0,
      "duration": 150,
      "audio": { "gain": 0.6 }
    }
  ]
}
\`\`\`

- \`source.kind\` is \`composition\` (with \`id\`), \`timeline\` (with \`id\`), or \`video\`, \`image\`, \`audio\` (with a project-relative \`src\`).
- \`start\`, \`sourceIn\`, and \`duration\` use timeline frames. Omitted durations use the rest of the source; image clips require a duration.
- Composition clips may declare \`props\`; the same composition can appear multiple times with different props, trims, and transforms.
- Visual clips support static \`transform\` values: \`fit\` (\`contain\`, \`cover\`, \`stretch\`), \`x\`, \`y\`, \`scale\`, \`rotation\`, and \`opacity\`.
- Video and audio clips are muted with \`audio.muted\`; \`audio.gain\` is 0-1. Composition audio is included automatically.
- Tracks composite from bottom to top. Clips on the same track cannot overlap. No transitions or keyframes in 0.6.
- Project \`format\` fixes width, height, and fps for every timeline. Composition fps must match the project; different composition sizes are fitted by the clip.

## Bindings

- \`data-fy-text="path"\` sets text content.
- \`data-fy-attr-src="path"\` (and other \`data-fy-attr-*\` names) sets an attribute.
- \`data-fy-class-active="path"\` toggles a class.
- \`data-fy-if="path"\` removes the element when the value is false.
- \`<template data-fy-repeat="items">\` clones its content for each item; use \`item\` and \`index\`, and style stagger with \`--fy-index\`.
- Paths are dot-separated (\`user.name\`, \`items.0.label\`). Missing paths warn and resolve to an empty value.
- Primitive top-level props are also available as \`--fy-prop-<name>\` CSS custom properties.

## Animation

- CSS \`@keyframes\` and Web Animations API animations are paused and seeked from the frame clock.
- \`data-fy-anim-start\`, \`data-fy-anim-duration\`, and \`data-fy-anim-easing\` schedule one animation per element in composition frames. The CSS \`animation\` shorthand supplies keyframes and fill mode.
- Frame-state variables are set on \`:root\`: \`--fy-frame\`, \`--fy-time\`, \`--fy-progress\`, \`--fy-fps\`, \`--fy-duration\`, and \`--fy-duration-frames\`.
- Use \`--fy-progress\` for progress bars and \`--fy-frame\`/\`--fy-time\` in \`calc()\` for simple computed motion.
- CSS transitions are not deterministic; do not use them.

## Controller

Exactly one optional controller is allowed, inline or external:

\`\`\`html
<script type="text/fy-controller">
export default {
  mount({ root, props }) {},
  update({ frame, props, root }) {},
};
</script>
\`\`\`

\`\`\`html
<script type="text/fy-controller" src="./hello.controller.js"></script>
\`\`\`

- \`mount\` may be asynchronous; \`update\` and \`validateProps\` are synchronous and seek-safe; \`dispose\` releases resources.
- Use inline for small, single-use controllers; extract to an external module for Canvas 2D, WebGL, karaoke, reuse, tests, or a large controller.
- A controller may be validation-only and export just \`validateProps(props)\`.
- The controller is the only executable code. Other scripts and \`on*\` handlers are rejected.
- Controller-created DOM is not re-bound; declarative bindings apply once before \`mount\`.

## Determinism rules

- A composition frame may depend only on its integer \`frame\`, immutable \`props\`, and assets loaded before frame production. A timeline frame is derived from its active clips and the same composition rules.
- Never use \`Math.random()\`, \`Date.now()\`, \`performance.now()\`, timers, independent \`requestAnimationFrame()\` loops, CSS transitions, or state left from a previously visited frame as animation inputs.
- Use \`random("stable:key")\` from \`frameyard/runtime\` for randomness.
- Load remote data, fonts, and images before frame production. Network requests are blocked during capture; a \`fetch()\` from \`update()\` is a bug.
- Redraw Canvas 2D and WebGL from the current frame. Production pins software WebGL for reproducible pixels.
- Embedded video and audio use local project files and \`data-fy-start\` (frames), \`data-fy-trim\` (seconds), optional \`data-fy-duration\` (seconds), and \`data-fy-volume\` (0-1). Let the runtime seek video; do not call \`play()\`, \`pause()\`, or set \`currentTime\` in \`update()\`.
- Media and transcript \`src\` values resolve from the project root. The controller \`src\` and ordinary HTML asset URLs resolve relative to the composition document.

## Audio and transcripts

- Composition audio clips are \`<audio>\` elements placed by composition frames and trimmed by seconds. Timeline audio clips use frames and are placed on audio tracks.
- Visual clips contribute their audio automatically unless muted; there are no linked A/V pairs. For a J/L cut, mute the video and add a separate audio clip with a different sourceIn.
- Frameyard does not time-stretch audio or change timeline duration to fit it.
- An unmuted embedded video contributes its audio track to the same mix; use \`muted\` or \`data-fy-audio="off"\` for a visual-only video.
- Declare required transcripts with \`<fy-transcript src="assets/voice.transcript.json" words></fy-transcript>\`.
- Produce speech with \`npx frameyard tts\` and transcripts with \`npx frameyard transcribe\`; never call \`qwen-tts\` or \`whisper-cli\` directly, and never run inference inside a controller.
- Do not overwrite or regenerate generated assets without explicit approval.
- \`words\` requires measured word timings; never interpolate segment timings.
- Commit \`frameyard.assets.json\` when present; do not edit hashes or manifest entries by hand.

## Agent workflow

1. Read \`video.config.js\`, the timeline document, the referenced composition HTML, the optional controller, and the props files before changing behavior.
2. Author compositions with native HTML, CSS, SVG, Canvas 2D, WebGL, embedded video, and an optional controller. Arrange composition and media clips in the timeline JSON. Do not add a bundling step.
3. Validate every frame: \`npx frameyard check main --json\`. Static validation runs before Chromium and reports stable diagnostic codes with source locations. Use \`--props <file>\` for composition props or a timeline clip override map.
4. Inspect a representative frame: \`npx frameyard still main --frame <n> --out <file.png> --json\`, then view the PNG when the host supports images. State explicitly when visual inspection is not possible.
5. Render: \`npx frameyard render main --props props/main.json [--workers <n>] [--scratch <dir>] --json\`. The video is written to \`out/main.mp4\` unless \`--out\` is passed.
6. Report the timeline, composition sources, props, validation result, diagnostics, still path and inspection status, video path, and any failure. Never claim success when \`check\` fails, a still is missing, or a render exits nonzero.

## Commands

\`\`\`sh
npx frameyard dev
npx frameyard doctor --json
npx frameyard check main --json
npx frameyard still main --frame 42 --out main-42.png --json
npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch --json
npx frameyard check hello --json
npx frameyard render hello --props props/hello.json --json
\`\`\`

- Use \`--json\` for non-interactive commands. Parse stdout as the structured result; treat stderr as progress and diagnostics.
- Use \`--project <dir>\` when running outside the project root.
- \`render\` writes to \`out/<id>.mp4\` in the project unless \`--out\` is passed. \`out/\` is gitignored.
- Use \`--concurrency <n>\` for composition renders (1-16). Use \`--workers <n>\` for timeline renders (1-16); the default is 8. Timeline renders also accept \`--scratch <dir>\` for FFV1 intermediates.
- \`still\` and \`render\` replace existing outputs only with \`--overwrite\`. Generated assets are replaced only with \`--force\`, and only with user approval.

The official \`frameyard\` agent skill contains the full host-neutral contract. Install it with \`npx skills add vladiantio/frameyard\` or see the \`skills/frameyard/\` directory in the \`frameyard\` npm package. This file is the project-local summary.

This project was scaffolded with frameyard ${VERSION}. \`npx frameyard\` resolves the latest published version; run \`npx frameyard@${VERSION}\` when you need the CLI version that scaffolded the project.
`;

const PROJECT_README = `# My Frameyard project

Coding agents should read \`AGENTS.md\` for the project rules and the check, still, and render workflow.

The reusable composition is a plain HTML document at \`compositions/hello.html\`. The edit is \`timelines/main.timeline.json\`, which places that composition as a clip in the project format. The project format is fixed in \`video.config.js\`.

Start the preview:

\`\`\`sh
npx frameyard dev
\`\`\`

The preview lists the timeline next to the compositions. Open the timeline to scrub it and inspect the program monitor.

Validate and render the timeline:

\`\`\`sh
npx frameyard doctor
npx frameyard check main
npx frameyard render main --props props/main.json
\`\`\`

\`props/main.json\` maps composition clip IDs to props overrides. The video is written to \`out/main.mp4\` in the project. Pass \`--out <file.mp4>\` to choose another path. Timelines with heavy composition work accept \`--workers <n>\` and \`--scratch <dir>\`.

The composition can still be previewed and rendered on its own:

\`\`\`sh
npx frameyard check hello
npx frameyard render hello --props props/hello.json
\`\`\`

Or run the pinned scripts from \`package.json\`:

\`\`\`sh
npm run dev
npm run check -- main
npm run render -- main --props props/main.json
npm run still -- main --frame 42 --out main-42.png
\`\`\`
`;

const SCAFFOLD_TEMPLATES: Record<string, string> = {
  ".gitignore": "out/\n",
  "video.config.js": `export default {\n  format: { width: 1280, height: 720, fps: 30 },\n  compositions: {\n    hello: "./compositions/hello.html",\n  },\n  timelines: {\n    main: "./timelines/main.timeline.json",\n  },\n};\n`,
  "props/hello.json": `${JSON.stringify({ title: "Hello, Frameyard", accent: "#b8f36b" }, null, 2)}\n`,
  "props/main.json": `${JSON.stringify({ hello: { title: "Hello, Frameyard", accent: "#b8f36b" } }, null, 2)}\n`,
  "timelines/main.timeline.json": `${JSON.stringify(
    {
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "hello",
          track: "v1",
          source: { kind: "composition", id: "hello" },
          start: 0,
        },
      ],
    },
    null,
    2,
  )}\n`,
  "AGENTS.md": AGENTS_GUIDE,
  "README.md": PROJECT_README,
  "compositions/hello.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">
    { "title": "Hello, Frameyard", "accent": "#b8f36b" }
    </script>
    <style>
      @keyframes fade-up {
        from { opacity: 0; transform: translateY(28px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes drift {
        from { transform: translate(-120px, -80px); }
        to { transform: translate(120px, 80px); }
      }
      #hello {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: #0b0d10;
        color: #e8edf3;
        font-family: Inter, system-ui, sans-serif;
      }
      #hello h1 {
        position: relative;
        margin: 0;
        font-size: 96px;
        letter-spacing: -0.04em;
        opacity: 0;
        animation: fade-up 1s cubic-bezier(0.215, 0.61, 0.355, 1) both;
      }
      #hello p {
        position: relative;
        margin: 18px 0 0;
        color: #8a97a6;
        font-size: 26px;
      }
      #glow {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 520px;
        height: 520px;
        margin: -260px 0 0 -260px;
        border-radius: 50%;
        background: var(--fy-prop-accent);
        filter: blur(120px);
        opacity: 0.16;
        animation: drift 12s ease-in-out infinite alternate;
      }
      #sweep {
        position: absolute;
        left: 0;
        bottom: 0;
        width: calc(var(--fy-progress) * 100%);
        height: 4px;
        background: var(--fy-prop-accent);
      }
    </style>
  </head>
  <body>
    <fy-composition width="1280" height="720" fps="30" duration-in-frames="150">
      <div id="hello">
        <div id="glow"></div>
        <div style="position: relative; text-align: center">
          <h1 id="title" data-fy-text="title" data-fy-anim-start="0" data-fy-anim-duration="24"></h1>
          <p>Deterministic video, authored on the web.</p>
        </div>
        <div id="sweep"></div>
      </div>
    </fy-composition>
  </body>
</html>
`,
};

// Keep the generated package name valid for npm and pnpm.
function packageName(projectName: string): string {
  const normalized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 214)
    .replace(/[._-]+$/g, "");
  return normalized === "" ? "frameyard-project" : normalized;
}

export function scaffoldFiles(projectName: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      {
        name: packageName(projectName),
        private: true,
        type: "module",
        scripts: {
          dev: `npx --yes frameyard@${VERSION} dev`,
          check: `npx --yes frameyard@${VERSION} check`,
          render: `npx --yes frameyard@${VERSION} render`,
          still: `npx --yes frameyard@${VERSION} still`,
        },
      },
      null,
      2,
    )}\n`,
    ...SCAFFOLD_TEMPLATES,
  };
}

export const SCAFFOLD_NEXT = [
  "npx frameyard doctor",
  "npx frameyard dev",
  "npx frameyard check main",
  "npx frameyard render main",
];
