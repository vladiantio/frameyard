import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateHtmlComposition } from "../src/html/validate.ts";
import { parseTimelineDocument } from "../src/timeline/schema.ts";
import { findRecipe, listRecipes, recipeInstallPlan, recipeRegistration, RECIPES } from "../src/recipes.ts";
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

describe("project recipes", () => {
  it("has one unique id per recipe and resolves by id", () => {
    const ids = RECIPES.map((recipe) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const recipe of RECIPES) {
      expect(findRecipe(recipe.id)).toBe(recipe);
    }
    expect(findRecipe("missing")).toBeUndefined();
    expect(listRecipes()).toEqual([...RECIPES]);
  });

  it.each(RECIPES)("installs a valid $id recipe", async (recipe) => {
    const root = await projectDirectory();
    const plan = recipeInstallPlan(recipe, "hero");
    const paths = plan.files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.some((file) => file.includes("{id}"))).toBe(false);

    for (const file of plan.files) {
      expect(file.content.length).toBeGreaterThan(0);
      const target = path.join(root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }

    const entryIds = plan.entries.map((entry) => entry.id);
    expect(new Set(entryIds).size).toBe(entryIds.length);

    for (const entry of plan.entries) {
      expect(paths).toContain(entry.entry);
      const content = plan.files.find((file) => file.path === entry.entry)?.content;
      expect(content).toBeDefined();
      if (content === undefined) {
        throw new Error(`Recipe ${recipe.id} entry ${entry.entry} has no file`);
      }

      if (entry.kind === "composition") {
        const validation = await validateHtmlComposition({
          projectRoot: root,
          entry: entry.entry,
          format: { width: 160, height: 90, fps: 10 },
        });
        expect(validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
        expect(validation.formatUnresolved).toBe(false);
      } else {
        const parsed = parseTimelineDocument(JSON.parse(content) as unknown);
        expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      }
    }
  });

  it("reports the exact registration snippet for a recipe bundle", () => {
    const recipe = findRecipe("lower-third");
    expect(recipe).toBeDefined();
    if (recipe === undefined) {
      throw new Error("lower-third recipe missing");
    }

    expect(recipeRegistration(recipe, "hero")).toEqual({
      compositions: { hero: "./compositions/hero.html" },
      timelines: { "hero-timeline": "./timelines/hero-timeline.timeline.json" },
    });
  });
});
