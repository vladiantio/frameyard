import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

// Containers the `skills` CLI scans directly. Outside these it falls back to a
// recursive search, which only resolves while the repository has one skill.
const STANDARD_SKILL_CONTAINERS = [["skills"], [".agents", "skills"], [".claude", "skills"]];

async function findSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(fullPath)));
    } else if (entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }
  return files;
}

function frontmatterName(skill: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";
  return /^name:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter)?.[1];
}

function isStandardSkillContainer(segments: string[]): boolean {
  return STANDARD_SKILL_CONTAINERS.some(
    (container) =>
      segments.length > container.length && container.every((segment, index) => segments[index] === segment),
  );
}

describe("official agent skill", () => {
  it("lives in a standard container that skill installers discover", async () => {
    const root = path.resolve(".");
    const skillFiles = await findSkillFiles(root);

    expect(skillFiles, "one skill directory keeps `npx skills add` unambiguous").toHaveLength(1);
    const skillFile = skillFiles[0];
    if (skillFile === undefined) throw new Error("no SKILL.md found");
    const skillDirectory = path.dirname(skillFile);
    const segments = path.relative(root, skillDirectory).split(path.sep);

    expect(
      isStandardSkillContainer(segments),
      `${segments.join("/")} must live under skills/, .agents/skills/, or .claude/skills/ so installers find it directly`,
    ).toBe(true);
    expect(frontmatterName(await readFile(skillFile, "utf8"))).toBe(path.basename(skillDirectory));

    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files: string[] };
    const relativeDirectory = segments.join("/");
    const shipped = packageJson.files.some(
      (entry) => entry === relativeDirectory || relativeDirectory.startsWith(`${entry}/`),
    );
    expect(shipped, `package.json files must ship ${relativeDirectory}`).toBe(true);
  });

  it("is included in the published package and versioned with the API", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
      files: string[];
    };
    const skill = await readFile("skills/frameyard/SKILL.md", "utf8");

    expect(packageJson.files).toContain("skills");
    expect(skill).toContain(`frameyard-api-version: ${packageJson.version}`);
    expect(skill).toContain("references/deterministic-authoring.md");
    expect(skill).toContain("references/audio-assets.md");
    expect(skill).toContain("references/subtitles-karaoke.md");
    expect(skill).toContain("references/json-results.md");
    expect(skill).toContain("references/failure-recovery.md");
  });

  it("uses Frameyard wrappers rather than upstream inference executables", async () => {
    const skill = await readFile("skills/frameyard/SKILL.md", "utf8");
    const audio = await readFile("skills/frameyard/references/audio-assets.md", "utf8");
    const subtitles = await readFile("skills/frameyard/references/subtitles-karaoke.md", "utf8");

    for (const command of ["check", "still", "render", "tts", "transcribe", "doctor"]) {
      expect(skill).toContain(`frameyard ${command}`);
    }
    expect(audio).toContain("FRAMEYARD_QWEN_TTS");
    expect(audio).toContain("FRAMEYARD_WHISPER_CLI");
    expect(audio).toContain("--force");
    expect(subtitles).toContain("TRANSCRIPT_WORDS_UNAVAILABLE");
    expect(subtitles).toContain("Never synthesize word timings");
    expect(subtitles).toContain("startFrame");
  });

  it("ships a thin script that runs the installed CLI", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const script = path.resolve("skills/frameyard/scripts/frameyard.mjs");
    const { stdout } = await exec(process.execPath, [script, "--version"]);

    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("can run after the skill directory is copied out of the package", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const root = await mkdtemp(path.join(tmpdir(), "frameyard-skill-"));
    try {
      const copied = path.join(root, "frameyard");
      await cp(path.resolve("skills/frameyard"), copied, { recursive: true });
      const { stdout } = await exec(process.execPath, [path.join(copied, "scripts", "frameyard.mjs"), "--version"], {
        env: {
          ...process.env,
          FRAMEYARD_CLI: path.resolve("dist/cli.js"),
        },
      });

      expect(stdout.trim()).toBe(packageJson.version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
