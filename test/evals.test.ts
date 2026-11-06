import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateHtmlComposition } from "../src/html/validate.ts";
import { parseTimelineDocument } from "../src/timeline/schema.ts";
import { TASKS } from "../evals/tasks.mjs";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-evals-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local model eval tasks", () => {
  it("defines eight unique tasks with explicit seeds and targets", () => {
    expect(TASKS).toHaveLength(8);
    expect(new Set(TASKS.map((task) => task.name)).size).toBe(TASKS.length);
    for (const task of TASKS) {
      expect(task.brief.length, `${task.name} brief`).toBeGreaterThan(0);
      expect(task.target.length, `${task.name} target`).toBeGreaterThan(0);
      expect(task.files["fy.config.js"], `${task.name} config`).toContain("format:");
      expect(task.expect?.stillFrame, `${task.name} still frame`).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(TASKS)("validates every composition seed in $name", async (task) => {
    for (const [file, content] of Object.entries(task.files)) {
      if (!file.endsWith(".html")) {
        continue;
      }
      const entry = path.join("compositions", path.basename(file));
      await writeFile(path.join(root, entry), content);
      const validation = await validateHtmlComposition({
        projectRoot: root,
        entry,
        format: { width: 320, height: 180, fps: 10 },
      });
      expect(
        validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        `${task.name}/${file}`,
      ).toEqual([]);
      expect(validation.formatUnresolved, `${task.name}/${file} format`).toBe(false);
      expect(validation.info, `${task.name}/${file} info`).not.toBeNull();
    }
  });

  it.each(TASKS)("validates every timeline seed in $name", (task) => {
    for (const [file, content] of Object.entries(task.files)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const parsed = parseTimelineDocument(JSON.parse(content));
      expect(
        parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        `${task.name}/${file}`,
      ).toEqual([]);
    }
  });
});
