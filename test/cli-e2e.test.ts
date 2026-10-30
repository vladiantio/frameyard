import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

const composition = String.raw`
import { defineComposition } from "frameyard";
import { random } from "frameyard/runtime";

let box;
let label;
let context;

export default defineComposition({
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 6,
  defaultProps: { label: "Hello" },
  validateProps(props) {
    return typeof props.label === "string" ? [] : ["label must be a string"];
  },
  audio: [
    { src: "assets/tone.wav", startFrame: 1, trimDuration: 0.4, volume: 0.4 },
  ],
  mount({ container, props }) {
    container.innerHTML =
      '<style>' +
      '@keyframes move { from { transform: translateX(0px); } to { transform: translateX(40px); } }' +
      '#box { width: 20px; height: 20px; background: #ff5500; animation: move 0.6s linear infinite; }' +
      '#label { color: white; font: 12px monospace; }' +
      '</style>' +
      '<div id="box" data-frame="-1"></div>' +
      '<div id="label"></div>' +
      '<canvas id="canvas" width="160" height="90"></canvas>';
    box = container.querySelector("#box");
    label = container.querySelector("#label");
    context = container.querySelector("#canvas").getContext("2d");
  },
  update({ frame, props }) {
    box.dataset.frame = String(frame);
    box.dataset.random = random("frame:" + frame).toFixed(12);
    label.textContent = props.label + " " + frame;
    context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
    context.fillRect(0, 0, 160, 90);
  },
  dispose() {},
});
`;

const mediaComposition = String.raw`
import { defineComposition } from "frameyard";

let video;
let gl;

export default defineComposition({
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 12,
  defaultProps: { declaredTone: true },
  audio: ({ props }) => (props.declaredTone ? [{ src: "assets/tone.wav", startFrame: 0, volume: 0.25 }] : []),
  mount({ container }) {
    container.innerHTML =
      '<style>video,canvas{position:absolute;top:0;width:80px;height:90px}video{left:0}canvas{left:80px}</style>' +
      '<video id="clip" src="assets/clip.webm" data-frameyard-start="2" data-frameyard-trim="0.1" data-frameyard-duration="0.6" data-frameyard-volume="0.5"></video>' +
      '<canvas id="gl" width="80" height="90"></canvas>';
    video = container.querySelector("#clip");
    const canvas = container.querySelector("#gl");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  },
  update({ frame }) {
    const red = frame >= 6;
    gl.clearColor(red ? 1 : 0, 0, red ? 0 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    video.dataset.frame = String(frame);
  },
});
`;

const webglComposition = String.raw`
let gl;

export default {
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 6,
  mount({ container }) {
    container.innerHTML = '<canvas id="gl" width="160" height="90"></canvas>';
    const canvas = container.querySelector("#gl");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  },
  update({ frame }) {
    const blue = frame < 3;
    gl.clearColor(blue ? 0 : 1, 0, blue ? 1 : 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  },
};
`;

const missingVideoComposition = String.raw`
export default {
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 2,
  mount({ container }) {
    container.innerHTML = '<video src="assets/missing.webm"></video>';
  },
  update() {},
};
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

async function run(args: string[], cwd = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
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
    "format=duration:stream=codec_type,codec_name,width,height,channels,nb_read_frames,r_frame_rate",
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
  root = await mkdtemp(path.join(tmpdir(), "frameyard-cli-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { demo: "./compositions/demo.js", media: "./compositions/media.js", webgl: "./compositions/webgl.js", "missing-video": "./compositions/missing-video.js", broken: "./compositions/broken.js", throwing: "./compositions/throwing.js" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "demo.js"), composition);
  await writeFile(path.join(root, "compositions", "media.js"), mediaComposition);
  await writeFile(path.join(root, "compositions", "webgl.js"), webglComposition);
  await writeFile(path.join(root, "compositions", "missing-video.js"), missingVideoComposition);
  await writeFile(
    path.join(root, "compositions", "broken.js"),
    `export default {
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 2,
  audio: [{ src: "assets/missing.wav", startFrame: 0 }],
  mount() {},
  update() {},
};
`,
  );
  await writeFile(
    path.join(root, "compositions", "throwing.js"),
    `export default {
  width: 160,
  height: 90,
  fps: 10,
  durationInFrames: 6,
  mount() {},
  update({ frame }) {
    if (frame === 3) throw new Error("frame boom");
  },
};
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
    expect(json.audio).toMatchObject({ clips: 1, warnings: [] });
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
      error: { code: "ASSET_NOT_FOUND" },
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
      error: { code: "ASSET_NOT_FOUND" },
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

  it("checks and renders embedded video audio with the declared timeline", async () => {
    const check = await run(["check", "media", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({ ok: true, command: "check", composition: "media", framesChecked: 12 });
    const audio = checked.audio as { clips: number; warnings: string[]; details: Array<Record<string, unknown>> };
    expect(audio.clips).toBe(2);
    expect(audio.warnings).toEqual([]);
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
    expect(rendered.audio).toMatchObject({ clips: 2, warnings: [] });

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
    expect(embeddedJson.audio).toMatchObject({ clips: 1, warnings: [] });
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
    expect(json.files).toContain("AGENTS.md");
    expect(json.files).toContain("package.json");
    expect(json.next).toEqual([
      "npx frameyard doctor",
      "npx frameyard dev",
      "npx frameyard check hello",
      "npx frameyard render hello --out hello.mp4",
    ]);
    expect((await stat(path.join(target, "video.config.js"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "compositions", "hello.js"))).isFile()).toBe(true);

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
    expect(agents).toContain("update({ frame, props })");
    expect(agents).toContain('random("stable:key")');
    expect(agents).toContain("qwen-tts");
    expect(agents).toContain("whisper-cli");
    expect(agents).toContain("frameyard.assets.json");
    expect(agents).toContain("npx frameyard@");
    expect(agents).toContain("npx skills add vladiantio/frameyard");
    for (const command of [
      "npx frameyard doctor --json",
      "npx frameyard check hello --json",
      "npx frameyard still hello --frame 42 --out hello-42.png --json",
      "npx frameyard render hello --props props/hello.json --out hello.mp4 --json",
    ]) {
      expect(agents).toContain(command);
    }

    const readme = await readFile(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("AGENTS.md");
    for (const command of [
      "npx frameyard dev",
      "npx frameyard doctor",
      "npx frameyard check hello",
      "npx frameyard render hello --props props/hello.json --out hello.mp4",
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
