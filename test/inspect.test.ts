import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeRgba, compareRgba } from "../src/inspect.ts";
import { assertFreshDist } from "./helpers/dist.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
let directory: string;

beforeAll(async () => {
  await assertFreshDist();
  directory = await mkdtemp(path.join(tmpdir(), "frameyard-inspect-"));
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=4x4",
    "-frames:v",
    "1",
    path.join(directory, "red.png"),
    "-y",
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=4x4",
    "-frames:v",
    "1",
    path.join(directory, "blue.png"),
    "-y",
  ]);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("image analysis", () => {
  it("detects a solid image as blank and a changed pixel as content", () => {
    const solid = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
    expect(analyzeRgba(solid, 2, 2)).toMatchObject({
      blank: true,
      content: { pixels: 0, bbox: null },
      colors: [{ hex: "#ff0000", share: 1 }],
    });

    const marked = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
    expect(analyzeRgba(marked, 2, 2)).toMatchObject({
      blank: false,
      content: { pixels: 1, bbox: { x: 1, y: 1, width: 1, height: 1 } },
    });
  });

  it("reports alpha coverage and content for transparent images", () => {
    const transparent = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(analyzeRgba(transparent, 2, 2)).toMatchObject({
      alpha: { min: 0, max: 255, coverage: 0.25 },
      blank: false,
      content: { pixels: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } },
    });
  });

  it("compares pixels, bounding boxes, and regions", () => {
    const first = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    expect(compareRgba(first, first, 2, 2)).toMatchObject({
      identical: true,
      differingPixels: 0,
      bbox: null,
    });

    const second = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    expect(compareRgba(first, second, 2, 2)).toMatchObject({
      identical: false,
      differingPixels: 1,
      percent: 25,
      maxChannelDelta: 255,
      bbox: { x: 1, y: 1, width: 1, height: 1 },
    });
  });
});

describe("inspect and compare CLI", () => {
  it("inspects a still as text facts", async () => {
    const result = await run(["inspect", "red.png", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "inspect",
      width: 4,
      height: 4,
      blank: true,
      alpha: { coverage: 1 },
    });
  });

  it("compares identical and different images", async () => {
    const identical = await run(["compare", "red.png", "red.png", "--json"]);
    expect(identical.code).toBe(0);
    expect(JSON.parse(identical.stdout)).toMatchObject({ ok: true, identical: true, differingPixels: 0 });

    const different = await run(["compare", "red.png", "blue.png", "--json"]);
    expect(different.code).toBe(1);
    expect(JSON.parse(different.stdout)).toMatchObject({
      ok: true,
      command: "compare",
      identical: false,
      differingPixels: 16,
      percent: 100,
    });
  });
});
