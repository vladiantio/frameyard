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

function releaseChangelog(version: string): string {
  return `## [${version}] - 2026-10-30\n\n[${version}]: https://example.com/compare\n`;
}

async function createReleaseFixture(version = "1.2.3", changelog = releaseChangelog(version)): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-release-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "skills", "frameyard"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "frameyard", version, files: ["dist"], bin: { frameyard: "./dist/cli.js" } }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "src", "version.ts"), `export const VERSION = "${version}";\n`);
  await writeFile(path.join(root, "skills", "frameyard", "SKILL.md"), `---\nframeyard-api-version: ${version}\n---\n`);
  await writeFile(path.join(root, "CHANGELOG.md"), changelog);
  await writeFile(path.join(root, "LICENSE"), "MIT\n");
  await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");

  for (const script of [
    "set-version.mjs",
    "verify-release.mjs",
    "check-changelog.mjs",
    "verify-package.mjs",
    "check-stamp.mjs",
  ]) {
    await writeFile(path.join(root, "scripts", script), await readFile(path.join(repoRoot, "scripts", script)));
  }

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

async function verifyStamp(root: string, tag?: string): Promise<RunResult> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  const refs = [`${head} ${head} refs/heads/main ${head}`];
  if (tag) {
    const tagSha = await git(root, ["rev-parse", tag]);
    refs.push(`${tagSha} ${tagSha} refs/tags/${tag} ${tagSha}`);
  }
  return run("sh", ["-c", `node scripts/check-stamp.mjs verify <<'EOF'\n${refs.join("\n")}\nEOF`], root);
}

async function commitFile(root: string, file: string, content: string, message: string, body?: string): Promise<void> {
  await writeFile(path.join(root, file), content);
  await git(root, ["add", file]);
  const args = ["commit", "-m", message];
  if (body) args.push("-m", body);
  await git(root, args);
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

  it("pins the CI and release runners", async () => {
    for (const workflow of WORKFLOWS) {
      const runners = (await readFile(workflow, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("runs-on:"));
      expect(runners.length).toBeGreaterThan(0);
      expect(runners.every((line) => line === "runs-on: ubuntu-24.04")).toBe(true);
    }
  });

  it("checks changelog coverage in CI", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("node scripts/check-changelog.mjs");
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("warns when a user-facing commit does not stage the changelog", async () => {
    const hook = await readFile(".githooks/commit-msg", "utf8");
    expect(hook).toContain("CHANGELOG.md");
    expect(hook).toContain("Changelog: skip");
    expect(hook).toContain("examples/");
  });

  it("reuses a passing check on push", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.check).toContain("node scripts/check-stamp.mjs record");
    const hook = await readFile(".githooks/pre-push", "utf8");
    expect(hook).toContain("node scripts/check-stamp.mjs verify");
    expect(hook).toContain("pnpm test");
  });

  it("wires the package verifier into the release workflow", async () => {
    expect(await readFile(".github/workflows/release.yml", "utf8")).toContain("node scripts/verify-package.mjs");
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

  it("rejects a tag while [Unreleased] has entries", async () => {
    fixture = await createReleaseFixture(
      "1.2.3",
      `## [Unreleased]\n\n### Added\n\n- pending\n\n## [1.2.3] - 2026-10-30\n\n[1.2.3]: https://example.com/compare\n`,
    );
    const result = await verify(fixture, "v1.2.3");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("still has entries under [Unreleased]");
  });

  it("accepts an empty [Unreleased] section", async () => {
    fixture = await createReleaseFixture(
      "1.2.3",
      `## [Unreleased]\n\n### Added\n\n## [1.2.3] - 2026-10-30\n\n[1.2.3]: https://example.com/compare\n`,
    );
    const result = await verify(fixture, "v1.2.3");
    expect(result.code, result.stderr).toBe(0);
  });

  it("verifies the package for a local release", async () => {
    fixture = await createReleaseFixture();
    const result = await run(process.execPath, ["scripts/verify-release.mjs"], fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("complete package");
  });

  it("rejects a package missing a required path", async () => {
    fixture = await createReleaseFixture();
    await rm(path.join(fixture, "dist", "cli.js"));
    const result = await run(process.execPath, ["scripts/verify-package.mjs"], fixture);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("package is missing");
  });
});

describe("check-changelog", () => {
  it("rejects a user-facing commit that does not update CHANGELOG.md", async () => {
    fixture = await createReleaseFixture();
    await commitFile(fixture, "feature.txt", "feature\n", "feat(core): add feature");
    const result = await run(
      process.execPath,
      ["scripts/check-changelog.mjs", "--previous", "v1.2.3", "--to", "HEAD"],
      fixture,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("feat(core): add feature");
  });

  it("accepts a user-facing commit that updates CHANGELOG.md", async () => {
    fixture = await createReleaseFixture();
    const changelog = `${await readFile(path.join(fixture, "CHANGELOG.md"), "utf8")}- feature\n`;
    await writeFile(path.join(fixture, "feature.txt"), "feature\n");
    await writeFile(path.join(fixture, "CHANGELOG.md"), changelog);
    await git(fixture, ["add", "feature.txt", "CHANGELOG.md"]);
    await git(fixture, ["commit", "-m", "feat(core): add feature"]);
    const result = await run(
      process.execPath,
      ["scripts/check-changelog.mjs", "--previous", "v1.2.3", "--to", "HEAD"],
      fixture,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it("accepts Changelog: skip in the commit body", async () => {
    fixture = await createReleaseFixture();
    await commitFile(fixture, "feature.txt", "feature\n", "feat(core): add feature", "Changelog: skip");
    const result = await run(
      process.execPath,
      ["scripts/check-changelog.mjs", "--previous", "v1.2.3", "--to", "HEAD"],
      fixture,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it("ignores example-only commits", async () => {
    fixture = await createReleaseFixture();
    await mkdir(path.join(fixture, "examples", "demo"), { recursive: true });
    await commitFile(fixture, "examples/demo/example.txt", "example\n", "feat(examples): add example");
    const result = await run(
      process.execPath,
      ["scripts/check-changelog.mjs", "--previous", "v1.2.3", "--to", "HEAD"],
      fixture,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it("ignores non-user-facing commits", async () => {
    fixture = await createReleaseFixture();
    await commitFile(fixture, "docs.txt", "docs\n", "docs: add note");
    const result = await run(
      process.execPath,
      ["scripts/check-changelog.mjs", "--previous", "v1.2.3", "--to", "HEAD"],
      fixture,
    );
    expect(result.code, result.stderr).toBe(0);
  });
});

describe("check-stamp", () => {
  it("reuses a check for the same tree after a commit", async () => {
    fixture = await createReleaseFixture();
    const changelog = `${await readFile(path.join(fixture, "CHANGELOG.md"), "utf8")}- pending\n`;
    await writeFile(path.join(fixture, "CHANGELOG.md"), changelog);
    const record = await run(process.execPath, ["scripts/check-stamp.mjs", "record"], fixture);
    expect(record.code, record.stderr).toBe(0);
    expect(record.stdout).toContain("recorded a passing check");

    await git(fixture, ["add", "CHANGELOG.md"]);
    await git(fixture, ["commit", "-m", "docs: update changelog"]);
    await git(fixture, ["tag", "-a", "v1.2.4", "-m", "frameyard v1.2.4"]);
    const result = await verifyStamp(fixture, "v1.2.4");
    expect(result.code, result.stderr).toBe(0);
  });

  it("refuses the stamp when the tree changed", async () => {
    fixture = await createReleaseFixture();
    const changelog = `${await readFile(path.join(fixture, "CHANGELOG.md"), "utf8")}- pending\n`;
    await writeFile(path.join(fixture, "CHANGELOG.md"), changelog);
    const record = await run(process.execPath, ["scripts/check-stamp.mjs", "record"], fixture);
    expect(record.code, record.stderr).toBe(0);
    await git(fixture, ["add", "CHANGELOG.md"]);
    await git(fixture, ["commit", "-m", "docs: update changelog"]);

    await writeFile(path.join(fixture, "CHANGELOG.md"), `${changelog}- more\n`);
    const result = await verifyStamp(fixture);
    expect(result.code).not.toBe(0);
  });
});
