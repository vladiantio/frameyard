import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const REPO_CLI = /^node\s+(?:\.\.?\/)?dist\/cli\.js\s/;
const USER_CLI = /^(?:npx\s+)?frameyard\b/;

const examples = [
  { project: "demo", id: "demo", frame: 240 },
  { project: "webgl", id: "webgl", frame: 210 },
  { project: "video", id: "video", frame: 210 },
  { project: "video", id: "video-mp4", frame: 210 },
  { project: "video", id: "video-timeline", frame: 210, timeline: true },
  { project: "video", id: "video-timeline-mp4", frame: 210, timeline: true },
];

let temp: string;

function shellBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let block: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (block === null) {
      if (/^\s*```(?:sh|bash)\s*$/.test(line)) {
        block = [];
      }
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      blocks.push(block);
      block = null;
    } else {
      block.push(line.trim());
    }
  }
  return blocks;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "frameyard-examples-"));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("bundled examples", () => {
  it("uses repository CLI commands in example READMEs", async () => {
    const entries = await readdir("examples", { withFileTypes: true });
    const readmes = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("examples", entry.name, "README.md"));

    expect(readmes.length).toBeGreaterThan(0);

    for (const file of readmes) {
      const commands = shellBlocks(await readFile(file, "utf8"))
        .flat()
        .filter((line) => line.length > 0);
      expect(
        commands.some((line) => REPO_CLI.test(line)),
        `${file} should use node dist/cli.js`,
      ).toBe(true);
      for (const command of commands) {
        expect(command, `${file}: ${command}`).not.toMatch(USER_CLI);
      }
    }
  });

  it.each(examples)("captures a still from the $id example", async ({ project, id, frame, timeline }) => {
    const out = path.join(temp, `${id}.png`);
    const result = await run([
      "still",
      id,
      "--frame",
      String(frame),
      "--project",
      path.resolve("examples", project),
      "--out",
      out,
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      ok?: boolean;
      command?: string;
      composition?: string;
      timeline?: string;
      frame?: number;
      width?: number;
      height?: number;
      diagnostics?: Array<{ severity: string }>;
    };
    expect(json).toMatchObject({
      ok: true,
      command: "still",
      ...(timeline === true ? { timeline: id } : { composition: id }),
      frame,
    });
    expect(json.width).toBeGreaterThan(0);
    expect(json.height).toBeGreaterThan(0);
    expect((json.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const png = await readFile(out);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect((await stat(out)).size).toBeGreaterThan(1024);
  });
});
