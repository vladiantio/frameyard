import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertFreshDist } from "./dist.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

const composition = `<script type="application/json" data-fy="props">{ "label": "Hello" }</script>
    <style>
      @keyframes move { from { transform: translateX(0px); } to { transform: translateX(40px); } }
      #box { width: 20px; height: 20px; background: #ff5500; animation: move 0.6s linear infinite; }
      #label { color: white; font: 12px monospace; }
    </style>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="6">
      <div id="box" data-frame="-1" data-fy-anim-start="0" data-fy-anim-duration="6"></div>
      <div id="label"></div>
      <canvas id="canvas" width="160" height="90"></canvas>
      <audio src="assets/tone.wav" data-fy-start="1" data-fy-duration="0.4" data-fy-volume="0.4"></audio>
    </fy-composition>
    <script type="text/fy-controller">
import { random } from "frameyard/runtime";

let box;
let label;
let context;

export default {
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  mount({ root }) {
    box = root.querySelector("#box");
    label = root.querySelector("#label");
    context = root.querySelector("#canvas").getContext("2d");
  },
  update({ frame, props }) {
    box.dataset.frame = String(frame);
    box.dataset.random = random("frame:" + frame).toFixed(12);
    label.textContent = props.label + " " + frame;
    context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
    context.fillRect(0, 0, 160, 90);
  },
  dispose() {},
};
    </script>
`;

const mediaComposition = `<script type="application/json" data-fy="props">{ "declaredTone": true }</script>
    <style>video,canvas{position:absolute;top:0;width:80px;height:90px}video{left:0}canvas{left:80px}</style>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="12">
      <video id="clip" src="assets/clip.webm" data-fy-start="2" data-fy-trim="0.1" data-fy-duration="0.6" data-fy-volume="0.5"></video>
      <canvas id="gl" width="80" height="90"></canvas>
      <audio data-fy-if="declaredTone" src="assets/tone.wav" data-fy-start="0" data-fy-volume="0.25"></audio>
    </fy-composition>
    <script type="text/fy-controller">
let video;
let gl;

export default {
  mount({ root }) {
    video = root.querySelector("#clip");
    const canvas = root.querySelector("#gl");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  },
  update({ frame }) {
    const red = frame >= 6;
    gl.clearColor(red ? 1 : 0, 0, red ? 0 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    video.dataset.frame = String(frame);
  },
};
    </script>
`;

const longComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="40">
      <div style="width: 100%; height: 100%; background: #123456"></div>
    </fy-composition>
`;

const staticComposition = `<style>
      html, body { margin: 0; width: 100%; height: 100%; background: #123456; }
    </style>
    <fy-composition width="160" height="90"></fy-composition>
`;

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const missingVideoComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <video src="assets/missing.webm"></video>
    </fy-composition>
`;

const htmlComposition = `<script type="application/json" data-fy="props">{ "label": "HTML" }</script>
    <style>
      @keyframes move { from { transform: translateX(0px); } to { transform: translateX(40px); } }
      #box { width: 20px; height: 20px; background: #ff5500; animation: move 0.6s linear infinite; }
    </style>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="6">
      <div id="box" data-fy-anim-start="0" data-fy-anim-duration="6"></div>
      <div id="label" data-fy-text="label"></div>
      <audio src="assets/tone.wav" data-fy-start="1" data-fy-duration="0.4" data-fy-volume="0.4"></audio>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update({ frame, root }) {
    root.querySelector("#box").dataset.frame = String(frame);
  },
};
    </script>
`;

const legacyComposition = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body><fy-composition width="160" height="90" fps="10" duration-in-frames="2"></fy-composition></body>
</html>
`;

const invalidHtmlComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <div data-fy-txt="label"></div>
    </fy-composition>
`;

const includeComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <div style="position: absolute; inset: 0; background: #101820"></div>
      <fy-include src="./partials/card.html" props='{"label":"Live","color":"#ff0000"}'></fy-include>
    </fy-composition>
`;

const inlineIncludeComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <div style="position: absolute; inset: 0; background: #101820"></div>
      <div style="position: absolute; left: 10px; top: 10px; width: 40px; height: 20px; background: #ff0000"></div>
      <div style="position: absolute; left: 10px; top: 40px; color: white; font: 10px monospace">Live</div>
    </fy-composition>
`;

const staticIncludeComposition = `<fy-composition width="160" height="90">
      <div style="position: absolute; inset: 0; background: #101820"></div>
      <fy-include src="./partials/card.html" props='{"label":"Static","color":"#ff0000"}'></fy-include>
    </fy-composition>
`;

const includePartial = `<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle", "color": "#00ff00" }</script>
  <style>
    .card { position: absolute; left: 10px; top: 10px; width: 40px; height: 20px; background: var(--fy-prop-color); }
    .label { position: absolute; left: 10px; top: 40px; color: white; font: 10px monospace; }
  </style>
  <div class="card"></div>
  <div class="label" data-fy-text="label"></div>
</fy-partial>
`;

function toneWav(seconds = 0.6): Buffer {
  const sampleRate = 8_000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 330 * index) / sampleRate) * 4_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

export interface RunOptions {
  pinEncoder?: boolean;
  env?: NodeJS.ProcessEnv;
  policy?: "light" | "authoring" | "full" | null;
}

export async function runCli(
  args: string[],
  cwd = process.cwd(),
  options: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The CLI default probes the host GPU. Pin software encoding so the suite
  // exercises the same path on every machine; opt out only to test the default.
  const pinned =
    options.pinEncoder === false || args[0] !== "render" || args.includes("--encoder") || args.includes("--sequence")
      ? args
      : [...args, "--encoder", "software"];
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...pinned], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...(options.policy === null ? {} : { FRAMEYARD_POLICY: options.policy ?? "full" }),
        ...options.env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

export async function ffprobe(filePath: string, args: string[] = []): Promise<Record<string, unknown>> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    ...args,
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,codec_tag_string,width,height,channels,nb_read_frames,r_frame_rate",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

export async function decodedVideoHash(filePath: string): Promise<string> {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", filePath, "-map", "0:v:0", "-f", "md5", "-"]);
  const match = /MD5=([0-9a-f]+)/i.exec(stdout);
  if (!match) {
    throw new Error(`FFmpeg did not report a decoded video hash for ${filePath}.`);
  }
  return match[1] as string;
}

export async function pngPixel(filePath: string, x: number, y: number): Promise<number[]> {
  const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 1024 },
      (error, output) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: output });
      },
    );
  });
  return Array.from(stdout.subarray(0, 3));
}

export async function audioMeanVolume(filePath: string): Promise<number> {
  const { stderr } = await exec("ffmpeg", [
    "-hide_banner",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) {
    throw new Error(`FFmpeg did not report a mean volume for ${filePath}.`);
  }
  return Number(match[1]);
}

export interface CliProjectOptions {
  /** Skip the embedded WebM fixture for files that never capture media. */
  clip?: boolean;
}

/** Creates the shared, isolated CLI project fixture for one test file. */
export async function createCliProject(options: CliProjectOptions = {}): Promise<string> {
  await assertFreshDist();
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-cli-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { compositions: { demo: "./compositions/demo.html", media: "./compositions/media.html", long: "./compositions/long.html", "missing-video": "./compositions/missing-video.html", broken: "./compositions/broken.html", throwing: "./compositions/throwing.html", html: "./compositions/html.html", "html-invalid": "./compositions/html-invalid.html", legacy: "./compositions/legacy.html", static: "./compositions/static.html", preset: "./compositions/preset.html", schema: "./compositions/schema.html", "schema-required": "./compositions/schema-required.html", "schema-malformed": "./compositions/schema-malformed.html", include: "./compositions/include.html", "include-inline": "./compositions/include-inline.html", "include-static": "./compositions/include-static.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.html"), composition);
  await writeFile(path.join(root, "compositions", "media.html"), mediaComposition);
  await writeFile(path.join(root, "compositions", "long.html"), longComposition);
  await writeFile(path.join(root, "compositions", "missing-video.html"), missingVideoComposition);
  await writeFile(path.join(root, "compositions", "html.html"), htmlComposition);
  await writeFile(path.join(root, "compositions", "html-invalid.html"), invalidHtmlComposition);
  await writeFile(path.join(root, "compositions", "legacy.html"), legacyComposition);
  await writeFile(path.join(root, "compositions", "static.html"), staticComposition);
  await mkdir(path.join(root, "compositions", "partials"), { recursive: true });
  await writeFile(path.join(root, "compositions", "include.html"), includeComposition);
  await writeFile(path.join(root, "compositions", "include-inline.html"), inlineIncludeComposition);
  await writeFile(path.join(root, "compositions", "include-static.html"), staticIncludeComposition);
  await writeFile(path.join(root, "compositions", "partials", "card.html"), includePartial);
  await writeFile(
    path.join(root, "compositions", "preset.html"),
    `<fy-composition width="160" height="90" fps="10" duration-in-frames="12">
  <main style="position: absolute; inset: 0; background: #101820;">
    <div
      data-fy-anim-preset="fade-up"
      data-fy-anim-start="0"
      data-fy-anim-duration="10"
      data-fy-anim-easing="linear"
      style="position: absolute; left: 60px; top: 25px; width: 40px; height: 40px; background: #b8f36b;"
    ></div>
  </main>
</fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "schema-malformed.html"),
    `<script type="application/json" data-fy="props-schema">
{ "type": "object", "properties": { "title": { "type": "wat" } } }
</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div data-fy-text="title"></div>
</fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "schema-required.html"),
    `<script type="application/json" data-fy="props-schema">
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "accent": { "type": "string", "enum": ["lime", "orange"], "default": "lime" }
  },
  "required": ["title"]
}
</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div data-fy-text="title" style="color: white; font: 12px monospace"></div>
</fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "schema.html"),
    `<script type="application/json" data-fy="props">
{ "title": "Schema default", "accent": "lime" }
</script>
<script type="application/json" data-fy="props-schema">
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "accent": { "type": "string", "enum": ["lime", "orange"], "default": "lime" },
    "count": { "type": "number", "default": 3 }
  },
  "required": ["title"]
}
</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div data-fy-text="title" style="color: white; font: 12px monospace"></div>
</fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "broken.html"),
    `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <audio src="assets/missing.wav" data-fy-start="0"></audio>
    </fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "throwing.html"),
    `<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
      <div id="box"></div>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  update({ frame }) {
    if (frame === 3) throw new Error("frame boom");
  },
};
    </script>
`,
  );
  await writeFile(path.join(root, "assets", "tone.wav"), toneWav());
  if (options.clip !== false) {
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64:r=10:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "color=c=lime:s=64x64:r=10:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-map",
      "2:a",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "200k",
      "-c:a",
      "libopus",
      "-shortest",
      path.join(root, "assets", "clip.webm"),
    ]);
  }
  await writeFile(path.join(root, "props.json"), JSON.stringify({ label: "CLI" }));
  await writeFile(path.join(root, "embedded-props.json"), JSON.stringify({ declaredTone: false }));
  await writeFile(path.join(root, "bad-props.json"), JSON.stringify({ label: 42 }));
  await writeFile(path.join(root, "schema-valid.json"), JSON.stringify({ title: "Custom", accent: "orange" }));
  await writeFile(path.join(root, "schema-missing.json"), JSON.stringify({ accent: "orange" }));
  await writeFile(path.join(root, "schema-wrong-type.json"), JSON.stringify({ title: 42, accent: "orange" }));
  await writeFile(path.join(root, "schema-bad-enum.json"), JSON.stringify({ title: "A", accent: "blue" }));
  return root;
}
