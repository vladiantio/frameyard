import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildProjectContext } from "../src/context.ts";
import { loadProject } from "../src/project.ts";
import { loadResourcePolicy } from "../src/policy.ts";
import { assertFreshDist } from "./helpers/dist.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporaryDirectories: string[] = [];

const animatedComposition = `<script type="application/json" data-fy="props">{
  "title": "Hello",
  "subtitle": "World"
}</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div data-fy-text="title"></div>
</fy-composition>
`;

const staticComposition = `<script type="application/json" data-fy="props">{ "title": "Poster" }</script>
<fy-composition width="160" height="90">
  <div data-fy-text="title"></div>
</fy-composition>
`;

const timelineDocument = {
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
  transitions: [],
};

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-context-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await writeFile(path.join(root, "compositions", "hello.html"), animatedComposition);
  await writeFile(path.join(root, "compositions", "poster.html"), staticComposition);
  await writeFile(path.join(root, "timelines", "main.timeline.json"), JSON.stringify(timelineDocument, null, 2));
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { format: { width: 160, height: 90, fps: 10 }, compositions: { hello: "./compositions/hello.html", poster: "./compositions/poster.html" }, timelines: { main: "./timelines/main.timeline.json" } };\n`,
  );
  await writeFile(
    path.join(root, "frameyard.policy.json"),
    JSON.stringify({ version: 1, policy: "authoring", profile: "shared-cpu" }, null, 2),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeAll(async () => {
  await assertFreshDist();
});

describe("project context", () => {
  it("summarizes compositions, timelines, props, assets, policy, and next commands", async () => {
    const root = await createProject();
    const project = await loadProject(root);
    const policy = await loadResourcePolicy({ cwd: root, env: {} });
    const context = await buildProjectContext({ project, policy });

    expect(context).toMatchObject({
      root,
      format: { width: 160, height: 90, fps: 10 },
      policy: { policy: "authoring", profile: "shared-cpu", maxStillFrames: 4 },
      truncated: { clips: false, assets: false, props: false },
    });

    const hello = context.compositions.find((composition) => composition.id === "hello");
    expect(hello).toMatchObject({
      kind: "animated",
      metadata: { width: 160, height: 90, fps: 10, durationInFrames: 6 },
      props: [
        { path: "subtitle", type: "string" },
        { path: "title", type: "string" },
      ],
    });
    const poster = context.compositions.find((composition) => composition.id === "poster");
    expect(poster).toMatchObject({ kind: "static", metadata: { width: 160, height: 90, static: true } });

    expect(context.timelines).toEqual([
      expect.objectContaining({
        id: "main",
        durationInFrames: 6,
        tracks: 1,
        audio: 0,
        transcripts: 0,
        clips: [
          {
            id: "hello",
            track: "v1",
            kind: "composition",
            source: "hello",
            start: 0,
            duration: 6,
            end: 6,
          },
        ],
      }),
    ]);
    expect(context.next).toContain("npx frameyard lint main --json");
    expect(context.next).toContain("npx frameyard render main --dry-run --json");
  });

  it("exposes the same digest through the CLI", async () => {
    const root = await createProject();
    const { stdout } = await exec(process.execPath, [cli, "context", "--project", root, "--json"], {
      cwd: root,
      env: { ...process.env, FRAMEYARD_POLICY: "authoring" },
    });
    const body = JSON.parse(stdout);
    expect(body).toMatchObject({
      ok: true,
      command: "context",
      policy: { policy: "authoring" },
      timelines: [expect.objectContaining({ id: "main", durationInFrames: 6 })],
    });
  });
});
