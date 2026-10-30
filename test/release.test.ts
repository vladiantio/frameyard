import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

describe("release guardrails", () => {
  it("runs the shared check command in CI and release", async () => {
    for (const workflow of WORKFLOWS) {
      expect(await readFile(workflow, "utf8")).toMatch(/^\s+run: pnpm check\s*$/m);
    }
  });

  it("keeps the pre-commit hook on the shared static checks", async () => {
    const hook = await readFile(".githooks/pre-commit", "utf8");
    expect(hook).toContain("pnpm check:static");
    expect(hook).toContain("pnpm test:unit");
  });

  it("checks scripts through the shared script check", async () => {
    for (const file of [...WORKFLOWS, ".githooks/pre-commit"]) {
      expect(await readFile(file, "utf8")).not.toMatch(/node --check scripts\//);
    }
  });

  it("verifies release metadata with the shared script", async () => {
    expect(await readFile(".github/workflows/release.yml", "utf8")).toContain("node scripts/verify-release.mjs --ci");
  });

  it("restores the annotated tag after checkout rewrites it", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain('"+refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"');
  });
});
