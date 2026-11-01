import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";

const roots: string[] = [];

async function project(config: string, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-config-"));
  roots.push(root);
  await writeFile(path.join(root, "video.config.js"), config);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("timeline project configuration", () => {
  it("loads a project format and explicit timeline entries", async () => {
    const root = await project(
      `export default {
        format: { width: 1920, height: 1080, fps: 30 },
        compositions: { intro: "./compositions/intro.html" },
        timelines: { main: "./timelines/main.json" },
      };\n`,
      {
        "compositions/intro.html": "<!doctype html><html></html>",
        "timelines/main.json": '{"version":1,"tracks":[],"clips":[]}',
      },
    );

    const loaded = await loadProject(root);

    expect(loaded.format).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(loaded.compositions.get("intro")).toEqual({
      id: "intro",
      entry: "compositions/intro.html",
      absoluteEntry: path.join(root, "compositions/intro.html"),
      kind: "html",
    });
    expect(loaded.timelines.get("main")).toEqual({
      id: "main",
      entry: "timelines/main.json",
      absoluteEntry: path.join(root, "timelines/main.json"),
      kind: "timeline",
    });
  });

  it("allows a timeline-only project", async () => {
    const root = await project(
      `export default {
        format: { width: 1280, height: 720, fps: 24 },
        timelines: { main: "./main.json" },
      };\n`,
      { "main.json": '{"version":1,"tracks":[],"clips":[]}' },
    );

    const loaded = await loadProject(root);

    expect(loaded.compositions.size).toBe(0);
    expect(loaded.timelines.has("main")).toBe(true);
  });

  it("keeps composition-only projects valid without a format", async () => {
    const root = await project(`export default { compositions: { demo: "./demo.html" } };\n`, {
      "demo.html": "<!doctype html><html></html>",
    });

    const loaded = await loadProject(root);

    expect(loaded.format).toBeUndefined();
    expect(loaded.timelines.size).toBe(0);
  });

  it("requires a format when timelines are listed", async () => {
    const root = await project(`export default { timelines: { main: "./main.json" } };\n`, { "main.json": "{}" });

    await expect(loadProject(root)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects a timeline entry that is not JSON", async () => {
    const root = await project(
      `export default {
        format: { width: 1280, height: 720, fps: 30 },
        timelines: { main: "./main.txt" },
      };\n`,
      { "main.txt": "{}" },
    );

    await expect(loadProject(root)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects missing timeline files", async () => {
    const root = await project(
      `export default {
        format: { width: 1280, height: 720, fps: 30 },
        timelines: { main: "./missing.json" },
      };\n`,
    );

    await expect(loadProject(root)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects duplicate composition and timeline IDs", async () => {
    const root = await project(
      `export default {
        format: { width: 1280, height: 720, fps: 30 },
        compositions: { main: "./main.html" },
        timelines: { main: "./main.json" },
      };\n`,
      { "main.html": "<!doctype html><html></html>", "main.json": "{}" },
    );

    await expect(loadProject(root)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it.each([
    `{ width: 0, height: 720, fps: 30 }`,
    `{ width: 1280, height: 0, fps: 30 }`,
    `{ width: 1280, height: 720, fps: 0 }`,
    `{ width: 1280, height: 720, fps: "30" }`,
  ])("rejects an invalid project format %s", async (format) => {
    const root = await project(
      `export default {
        format: ${format},
        timelines: { main: "./main.json" },
      };\n`,
      { "main.json": "{}" },
    );

    await expect(loadProject(root)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
