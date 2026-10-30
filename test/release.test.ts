import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];
const repoRoot = path.resolve(".");

type RunResult = { code: number; stdout: string; stderr: string };

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

let fixture: string | undefined;

async function createReleaseFixture(version = "1.2.3"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-release-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "skills", "frameyard"), { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "frameyard", version }, null, 2)}\n`);
  await writeFile(path.join(root, "src", "version.ts"), `export const VERSION = "${version}";\n`);
  await writeFile(path.join(root, "skills", "frameyard", "SKILL.md"), `---\nframeyard-api-version: ${version}\n---\n`);
  await writeFile(
    path.join(root, "CHANGELOG.md"),
    `## [${version}] - 2026-10-30\n\n[${version}]: https://example.com/compare\n`,
  );
  await writeFile(
    path.join(root, "scripts", "set-version.mjs"),
    await readFile(path.join(repoRoot, "scripts", "set-version.mjs")),
  );
  await writeFile(
    path.join(root, "scripts", "verify-release.mjs"),
    await readFile(path.join(repoRoot, "scripts", "verify-release.mjs")),
  );

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "release@example.com"]);
  await git(root, ["config", "user.name", "Release Test"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "tag.gpgsign", "false"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release"]);
  await git(root, ["tag", "-a", `v${version}`, "-m", `frameyard v${version}`]);
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  return root;
}

async function verify(root: string, tag: string): Promise<RunResult> {
  return run(process.execPath, ["scripts/verify-release.mjs", "--ci"], root, {
    GITHUB_REF_NAME: tag,
  });
}

afterEach(async () => {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});

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

  it("restores the annotated tag before verifying it", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const step = workflow.slice(workflow.indexOf("Verify release metadata"));
    const refetch = step.indexOf("refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}");
    const verify = step.indexOf("node scripts/verify-release.mjs --ci");
    expect(refetch).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(-1);
    expect(refetch).toBeLessThan(verify);
  });

  it("wires the retag recovery script into the release docs", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["retag-release"]).toBe("node scripts/retag-release.mjs");
    const releasing = await readFile("RELEASING.md", "utf8");
    expect(releasing).toContain("pnpm retag-release");
    expect(releasing).toContain("Protect release tags");
  });
});

describe("verify-release --ci", () => {
  it("accepts an annotated tag at HEAD reachable from origin/main", async () => {
    fixture = await createReleaseFixture();
    const result = await verify(fixture, "v1.2.3");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("release v1.2.3 verifies");
  });

  it("rejects a lightweight tag", async () => {
    fixture = await createReleaseFixture();
    await git(fixture, ["update-ref", "refs/tags/v1.2.3", "HEAD"]);
    const result = await verify(fixture, "v1.2.3");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not annotated");
  });

  it("rejects a tag that does not match GITHUB_REF_NAME", async () => {
    fixture = await createReleaseFixture();
    const result = await verify(fixture, "v9.9.9");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not match package.json version");
  });
});
