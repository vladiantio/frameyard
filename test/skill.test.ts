import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("official agent skill", () => {
  it("is included in the published package and versioned with the API", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
      files: string[];
    };
    const skill = await readFile("skill/SKILL.md", "utf8");

    expect(packageJson.files).toContain("skill");
    expect(skill).toContain(`frameyard-api-version: ${packageJson.version}`);
    expect(skill).toContain("references/deterministic-authoring.md");
    expect(skill).toContain("references/audio-assets.md");
    expect(skill).toContain("references/subtitles-karaoke.md");
    expect(skill).toContain("references/json-results.md");
    expect(skill).toContain("references/failure-recovery.md");
  });

  it("uses Frameyard wrappers rather than upstream inference executables", async () => {
    const skill = await readFile("skill/SKILL.md", "utf8");
    const audio = await readFile("skill/references/audio-assets.md", "utf8");
    const subtitles = await readFile("skill/references/subtitles-karaoke.md", "utf8");

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
    const script = path.resolve("skill/scripts/frameyard.mjs");
    const { stdout } = await exec(process.execPath, [script, "--version"]);

    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("can run after the skill directory is copied out of the package", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const root = await mkdtemp(path.join(tmpdir(), "frameyard-skill-"));
    try {
      const copied = path.join(root, "frameyard");
      await cp(path.resolve("skill"), copied, { recursive: true });
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
