import { VERSION } from "./version.js";

const AGENTS_GUIDE = `# AGENTS.md

This project produces deterministic, parameterized video with Frameyard. Follow this guide when editing or rendering it.

## Project layout

- \`video.config.js\` explicitly maps composition IDs to entry modules. There is no directory scanning; a new composition is invisible until it is listed.
- \`package.json\` pins the CLI version in \`dev\`, \`check\`, \`render\`, and \`still\` scripts. Run \`dev\` with \`npm run dev\` or \`pnpm dev\`; for the others, pass the composition id: \`npm run check -- hello\` (npm) or \`pnpm check hello\` (pnpm).
- \`compositions/\` contains native JavaScript ES modules. Import bare \`frameyard\` and \`frameyard/runtime\`; the preview server supplies the import map.
- \`props/\` contains JSON props, merged shallowly over \`defaultProps\` and deep-frozen.
- \`assets/\` (create it when needed) contains audio, images, fonts, and generated assets.

\`width\`, \`height\`, \`fps\`, and \`durationInFrames\` are fixed composition metadata. Do not derive them from props.

## Agent workflow

1. Read \`video.config.js\`, the composition source, and the props file before changing behavior.
2. Author the composition or props with native HTML, CSS, SVG, Canvas 2D, and JavaScript. Do not add a bundling step.
3. Validate every frame: \`npx frameyard check <id> --json\`. Use \`--props <file>\` to validate a specific props file.
4. Inspect a representative frame: \`npx frameyard still <id> --frame <n> --out <file.png> --json\`, then view the PNG when the host supports images. State explicitly when visual inspection is not possible.
5. Render: \`npx frameyard render <id> --props <file> --out <file.mp4> [--concurrency <n>] --json\`.
6. Report the composition, props, validation result, still path and inspection status, video path, and any failure. Never claim success when \`check\` fails, a still is missing, or a render exits nonzero.

## Commands

\`\`\`sh
npx frameyard dev
npx frameyard doctor --json
npx frameyard check hello --json
npx frameyard still hello --frame 42 --out hello-42.png --json
npx frameyard render hello --props props/hello.json --out hello.mp4 --json
\`\`\`

- Use \`--json\` for non-interactive commands. Parse stdout as the structured result; treat stderr as progress and diagnostics.
- Use \`--project <dir>\` when running outside the project root.
- Use \`--concurrency <n>\` for faster local rendering when useful; the default is \`1\` and the maximum is \`16\`. It changes capture scheduling only, not composition behavior or output frame order.
- \`still\` and \`render\` replace existing outputs only with \`--overwrite\`. Generated assets are replaced only with \`--force\`, and only with user approval.

## Determinism rules

- A frame may depend only on its integer \`frame\`, immutable \`props\`, and assets loaded before frame production.
- \`mount()\` may await loading work. \`update({ frame, props })\` is synchronous and seek-safe. \`dispose()\` releases resources.
- Keep mutable state in module-scope variables, not on \`this\`.
- Use \`random("stable:key")\` from \`frameyard/runtime\` for randomness.
- Never use \`Math.random()\`, \`Date.now()\`, \`performance.now()\`, timers, independent \`requestAnimationFrame()\` loops, CSS transitions, or state left from a previously visited frame as animation inputs.
- CSS \`@keyframes\` and the Web Animations API are valid; the runtime seeks them.
- Load remote data, fonts, and images during \`mount()\` or before the first frame. Network requests are blocked during capture; a \`fetch()\` from \`update()\` is a bug.
- Redraw Canvas 2D from the current frame.

## Audio and transcripts

- Audio clips are placed by composition frames and trimmed by seconds. Frameyard does not time-stretch audio or change composition duration to fit it.
- Produce speech with \`npx frameyard tts\` and transcripts with \`npx frameyard transcribe\`; never call \`qwen-tts\` or \`whisper-cli\` directly, and never run inference inside \`mount()\` or \`update()\`.
- Do not overwrite or regenerate generated assets without explicit approval.
- \`words: true\` requires measured word timings; never interpolate segment timings.
- Commit \`frameyard.assets.json\` when present; do not edit hashes or manifest entries by hand.

The official \`frameyard\` agent skill contains the full host-neutral contract. Install it with \`npx skills add vladiantio/frameyard\` or see the \`skills/frameyard/\` directory in the \`frameyard\` npm package. This file is the project-local summary.

This project was scaffolded with frameyard ${VERSION}. \`npx frameyard\` resolves the latest published version; run \`npx frameyard@${VERSION}\` when you need the CLI version that scaffolded the project.
`;

const PROJECT_README = `# My Frameyard project

Coding agents should read \`AGENTS.md\` for the project rules and the check, still, and render workflow.

Start the preview:

\`\`\`sh
npx frameyard dev
\`\`\`

Validate and render:

\`\`\`sh
npx frameyard doctor
npx frameyard check hello
npx frameyard render hello --props props/hello.json --out hello.mp4
\`\`\`

Or run the pinned scripts from \`package.json\`:

\`\`\`sh
npm run dev
npm run check -- hello
npm run render -- hello --props props/hello.json --out hello.mp4
npm run still -- hello --frame 42 --out hello-42.png
\`\`\`
`;

const SCAFFOLD_TEMPLATES: Record<string, string> = {
  "video.config.js": `export default {\n  compositions: {\n    hello: "./compositions/hello.js",\n  },\n};\n`,
  "props/hello.json": `${JSON.stringify({ title: "Hello, Frameyard", accent: "#b8f36b" }, null, 2)}\n`,
  "AGENTS.md": AGENTS_GUIDE,
  "README.md": PROJECT_README,
  "compositions/hello.js": `import { defineComposition } from "frameyard";

let title;
let sweep;
let glow;

export default defineComposition({
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 150,
  defaultProps: { title: "Hello, Frameyard", accent: "#b8f36b" },
  validateProps(props) {
    const errors = [];
    if (typeof props.title !== "string") errors.push("title must be a string");
    if (typeof props.accent !== "string") errors.push("accent must be a string");
    return errors;
  },
  mount({ container, props }) {
    container.style.setProperty("--accent", props.accent);
    container.innerHTML =
      '<style>' +
      '#hello { position: relative; width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden; background: #0b0d10; color: #e8edf3; font-family: Inter, system-ui, sans-serif; }' +
      '#hello h1 { position: relative; margin: 0; font-size: 96px; letter-spacing: -0.04em; }' +
      '#hello p { position: relative; margin: 18px 0 0; color: #8a97a6; font-size: 26px; }' +
      '#glow { position: absolute; width: 520px; height: 520px; border-radius: 50%; background: var(--accent); filter: blur(120px); opacity: 0.16; }' +
      '#sweep { position: absolute; left: 0; bottom: 0; width: 0%; height: 4px; background: var(--accent); }' +
      '</style>' +
      '<div id="hello"><div id="glow"></div><div style="position: relative; text-align: center"><h1 id="title"></h1><p>Deterministic video, authored on the web.</p></div><div id="sweep"></div></div>';
    title = container.querySelector("#title");
    sweep = container.querySelector("#sweep");
    glow = container.querySelector("#glow");
  },
  update({ frame, props }) {
    title.textContent = props.title;
    const intro = Math.min(1, frame / 24);
    title.style.opacity = String(intro);
    title.style.transform = "translateY(" + (1 - intro) * 28 + "px)";
    glow.style.transform =
      "translate(" + Math.sin(frame / 26) * 120 + "px," + Math.cos(frame / 34) * 80 + "px)";
    sweep.style.width = (frame / 149) * 100 + "%";
  },
  dispose() {
    title = undefined;
    sweep = undefined;
    glow = undefined;
  },
});
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
  "npx frameyard check hello",
  "npx frameyard render hello --out hello.mp4",
];
