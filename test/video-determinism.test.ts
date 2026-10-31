import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

/**
 * A full-scene opacity animation can leave Chromium showing the video frame
 * painted during load. The stable twin has the same video and transform but no
 * scene animation, so the fade capture must resolve to exactly the same frame.
 */
function composition(withFade: boolean): string {
  const sceneStyle = withFade ? "        animation: fade-in 1s linear both;\n" : "";
  const sceneAttrs = withFade ? ' data-fy-anim-start="0" data-fy-anim-duration="30"' : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @keyframes fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      html,
      body,
      fy-composition {
        margin: 0;
        background: #000;
      }
      #scene {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        isolation: isolate;
${sceneStyle}      }
      #hero {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scale(calc(1 + var(--fy-progress) * 0.035));
        transform-origin: center;
      }
    </style>
  </head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="360">
      <div id="scene"${sceneAttrs}>
        <video id="hero" src="assets/moving.webm" data-fy-audio="off"></video>
      </div>
    </fy-composition>
  </body>
</html>
`;
}

function mappingComposition(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body,
      fy-composition {
        margin: 0;
        background: #000;
      }
      #scene {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      #hero {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    </style>
  </head>
  <body>
    <fy-composition width="960" height="540" fps="30" duration-in-frames="360">
      <div id="scene">
        <video id="hero" src="assets/code.webm" data-fy-audio="off"></video>
      </div>
    </fy-composition>
  </body>
</html>
`;
}

function fillRect(
  buffer: Buffer,
  frameOffset: number,
  width: number,
  x0: number,
  y0: number,
  rectWidth: number,
  rectHeight: number,
  value: number,
): void {
  for (let y = y0; y < y0 + rectHeight; y += 1) {
    for (let x = x0; x < x0 + rectWidth; x += 1) {
      const offset = frameOffset + (y * width + x) * 3;
      buffer[offset] = value;
      buffer[offset + 1] = value;
      buffer[offset + 2] = value;
    }
  }
}

/**
 * Frames carry a 3x3 black/white code in a clear right-middle region. Decoding
 * the code from a capture tells us which source frame the browser selected.
 */
function codeClip(): Buffer {
  const width = 160;
  const height = 90;
  const frames = 360;
  const buffer = Buffer.alloc(width * height * 3 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * width * height * 3;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = 30 + ((x * 3 + y * 2 + frame * 5) % 60);
        const offset = frameOffset + (y * width + x) * 3;
        buffer[offset] = value;
        buffer[offset + 1] = value;
        buffer[offset + 2] = value;
      }
    }
    fillRect(buffer, frameOffset, width, 110, 20, 40, 30, 0);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (((frame >> (row * 3 + column)) & 1) === 1) {
          fillRect(buffer, frameOffset, width, 110 + column * 15, 20 + row * 12, 10, 6, 255);
        }
      }
    }
  }
  return buffer;
}

const CODE_CENTERS = [
  [690, 138],
  [780, 138],
  [870, 138],
  [690, 210],
  [780, 210],
  [870, 210],
  [690, 282],
  [780, 282],
  [870, 282],
] as const;

function readRgb(file: string, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: width * height * 3 + 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function decodeCode(rgb: Buffer, width: number): number {
  let code = 0;
  for (let index = 0; index < CODE_CENTERS.length; index += 1) {
    const [centerX, centerY] = CODE_CENTERS[index] as readonly [number, number];
    let total = 0;
    let count = 0;
    for (let y = centerY - 5; y <= centerY + 5; y += 1) {
      for (let x = centerX - 5; x <= centerX + 5; x += 1) {
        const offset = (y * width + x) * 3;
        total += (rgb.readUInt8(offset) + rgb.readUInt8(offset + 1) + rgb.readUInt8(offset + 2)) / 3;
        count += 1;
      }
    }
    if (total / count > 128) {
      code |= 1 << index;
    }
  }
  return code;
}

let root: string;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function still(id: string, frame: number, out: string): Promise<string> {
  const result = await run([
    "still",
    id,
    "--frame",
    String(frame),
    "--project",
    root,
    "--out",
    path.join(root, out),
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  const json = JSON.parse(result.stdout) as { ok?: boolean; command?: string; frame?: number };
  expect(json).toMatchObject({ ok: true, command: "still", frame });
  const png = await readFile(path.join(root, out));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return createHash("sha256").update(png).digest("hex");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-video-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { fade: "./compositions/fade.html", stable: "./compositions/stable.html", mapping: "./compositions/mapping.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "fade.html"), composition(true));
  await writeFile(path.join(root, "compositions", "stable.html"), composition(false));
  await writeFile(path.join(root, "compositions", "mapping.html"), mappingComposition());
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=12",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "200k",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "assets", "moving.webm"),
  ]);

  const rawPath = path.join(root, "assets", "code.raw");
  await writeFile(rawPath, codeClip());
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    "160x90",
    "-r",
    "30",
    "-i",
    rawPath,
    "-c:v",
    "libvpx-vp9",
    "-lossless",
    "1",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "assets", "code.webm"),
  ]);
  await rm(rawPath, { force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("embedded video capture", () => {
  it("captures the requested frame, not the frame painted during load", async () => {
    const fadeFirst = await still("fade", 355, "fade-a.png");
    const fadeSecond = await still("fade", 355, "fade-b.png");
    const stableLast = await still("stable", 355, "stable-355.png");
    const stableFirst = await still("stable", 0, "stable-0.png");

    expect(fadeFirst).toBe(fadeSecond);
    expect(fadeFirst).toBe(stableLast);
    expect(stableFirst).not.toBe(stableLast);
  });

  it("maps consecutive composition frames to consecutive source frames", async () => {
    for (let frame = 0; frame < 6; frame += 1) {
      const out = `mapping-${frame}.png`;
      await still("mapping", frame, out);
      const rgb = await readRgb(path.join(root, out), 960, 540);
      expect(decodeCode(rgb, 960), `mount frame ${frame} to source frame ${frame}`).toBe(frame);
    }
  });
});
