import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECIPES, recipeRegistration } from "../src/recipes.ts";
import { runCli } from "./helpers/cli-project.ts";
import { assertFreshDist } from "./helpers/dist.ts";

const projectFormat = { width: 160, height: 90, fps: 10 };
const recipeIds = RECIPES.map((recipe) => recipe.id);
const timelineRecipes = RECIPES.filter((recipe) => recipe.entries.some((entry) => entry.kind === "timeline"));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;
let outDir: string;

beforeAll(async () => {
  await assertFreshDist();
  root = await mkdtemp(path.join(tmpdir(), "frameyard-recipes-"));
  outDir = path.join(root, "out");
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "compositions", "seed.html"),
    `<fy-composition duration-in-frames="10">
  <div style="width: 100%; height: 100%; background: #123456"></div>
</fy-composition>
`,
  );

  const compositions: Record<string, string> = { seed: "./compositions/seed.html" };
  const timelines: Record<string, string> = {};
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default ${JSON.stringify({ format: projectFormat, compositions, timelines }, null, 2)};\n`,
  );

  for (const recipe of RECIPES) {
    const result = await runCli(["add", "recipe", recipe.id, "--id", recipe.id, "--project", root, "--json"], root);
    expect(result.code, result.stderr).toBe(0);

    const registration = recipeRegistration(recipe, recipe.id);
    Object.assign(compositions, registration.compositions ?? {});
    Object.assign(timelines, registration.timelines ?? {});
  }

  await writeFile(
    path.join(root, "fy.config.js"),
    `export default ${JSON.stringify({ format: projectFormat, compositions, timelines }, null, 2)};\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bundled recipes", () => {
  it("lists every recipe in the add manifest", async () => {
    const result = await runCli(["add", "--list", "--json"], root);
    expect(result.code, result.stderr).toBe(0);
    const listing = JSON.parse(result.stdout) as { recipes?: Array<{ id: string }> };
    expect(listing.recipes?.map((recipe) => recipe.id)).toEqual(recipeIds);
  });

  it.concurrent.each(RECIPES)("captures a non-blank still from the $id recipe", async (recipe) => {
    const out = path.join(outDir, `${recipe.id}.png`);
    const result = await runCli(["still", recipe.id, "--frame", "30", "--project", root, "--out", out, "--json"], root);

    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      ok?: boolean;
      command?: string;
      composition?: string;
      frame?: number;
      width?: number;
      height?: number;
      diagnostics?: Array<{ severity: string }>;
    };
    expect(json).toMatchObject({ ok: true, command: "still", composition: recipe.id, frame: 30 });
    expect(json.width).toBe(projectFormat.width);
    expect(json.height).toBe(projectFormat.height);
    expect((json.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const png = await readFile(out);
    expect(png.subarray(0, 8)).toEqual(pngSignature);
    expect((await stat(out)).size).toBeGreaterThan(1024);

    const inspect = await runCli(["inspect", out, "--json"], root);
    expect(inspect.code, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({ ok: true, command: "inspect", blank: false });
  });

  it.concurrent.each(timelineRecipes)("captures a non-blank still from the $id timeline", async (recipe) => {
    const timelineId = `${recipe.id}-timeline`;
    const out = path.join(outDir, `${timelineId}.png`);
    const result = await runCli(
      ["still", timelineId, "--frame", "30", "--project", root, "--out", out, "--json"],
      root,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "still",
      timeline: timelineId,
      frame: 30,
    });

    const inspect = await runCli(["inspect", out, "--json"], root);
    expect(inspect.code, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({ ok: true, command: "inspect", blank: false });
  });
});
