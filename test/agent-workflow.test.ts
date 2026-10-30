import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

const composition = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">{ "title": "Agent workflow" }</script>
  </head>
  <body>
    <fy-composition width="160" height="90" fps="10" duration-in-frames="3">
      <div id="label"></div>
      <canvas id="canvas" width="160" height="90"></canvas>
    </fy-composition>
    <script type="text/fy-controller">
let label;
let context;

export default {
  mount({ root }) {
    label = root.querySelector("#label");
    context = root.querySelector("#canvas").getContext("2d");
  },
  update({ frame, props }) {
    label.textContent = props.title + ":" + frame;
    context.fillStyle = frame % 2 === 0 ? "#101820" : "#203040";
    context.fillRect(0, 0, 160, 90);
  },
};
    </script>
  </body>
</html>
`;

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

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-agent-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { agent: "./compositions/agent.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "agent.html"), composition);
  await writeFile(path.join(root, "props.json"), JSON.stringify({ title: "Preserved source" }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("agent-style workflow", () => {
  it("preserves source, validates, inspects a still, renders, and reports failures", async () => {
    const sourceBefore = {
      config: digest(await readFile(path.join(root, "video.config.js"))),
      composition: digest(await readFile(path.join(root, "compositions", "agent.html"))),
      props: digest(await readFile(path.join(root, "props.json"))),
    };

    const check = await run(["check", "agent", "--props", "props.json", "--json"]);
    expect(check.code, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({
      ok: true,
      command: "check",
      composition: "agent",
      framesChecked: 3,
    });

    const still = await run([
      "still",
      "agent",
      "--frame",
      "1",
      "--props",
      "props.json",
      "--out",
      "agent-1.png",
      "--json",
    ]);
    expect(still.code, still.stderr).toBe(0);
    const stillJson = JSON.parse(still.stdout) as Record<string, unknown>;
    expect(stillJson).toMatchObject({ ok: true, command: "still", frame: 1 });
    expect((await readFile(path.join(root, "agent-1.png"))).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const render = await run(["render", "agent", "--props", "props.json", "--out", "agent.mp4", "--json"]);
    expect(render.code, render.stderr).toBe(0);
    expect(JSON.parse(render.stdout)).toMatchObject({
      ok: true,
      command: "render",
      composition: "agent",
      framesRendered: 3,
    });
    expect((await stat(path.join(root, "agent.mp4"))).size).toBeGreaterThan(1_000);

    const missing = await run(["check", "missing", "--json"]);
    expect(missing.code).not.toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "COMPOSITION_NOT_FOUND" },
    });

    const sourceAfter = {
      config: digest(await readFile(path.join(root, "video.config.js"))),
      composition: digest(await readFile(path.join(root, "compositions", "agent.html"))),
      props: digest(await readFile(path.join(root, "props.json"))),
    };
    expect(sourceAfter).toEqual(sourceBefore);
  });
});
