import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateHtmlComposition } from "../src/html/validate.ts";
import { parseTimelineDocument } from "../src/timeline/schema.ts";
import { findTemplate, TEMPLATES, templateRegistration } from "../src/templates.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function projectDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-template-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  return root;
}

describe("project templates", () => {
  it("has one unique name per template and resolves by name", () => {
    const names = TEMPLATES.map((template) => template.name);
    expect(new Set(names).size).toBe(names.length);
    for (const template of TEMPLATES) {
      expect(findTemplate(template.name)).toBe(template);
    }
    expect(findTemplate("missing")).toBeUndefined();
  });

  it.each(TEMPLATES.filter((template) => template.kind === "composition"))(
    "writes a valid $name composition",
    async (template) => {
      const root = await projectDirectory();
      const entry = template.entry("sample");
      await writeFile(path.join(root, entry), template.content);
      const validation = await validateHtmlComposition({
        projectRoot: root,
        entry,
        format: { width: 160, height: 90, fps: 10 },
      });

      expect(validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      expect(validation.formatUnresolved).toBe(false);
      const metadata = validation.info?.metadata;
      expect(metadata).toBeDefined();
      if (template.name === "static-poster") {
        expect(metadata?.static).toBe(true);
      } else {
        expect(metadata?.static).not.toBe(true);
        if (metadata !== undefined && metadata.static !== true) {
          expect(metadata.durationInFrames).toBeGreaterThan(0);
        }
      }
    },
  );

  it("writes a valid slideshow timeline", () => {
    const template = findTemplate("slideshow");
    expect(template).toBeDefined();
    if (template === undefined) {
      throw new Error("slideshow template missing");
    }
    const parsed = parseTimelineDocument(JSON.parse(template.content) as unknown);
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(parsed.timeline).toMatchObject({
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
    });
    expect(parsed.timeline?.clips).toHaveLength(3);
  });

  it("reports the exact registration snippet for each kind", () => {
    const composition = findTemplate("lower-third");
    const timeline = findTemplate("slideshow");
    expect(composition).toBeDefined();
    expect(timeline).toBeDefined();
    if (composition === undefined || timeline === undefined) {
      throw new Error("templates missing");
    }

    expect(templateRegistration(composition, "intro")).toEqual({
      compositions: { intro: "./compositions/intro.html" },
      timelines: undefined,
    });
    expect(templateRegistration(timeline, "reel")).toEqual({
      compositions: undefined,
      timelines: { reel: "./timelines/reel.timeline.json" },
    });
  });
});
