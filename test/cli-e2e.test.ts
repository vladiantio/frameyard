import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";
import { assertFreshDist } from "./helpers/dist.ts";

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

const webglComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
      <canvas id="gl" width="160" height="90"></canvas>
    </fy-composition>
    <script type="text/fy-controller">
let gl;

export default {
  mount({ root }) {
    const canvas = root.querySelector("#gl");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  },
  update({ frame }) {
    const blue = frame < 3;
    gl.clearColor(blue ? 0 : 1, 0, blue ? 1 : 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

let root: string;

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

async function run(
  args: string[],
  cwd = process.cwd(),
  options: { pinEncoder?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The CLI default probes the host GPU. Pin software encoding so the suite
  // exercises the same path on every machine; opt out only to test the default.
  const pinned =
    options.pinEncoder === false || args[0] !== "render" || args.includes("--encoder")
      ? args
      : [...args, "--encoder", "software"];
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...pinned], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function ffprobe(filePath: string, args: string[] = []): Promise<Record<string, unknown>> {
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

async function decodedVideoHash(filePath: string): Promise<string> {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", filePath, "-map", "0:v:0", "-f", "md5", "-"]);
  const match = /MD5=([0-9a-f]+)/i.exec(stdout);
  if (!match) {
    throw new Error(`FFmpeg did not report a decoded video hash for ${filePath}.`);
  }
  return match[1] as string;
}

async function pngPixel(filePath: string, x: number, y: number): Promise<number[]> {
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

async function audioMeanVolume(filePath: string): Promise<number> {
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

beforeAll(async () => {
  await assertFreshDist();
  root = await mkdtemp(path.join(tmpdir(), "frameyard-cli-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { demo: "./compositions/demo.html", media: "./compositions/media.html", webgl: "./compositions/webgl.html", long: "./compositions/long.html", "missing-video": "./compositions/missing-video.html", broken: "./compositions/broken.html", throwing: "./compositions/throwing.html", html: "./compositions/html.html", "html-invalid": "./compositions/html-invalid.html", legacy: "./compositions/legacy.html", static: "./compositions/static.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.html"), composition);
  await writeFile(path.join(root, "compositions", "media.html"), mediaComposition);
  await writeFile(path.join(root, "compositions", "webgl.html"), webglComposition);
  await writeFile(path.join(root, "compositions", "long.html"), longComposition);
  await writeFile(path.join(root, "compositions", "missing-video.html"), missingVideoComposition);
  await writeFile(path.join(root, "compositions", "html.html"), htmlComposition);
  await writeFile(path.join(root, "compositions", "html-invalid.html"), invalidHtmlComposition);
  await writeFile(path.join(root, "compositions", "legacy.html"), legacyComposition);
  await writeFile(path.join(root, "compositions", "static.html"), staticComposition);
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
  await writeFile(path.join(root, "props.json"), JSON.stringify({ label: "CLI" }));
  await writeFile(path.join(root, "embedded-props.json"), JSON.stringify({ declaredTone: false }));
  await writeFile(path.join(root, "bad-props.json"), JSON.stringify({ label: 42 }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CLI end-to-end", () => {
  it("checks every frame and resolves audio", async () => {
    const result = await run(["check", "demo", "--project", root, "--json"], root);

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "check",
      composition: "demo",
      metadata: {
        width: 160,
        height: 90,
        fps: 10,
        durationInFrames: 6,
      },
      framesChecked: 6,
    });
    expect(json.audio).toMatchObject({ clips: 1 });
    expect(json.diagnostics).toEqual([]);
  });

  it("checks, stills, and renders an HTML composition", async () => {
    const check = await run(["check", "html", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({
      ok: true,
      command: "check",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      metadata: { width: 160, height: 90, fps: 10, durationInFrames: 6 },
      framesChecked: 6,
      audio: { clips: 1 },
      diagnostics: [],
    });

    const still = await run(
      ["still", "html", "--frame", "3", "--out", "html-3.png", "--project", root, "--json"],
      root,
    );
    expect(still.code).toBe(0);
    const stillJson = JSON.parse(still.stdout) as Record<string, unknown>;
    expect(stillJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      frame: 3,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    const pixel = await pngPixel(path.join(root, "html-3.png"), 25, 5);
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[1]).toBeGreaterThan(40);
    expect(pixel[2]).toBeLessThan(40);

    await mkdir(path.join(root, "nested"), { recursive: true });
    const render = await run(
      ["render", "html", "--encoder", "software", "--project", root, "--json"],
      path.join(root, "nested"),
    );
    expect(render.code).toBe(0);
    const rendered = JSON.parse(render.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      path: path.join(root, "out", "html.mp4"),
      framesRendered: 6,
      encoder: "libx264",
      audio: { clips: 1 },
      diagnostics: [],
    });
    const probe = await ffprobe(path.join(root, "out", "html.mp4"), ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "h264",
      width: 160,
      height: 90,
      nb_read_frames: "6",
    });
    expect(streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
  });

  it("checks, stills, and renders a static composition as a PNG", async () => {
    const check = await run(["check", "static", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({
      ok: true,
      command: "check",
      composition: "static",
      entry: "compositions/static.html",
      kind: "static",
      metadata: { width: 160, height: 90, static: true },
      framesChecked: 1,
      diagnostics: [],
    });
    expect(checked).not.toHaveProperty("audio");
    expect(checked).not.toHaveProperty("transcripts");

    const still = await run(
      ["still", "static", "--frame", "0", "--out", "static-0.png", "--project", root, "--json"],
      root,
    );
    expect(still.code).toBe(0);
    const stillJson = JSON.parse(still.stdout) as Record<string, unknown>;
    expect(stillJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "static",
      entry: "compositions/static.html",
      frame: 0,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    const pixel = await pngPixel(path.join(root, "static-0.png"), 80, 45);
    expect(pixel[2]).toBeGreaterThan(pixel[0] ?? 0);

    const outPath = path.join(root, "out", "static.png");
    const render = await run(["render", "static", "--project", root, "--json"], root, { pinEncoder: false });
    expect(render.code).toBe(0);
    const rendered = JSON.parse(render.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      kind: "image",
      composition: "static",
      entry: "compositions/static.html",
      path: outPath,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    expect(rendered).not.toHaveProperty("codec");
    expect(rendered).not.toHaveProperty("framesRendered");
    expect((await stat(outPath)).size).toBeGreaterThan(0);

    const outOfRange = await run(["still", "static", "--frame", "1", "--project", root, "--json"], root);
    expect(outOfRange.code).toBe(1);
    expect(JSON.parse(outOfRange.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "FRAME_OUT_OF_RANGE" },
    });

    const videoFlag = await run(["render", "static", "--container", "mp4", "--project", root, "--json"], root, {
      pinEncoder: false,
    });
    expect(videoFlag.code).toBe(2);
    expect(JSON.parse(videoFlag.stdout)).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "USAGE" },
    });
  });

  it("returns static diagnostics for an invalid HTML composition", async () => {
    const result = await run(["check", "html-invalid", "--project", root, "--json"], root);
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "BINDING_INVALID" },
    });
    expect(json.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "BINDING_INVALID",
          details: expect.objectContaining({
            line: expect.any(Number),
            column: expect.any(Number),
            attribute: "data-fy-txt",
          }),
        }),
      ]),
    );
  });

  it("fails a legacy full document with COMPOSITION_DOCUMENT_SHELL", async () => {
    const result = await run(["check", "legacy", "--project", root, "--json"], root);
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "COMPOSITION_DOCUMENT_SHELL" },
    });
    expect(json.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "COMPOSITION_DOCUMENT_SHELL",
          details: expect.objectContaining({
            path: "compositions/legacy.html",
            suggestion: expect.stringContaining("migration-0.8.md"),
          }),
        }),
      ]),
    );
  });

  it("fails check with invalid props and a structured error", async () => {
    const result = await run(["check", "demo", "--props", "bad-props.json", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "PROPS_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("label must be a string");
  });

  it("fails check when a required asset is missing", async () => {
    const result = await run(["check", "broken", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "MEDIA_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain('Composition "broken"');
    expect(String((json.error as Record<string, unknown>).message)).toContain("assets/missing.wav");
  });

  it("fails check when an embedded video is missing", async () => {
    const result = await run(["check", "missing-video", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "MEDIA_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("assets/missing.webm");
  });

  it("returns a JSON error envelope for usage failures", async () => {
    const result = await run(["render", "--json"], root);

    expect(result.code).toBe(2);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "USAGE" },
    });
  });

  it("captures deterministic stills through the production path", async () => {
    const first = await run(
      ["still", "demo", "--frame", "3", "--out", "still-a.png", "--props", "props.json", "--project", root, "--json"],
      root,
    );
    const second = await run(
      ["still", "demo", "--frame", "3", "--out", "still-b.png", "--props", "props.json", "--project", root, "--json"],
      root,
    );

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "demo",
      frame: 3,
      width: 160,
      height: 90,
    });
    expect(firstJson.frames).toEqual([{ frame: 3, path: path.join(root, "still-a.png") }]);

    const [a, b] = await Promise.all([
      readFile(path.join(root, "still-a.png")),
      readFile(path.join(root, "still-b.png")),
    ]);
    expect(a.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));

    const probe = await ffprobe(path.join(root, "still-a.png"));
    const stream = (probe.streams as Array<Record<string, unknown>>)[0];
    expect(stream).toMatchObject({ width: 160, height: 90 });
  });

  it("captures embedded video and WebGL stills deterministically", async () => {
    const first = await run(
      ["still", "media", "--frame", "3", "--out", "media-3a.png", "--project", root, "--json"],
      root,
    );
    const second = await run(
      ["still", "media", "--frame", "3", "--out", "media-3b.png", "--project", root, "--json"],
      root,
    );
    const later = await run(
      ["still", "media", "--frame", "7", "--out", "media-7.png", "--project", root, "--json"],
      root,
    );

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(later.code).toBe(0);

    const [a, b, c] = await Promise.all([
      readFile(path.join(root, "media-3a.png")),
      readFile(path.join(root, "media-3b.png")),
      readFile(path.join(root, "media-7.png")),
    ]);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    expect(createHash("sha256").update(a).digest("hex")).not.toBe(createHash("sha256").update(c).digest("hex"));

    const earlyVideo = await pngPixel(path.join(root, "media-3a.png"), 10, 10);
    const earlyWebGl = await pngPixel(path.join(root, "media-3a.png"), 100, 10);
    expect(earlyVideo[0]).toBeGreaterThan(180);
    expect(earlyVideo[1]).toBeLessThan(60);
    expect(earlyWebGl[2]).toBeGreaterThan(200);
    expect(earlyWebGl[0]).toBeLessThan(20);

    const lateVideo = await pngPixel(path.join(root, "media-7.png"), 10, 10);
    const lateWebGl = await pngPixel(path.join(root, "media-7.png"), 100, 10);
    expect(lateVideo[1]).toBeGreaterThan(180);
    expect(lateVideo[0]).toBeLessThan(60);
    expect(lateWebGl[0]).toBeGreaterThan(200);
    expect(lateWebGl[2]).toBeLessThan(20);
  });

  it("captures WebGL-only compositions deterministically", async () => {
    const first = await run(
      ["still", "webgl", "--frame", "1", "--out", "webgl-1a.png", "--project", root, "--json"],
      root,
    );
    const second = await run(
      ["still", "webgl", "--frame", "1", "--out", "webgl-1b.png", "--project", root, "--json"],
      root,
    );
    const later = await run(
      ["still", "webgl", "--frame", "4", "--out", "webgl-4.png", "--project", root, "--json"],
      root,
    );

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(later.code).toBe(0);

    const [a, b] = await Promise.all([
      readFile(path.join(root, "webgl-1a.png")),
      readFile(path.join(root, "webgl-1b.png")),
    ]);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));

    const early = await pngPixel(path.join(root, "webgl-1a.png"), 10, 10);
    expect(early[2]).toBeGreaterThan(200);
    expect(early[0]).toBeLessThan(20);

    const late = await pngPixel(path.join(root, "webgl-4.png"), 10, 10);
    expect(late[0]).toBeGreaterThan(200);
    expect(late[2]).toBeLessThan(20);
  });

  it("captures identical PNGs from concurrent still sessions", async () => {
    const capturePair = async (compositionId: string, frame: number, label: string, extraArgs: string[] = []) => {
      const baseArgs = ["still", compositionId, "--frame", String(frame), "--project", root, "--json", ...extraArgs];
      const [first, second] = await Promise.all([
        run([...baseArgs, "--out", `${label}-a.png`], root),
        run([...baseArgs, "--out", `${label}-b.png`], root),
      ]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
      const secondJson = JSON.parse(second.stdout) as Record<string, unknown>;
      expect(firstJson).toMatchObject({ ok: true, command: "still", composition: compositionId, frame });
      expect(secondJson).toMatchObject({ ok: true, command: "still", composition: compositionId, frame });

      const [a, b] = await Promise.all([
        readFile(path.join(root, `${label}-a.png`)),
        readFile(path.join(root, `${label}-b.png`)),
      ]);
      expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    };

    await capturePair("demo", 3, "concurrent-demo", ["--props", "props.json"]);
    await capturePair("media", 3, "concurrent-media");
  });

  it("captures a batch of stills in one session", async () => {
    const result = await run(
      ["still", "demo", "--frame", "0,3,5", "--props", "props.json", "--out", "batch", "--project", root, "--json"],
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      frames?: Array<{ frame: number; path: string }>;
      frame?: number;
      path?: string;
    };
    expect(json.frames?.map((entry) => entry.frame)).toEqual([0, 3, 5]);
    expect(json).not.toHaveProperty("frame");
    expect(json).not.toHaveProperty("path");

    for (const frame of [0, 3, 5]) {
      const batchPath = path.join(root, "batch", `still-demo-${frame}.png`);
      expect(json.frames?.find((entry) => entry.frame === frame)?.path).toBe(batchPath);
      const capture = await run(
        [
          "still",
          "demo",
          "--frame",
          String(frame),
          "--props",
          "props.json",
          "--out",
          `single-${frame}.png`,
          "--project",
          root,
          "--json",
        ],
        root,
      );
      expect(capture.code, capture.stderr).toBe(0);
      const [batchPng, singlePng] = await Promise.all([
        readFile(batchPath),
        readFile(path.join(root, `single-${frame}.png`)),
      ]);
      expect(batchPng.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(createHash("sha256").update(batchPng).digest("hex")).toBe(
        createHash("sha256").update(singlePng).digest("hex"),
      );
    }
  });

  it("expands ranges, preserves order, and removes duplicates", async () => {
    const result = await run(
      ["still", "long", "--frame", " 2-4, 4, 0 ", "--out", "range", "--project", root, "--json"],
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as { frames?: Array<{ frame: number; path: string }> };
    expect(json.frames?.map((entry) => entry.frame)).toEqual([2, 3, 4, 0]);
    expect(json.frames?.map((entry) => path.basename(entry.path))).toEqual([
      "still-long-2.png",
      "still-long-3.png",
      "still-long-4.png",
      "still-long-0.png",
    ]);
  });

  it("enforces the 32-frame still cap", async () => {
    const accepted = await run(
      ["still", "long", "--frame", "0-31", "--out", "cap-ok", "--project", root, "--json"],
      root,
    );
    expect(accepted.code, accepted.stderr).toBe(0);
    const acceptedJson = JSON.parse(accepted.stdout) as { frames?: unknown[] };
    expect(acceptedJson.frames).toHaveLength(32);

    const rejected = await run(
      ["still", "long", "--frame", "0-32", "--out", "cap-rejected", "--project", root, "--json"],
      root,
    );
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "USAGE", details: { cap: 32, count: 33 } },
    });
    await expect(stat(path.join(root, "cap-rejected"))).rejects.toThrow();
  }, 120_000);

  it("rejects malformed and descending frame specs before creating output", async () => {
    for (const spec of ["4-2", "2-", "0,,2", "0 - 2", "2.5", "abc"]) {
      const result = await run(
        ["still", "long", "--frame", spec, "--out", "invalid-spec", "--project", root, "--json"],
        root,
      );
      expect(result.code, spec).toBe(2);
      expect(JSON.parse(result.stdout), spec).toMatchObject({
        ok: false,
        command: "still",
        error: { code: "USAGE" },
      });
    }
    await expect(stat(path.join(root, "invalid-spec"))).rejects.toThrow();
  });

  it("rejects out-of-range still frames before capture", async () => {
    const result = await run(
      ["still", "demo", "--frame", "0,99", "--out", "out-of-range", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "FRAME_OUT_OF_RANGE",
        details: { invalidFrames: [99], validRange: { min: 0, max: 5 } },
      },
    });
    await expect(stat(path.join(root, "out-of-range"))).rejects.toThrow();
  });

  it("reports frame bounds before output conflicts", async () => {
    const outDir = path.join(root, "bounds-before-conflicts");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "still-demo-0.png"), "existing");

    const result = await run(
      ["still", "demo", "--frame", "0,99", "--out", "bounds-before-conflicts", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "FRAME_OUT_OF_RANGE" },
    });
  });

  it("preflights every still output before capture", async () => {
    const outDir = path.join(root, "conflicts");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "still-demo-0.png"), "existing");
    await writeFile(path.join(outDir, "still-demo-3.png"), "existing");

    const result = await run(
      ["still", "demo", "--frame", "0,2,3", "--props", "props.json", "--out", "conflicts", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "OUTPUT_EXISTS",
        details: {
          conflicts: [path.join(outDir, "still-demo-0.png"), path.join(outDir, "still-demo-3.png")],
        },
      },
    });
    await expect(stat(path.join(outDir, "still-demo-2.png"))).rejects.toThrow();

    const overwrite = await run(
      [
        "still",
        "demo",
        "--frame",
        "0,2,3",
        "--props",
        "props.json",
        "--out",
        "conflicts",
        "--project",
        root,
        "--overwrite",
        "--json",
      ],
      root,
    );
    expect(overwrite.code, overwrite.stderr).toBe(0);
    expect((await readFile(path.join(outDir, "still-demo-0.png"))).subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("uses a file for one still and a directory for many", async () => {
    const single = await run(
      ["still", "demo", "--frame", "0", "--out", "single-output.png", "--project", root, "--json"],
      root,
    );
    expect(single.code, single.stderr).toBe(0);
    const singleJson = JSON.parse(single.stdout) as { frame?: number; path?: string; frames?: unknown[] };
    expect(singleJson).toMatchObject({ frame: 0, path: path.join(root, "single-output.png") });
    expect(singleJson.frames).toHaveLength(1);

    const pngDirectory = await run(
      ["still", "demo", "--frame", "0,1", "--out", "not-a-directory.png", "--project", root, "--json"],
      root,
    );
    expect(pngDirectory.code).toBe(2);
    expect(JSON.parse(pngDirectory.stdout)).toMatchObject({ error: { code: "USAGE" } });

    await writeFile(path.join(root, "still-file"), "existing");
    const fileDirectory = await run(
      ["still", "demo", "--frame", "0,1", "--out", "still-file", "--project", root, "--json"],
      root,
    );
    expect(fileDirectory.code).toBe(2);
    expect(JSON.parse(fileDirectory.stdout)).toMatchObject({ error: { code: "USAGE" } });
  });

  it("publishes no stills when a later frame fails", async () => {
    const outDir = path.join(root, "throwing-batch");
    const result = await run(
      ["still", "throwing", "--frame", "0-5", "--out", "throwing-batch", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "COMPOSITION_ERROR",
        details: { frames: [0, 1, 2, 3, 4, 5], failedFrame: 3 },
      },
    });
    await expect(stat(outDir)).rejects.toThrow();
  });

  it("captures embedded video and WebGL frames in one batch", async () => {
    const batch = await run(
      ["still", "media", "--frame", "3,7", "--out", "media-batch", "--project", root, "--json"],
      root,
    );
    expect(batch.code, batch.stderr).toBe(0);
    const batchJson = JSON.parse(batch.stdout) as { frames?: Array<{ frame: number; path: string }> };
    expect(batchJson.frames?.map((entry) => entry.frame)).toEqual([3, 7]);

    const singleThree = await run(
      ["still", "media", "--frame", "3", "--out", "media-single-3.png", "--project", root, "--json"],
      root,
    );
    expect(singleThree.code, singleThree.stderr).toBe(0);

    const [batchThree, singleThreePng] = await Promise.all([
      readFile(path.join(root, "media-batch", "still-media-3.png")),
      readFile(path.join(root, "media-single-3.png")),
    ]);
    expect(createHash("sha256").update(batchThree).digest("hex")).toBe(
      createHash("sha256").update(singleThreePng).digest("hex"),
    );

    const [earlyVideo, earlyWebGl] = await Promise.all([
      pngPixel(path.join(root, "media-batch", "still-media-3.png"), 10, 10),
      pngPixel(path.join(root, "media-batch", "still-media-3.png"), 100, 10),
    ]);
    expect(earlyVideo[0]).toBeGreaterThan(180);
    expect(earlyVideo[1]).toBeLessThan(60);
    expect(earlyWebGl[2]).toBeGreaterThan(200);
    expect(earlyWebGl[0]).toBeLessThan(20);

    const [lateVideo, lateWebGl] = await Promise.all([
      pngPixel(path.join(root, "media-batch", "still-media-7.png"), 10, 10),
      pngPixel(path.join(root, "media-batch", "still-media-7.png"), 100, 10),
    ]);
    expect(lateVideo[1]).toBeGreaterThan(180);
    expect(lateVideo[0]).toBeLessThan(60);
    expect(lateWebGl[0]).toBeGreaterThan(200);
    expect(lateWebGl[2]).toBeLessThan(20);
  });

  it("uses still-<id>-<frame>.png when --out is omitted", async () => {
    const cwd = path.join(root, "default-names");
    await mkdir(cwd, { recursive: true });
    const result = await run(["still", "long", "--frame", "0,2", "--project", root, "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect((await stat(path.join(cwd, "still-long-0.png"))).size).toBeGreaterThan(0);
    expect((await stat(path.join(cwd, "still-long-2.png"))).size).toBeGreaterThan(0);

    const single = await run(["still", "long", "--frame", "1", "--project", root, "--json"], cwd);
    expect(single.code, single.stderr).toBe(0);
    expect((await stat(path.join(cwd, "still-long-1.png"))).size).toBeGreaterThan(0);
  });

  it("prints one line per still and a summary in human mode", async () => {
    const result = await run(["still", "demo", "--frame", "0,3", "--out", "human-batch", "--project", root], root);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Wrote frame 0 of demo");
    expect(lines[1]).toContain("Wrote frame 3 of demo");
    expect(lines[2]).toContain("Wrote 2 frames of demo");
  });

  it("checks and renders embedded video audio with the declared timeline", async () => {
    const check = await run(["check", "media", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({ ok: true, command: "check", composition: "media", framesChecked: 12 });
    const audio = checked.audio as { clips: number; details: Array<Record<string, unknown>> };
    expect(audio.clips).toBe(2);
    expect(checked.diagnostics).toEqual([]);
    expect(audio.details.map((clip) => clip.src)).toEqual(["assets/tone.wav", "assets/clip.webm"]);

    const sequential = await run(
      ["render", "media", "--out", "media-sequential.mp4", "--concurrency", "1", "--project", root, "--json"],
      root,
    );
    const parallel = await run(
      ["render", "media", "--out", "media-parallel.mp4", "--concurrency", "2", "--project", root, "--json"],
      root,
    );

    expect(sequential.code).toBe(0);
    expect(parallel.code).toBe(0);
    const rendered = JSON.parse(sequential.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      composition: "media",
      fps: 10,
      durationInFrames: 12,
      framesRendered: 12,
    });
    expect(rendered.audio).toMatchObject({ clips: 2 });
    expect(rendered.diagnostics).toEqual([]);

    const probe = await ffprobe(path.join(root, "media-sequential.mp4"), ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audioStream = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", width: 160, height: 90, nb_read_frames: "12" });
    expect(audioStream).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number((probe.format as Record<string, unknown>).duration)).toBeCloseTo(1.2, 1);

    expect(await decodedVideoHash(path.join(root, "media-parallel.mp4"))).toBe(
      await decodedVideoHash(path.join(root, "media-sequential.mp4")),
    );

    const embeddedOnly = await run(
      ["render", "media", "--props", "embedded-props.json", "--out", "media-embedded.mp4", "--project", root, "--json"],
      root,
    );
    expect(embeddedOnly.code).toBe(0);
    const embeddedJson = JSON.parse(embeddedOnly.stdout) as Record<string, unknown>;
    expect(embeddedJson.audio).toMatchObject({ clips: 1 });
    expect(embeddedJson.diagnostics).toEqual([]);
    const embeddedProbe = await ffprobe(path.join(root, "media-embedded.mp4"));
    const embeddedStreams = embeddedProbe.streams as Array<Record<string, unknown>>;
    expect(embeddedStreams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
    expect(await audioMeanVolume(path.join(root, "media-embedded.mp4"))).toBeGreaterThan(-40);
  });

  it("renders an MP4 with the declared frames and an audio stream", async () => {
    const result = await run(
      ["render", "demo", "--props", "props.json", "--out", "video.mp4", "--project", root, "--json"],
      root,
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      width: 160,
      height: 90,
      fps: 10,
      durationInFrames: 6,
      framesRendered: 6,
      concurrency: 1,
    });

    const outputPath = path.join(root, "video.mp4");
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);

    const probe = await ffprobe(outputPath, ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", width: 160, height: 90, nb_read_frames: "6" });
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number((probe.format as Record<string, unknown>).duration)).toBeCloseTo(0.6, 1);
  });

  it("reports the resolved encoder when --encoder is omitted", async () => {
    const result = await run(["render", "demo", "--out", "default-encoder.mp4", "--project", root, "--json"], root, {
      pinEncoder: false,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "render", framesRendered: 6 });
    expect(["libx264", "h264_nvenc", "h264_qsv"]).toContain(json.encoder);
  });

  it("rejects an invalid render concurrency", async () => {
    for (const value of ["0", "1.5", "many", "17"]) {
      const result = await run(
        ["render", "demo", "--out", "invalid.mp4", "--concurrency", value, "--project", root, "--json"],
        root,
      );

      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({
        ok: false,
        command: "render",
        error: { code: "USAGE" },
      });
      expect(String((json.error as Record<string, unknown>).message)).toContain("--concurrency");
    }
  });

  it("rejects an unknown render encoder", async () => {
    for (const value of ["vaapi", "libx264"]) {
      const result = await run(
        ["render", "demo", "--out", "invalid.mp4", "--encoder", value, "--project", root, "--json"],
        root,
      );

      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({
        ok: false,
        command: "render",
        error: { code: "USAGE" },
      });
      expect(String((json.error as Record<string, unknown>).message)).toContain("--encoder");
    }
  });

  it("rejects an unknown render codec and a codec/encoder mismatch", async () => {
    const unknown = await run(
      ["render", "demo", "--out", "invalid.mp4", "--codec", "av1", "--project", root, "--json"],
      root,
    );
    expect(unknown.code).toBe(2);
    const unknownJson = JSON.parse(unknown.stdout) as Record<string, unknown>;
    expect(unknownJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((unknownJson.error as Record<string, unknown>).message)).toContain("--codec");

    const mismatch = await run(
      [
        "render",
        "demo",
        "--out",
        "invalid.mp4",
        "--codec",
        "vp9",
        "--container",
        "mkv",
        "--encoder",
        "nvenc",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(mismatch.code).toBe(2);
    const mismatchJson = JSON.parse(mismatch.stdout) as Record<string, unknown>;
    expect(mismatchJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((mismatchJson.error as Record<string, unknown>).message)).toContain("has no nvenc encoder");
  });

  it("renders HEVC with the hvc1 sample entry", async () => {
    const result = await run(
      ["render", "demo", "--codec", "hevc", "--encoder", "software", "--out", "hevc.mp4", "--project", root, "--json"],
      root,
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      codec: "hevc",
      encoder: "libx265",
      framesRendered: 6,
    });

    const probe = await ffprobe(path.join(root, "hevc.mp4"), ["-count_frames"]);
    const video = (probe.streams as Array<Record<string, unknown>>).find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({ codec_name: "hevc", codec_tag_string: "hvc1", nb_read_frames: "6" });
  });

  it("renders MOV and WebM containers with matching codecs", async () => {
    const mov = await run(
      [
        "render",
        "demo",
        "--container",
        "mov",
        "--encoder",
        "software",
        "--out",
        "demo.mov",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(mov.code).toBe(0);
    expect(JSON.parse(mov.stdout)).toMatchObject({
      ok: true,
      codec: "h264",
      container: "mov",
      encoder: "libx264",
    });
    const movProbe = await ffprobe(path.join(root, "demo.mov"), ["-count_frames"]);
    expect(String((movProbe.format as Record<string, unknown>).format_name)).toContain("mov");
    expect(
      (movProbe.streams as Array<Record<string, unknown>>).find((stream) => stream.codec_type === "video"),
    ).toMatchObject({ codec_name: "h264", nb_read_frames: "6" });

    const webm = await run(
      [
        "render",
        "demo",
        "--container",
        "webm",
        "--encoder",
        "software",
        "--out",
        "demo.webm",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(webm.code).toBe(0);
    expect(JSON.parse(webm.stdout)).toMatchObject({
      ok: true,
      codec: "vp9",
      container: "webm",
      encoder: "libvpx-vp9",
    });
    const webmProbe = await ffprobe(path.join(root, "demo.webm"), ["-count_frames"]);
    expect(String((webmProbe.format as Record<string, unknown>).format_name)).toContain("webm");
    const streams = webmProbe.streams as Array<Record<string, unknown>>;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "vp9",
      nb_read_frames: "6",
    });
    expect(streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "opus" });
  });

  it("rejects containers that cannot hold the codec or the output extension", async () => {
    for (const args of [
      ["--container", "avi"],
      ["--container", "mp4", "--codec", "vp9"],
      ["--container", "webm", "--codec", "hevc"],
    ]) {
      const result = await run(["render", "demo", "--out", "invalid.mp4", ...args, "--project", root, "--json"], root);
      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    }

    const extension = await run(
      ["render", "demo", "--container", "mkv", "--out", "wrong.mp4", "--project", root, "--json"],
      root,
    );
    expect(extension.code).toBe(2);
    const extensionJson = JSON.parse(extension.stdout) as Record<string, unknown>;
    expect(extensionJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((extensionJson.error as Record<string, unknown>).message)).toContain(".mkv");
  });

  it("renders identical frames with parallel capture sessions", async () => {
    const sequential = await run(
      [
        "render",
        "demo",
        "--props",
        "props.json",
        "--out",
        "sequential.mp4",
        "--concurrency",
        "1",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    const parallel = await run(
      [
        "render",
        "demo",
        "--props",
        "props.json",
        "--out",
        "parallel.mp4",
        "--concurrency",
        "2",
        "--project",
        root,
        "--json",
      ],
      root,
    );

    expect(sequential.code).toBe(0);
    expect(parallel.code).toBe(0);
    const json = JSON.parse(parallel.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      durationInFrames: 6,
      framesRendered: 6,
      concurrency: 2,
    });

    const parallelProbe = await ffprobe(path.join(root, "parallel.mp4"), ["-count_frames"]);
    const streams = parallelProbe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", nb_read_frames: "6" });
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });

    // End-to-end smoke check only: x264 threading and rate control are not a
    // determinism guarantee. The capture-boundary check is "captures identical
    // PNGs from concurrent still sessions".
    expect(await decodedVideoHash(path.join(root, "parallel.mp4"))).toBe(
      await decodedVideoHash(path.join(root, "sequential.mp4")),
    );
  });

  it("stops a parallel render when a frame fails and publishes nothing", async () => {
    const outputPath = path.join(root, "throwing.mp4");
    const result = await run(
      ["render", "throwing", "--out", "throwing.mp4", "--concurrency", "2", "--project", root, "--json"],
      root,
    );

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "COMPOSITION_ERROR" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("frame boom");
    await expect(stat(outputPath)).rejects.toThrow();
  });

  it("refuses to overwrite an existing render unless asked", async () => {
    const outputPath = path.join(root, "video.mp4");
    const before = await readFile(outputPath);
    const result = await run(["render", "demo", "--out", "video.mp4", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: false, command: "render", error: { code: "OUTPUT_EXISTS" } });
    expect(await readFile(outputPath)).toEqual(before);

    const overwrite = await run(
      ["render", "demo", "--out", "video.mp4", "--project", root, "--overwrite", "--json"],
      root,
    );
    expect(overwrite.code).toBe(0);
  });

  it("starts and stops the dev preview", async () => {
    const child = spawn(process.execPath, [cli, "dev", "--project", root, "--port", "0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dev did not start:\n${stderr}`)), 15_000);
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = /Frameyard preview: (http:\/\/\S+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve(match[1] as string);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`dev exited early with ${code}:\n${stderr}`));
        });
      });

      const response = await fetch(new URL("/__frameyard/", url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Frameyard Preview");

      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("scaffolds a working project with init", async () => {
    const target = path.join(root, "scaffold");
    const init = await run(["init", target, "--json"], root);

    expect(init.code).toBe(0);
    const json = JSON.parse(init.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "init" });
    expect(json.files).toContain(".gitignore");
    expect(json.files).toContain("AGENTS.md");
    expect(json.files).toContain("package.json");
    expect(json.next).toEqual([
      "npx frameyard doctor",
      "npx frameyard dev",
      "npx frameyard check main",
      "npx frameyard render main",
    ]);
    expect((await stat(path.join(target, "video.config.js"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "compositions", "hello.html"))).isFile()).toBe(true);
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toBe("out/\n");

    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    expect(manifest).toEqual({
      name: "scaffold",
      private: true,
      type: "module",
      scripts: {
        dev: `npx --yes frameyard@${VERSION} dev`,
        check: `npx --yes frameyard@${VERSION} check`,
        render: `npx --yes frameyard@${VERSION} render`,
        still: `npx --yes frameyard@${VERSION} still`,
      },
    });

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("fy-composition");
    expect(agents).toContain("data-fy-text");
    expect(agents).toContain("data-fy-anim-start");
    expect(agents).toContain('random("stable:key")');
    expect(agents).toContain("qwen-tts");
    expect(agents).toContain("whisper-cli");
    expect(agents).toContain("frameyard.assets.json");
    expect(agents).toContain("npx frameyard@");
    expect(agents).toContain("npx skills add vladiantio/frameyard");
    for (const command of [
      "npx frameyard doctor --json",
      "npx frameyard check main --json",
      "npx frameyard still main --frame 42 --out main-42.png --json",
      "npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch --json",
    ]) {
      expect(agents).toContain(command);
    }

    const readme = await readFile(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("AGENTS.md");
    for (const command of [
      "npx frameyard dev",
      "npx frameyard doctor",
      "npx frameyard check main",
      "npx frameyard render main --props props/main.json",
    ]) {
      expect(readme).toContain(command);
    }

    const human = await run(["init", path.join(root, "scaffold-human")], root);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Next: npx frameyard doctor && npx frameyard dev");

    const check = await run(["check", "hello", "--project", target, "--json"], root);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, command: "check", framesChecked: 150 });
  });

  it("scaffolds into the current directory using its name", async () => {
    const target = path.join(root, "scaffold-dot");
    await mkdir(target);

    const init = await run(["init", ".", "--json"], target);
    expect(init.code).toBe(0);

    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    expect(manifest.name).toBe("scaffold-dot");
  });
});

describe("composition format inheritance", () => {
  const inheritedComposition = `<fy-composition duration-in-frames="6">
      <div style="width: 100%; height: 100%; background: #123456"></div>
    </fy-composition>
`;

  async function createFormatProject(options: { format?: boolean } = {}): Promise<string> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "frameyard-cli-format-"));
    await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
    await writeFile(path.join(projectRoot, "compositions", "plain.html"), inheritedComposition);
    await writeFile(
      path.join(projectRoot, "video.config.js"),
      `export default { ${
        options.format === false ? "" : "format: { width: 160, height: 90, fps: 10 }, "
      }compositions: { plain: "./compositions/plain.html" } };\n`,
    );
    return projectRoot;
  }

  it("checks and stills a composition that inherits the project format", async () => {
    const projectRoot = await createFormatProject();
    try {
      const check = await run(["check", "plain", "--project", projectRoot, "--json"], projectRoot);
      expect(check.code).toBe(0);
      expect(JSON.parse(check.stdout)).toMatchObject({
        ok: true,
        command: "check",
        composition: "plain",
        metadata: { width: 160, height: 90, fps: 10, durationInFrames: 6 },
        framesChecked: 6,
      });

      const still = await run(
        [
          "still",
          "plain",
          "--frame",
          "0",
          "--project",
          projectRoot,
          "--out",
          path.join(projectRoot, "still.png"),
          "--json",
        ],
        projectRoot,
      );
      expect(still.code).toBe(0);
      expect(JSON.parse(still.stdout)).toMatchObject({ ok: true, width: 160, height: 90 });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unresolved composition format without a project format", async () => {
    const projectRoot = await createFormatProject({ format: false });
    try {
      const result = await run(["check", "plain", "--project", projectRoot, "--json"], projectRoot);

      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        command: "check",
        error: { code: "COMPOSITION_FORMAT_UNRESOLVED" },
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
