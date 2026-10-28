import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const enabled = process.env.FRAMEYARD_REAL_INTEGRATIONS === "1";

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} to run real-model integration tests.`);
  }
  return value;
}

let roots: string[] = [];

afterAll(async () => {
  for (const directory of roots) {
    await rm(directory, { recursive: true, force: true });
  }
  roots = [];
});

describe.skipIf(!enabled)("real-model integrations", () => {
  it(
    "produces a frozen WAV through qwentts.cpp",
    async () => {
      const talker = requiredEnv("FRAMEYARD_REAL_TALKER");
      const codec = requiredEnv("FRAMEYARD_REAL_CODEC");
      const root = await mkdtemp(path.join(tmpdir(), "frameyard-real-tts-"));
      roots.push(root);
      await writeFile(path.join(root, "script.txt"), "Frameyard real-model integration test.\n");

      const result = await run(
        [
          "tts",
          "--speaker",
          process.env.FRAMEYARD_REAL_SPEAKER ?? "vivian",
          "--talker-model",
          path.resolve(talker),
          "--codec-model",
          path.resolve(codec),
          "--text-file",
          "script.txt",
          "--out",
          "voice.wav",
          "--json",
        ],
        root,
      );

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "tts",
        sampleRate: 24_000,
        channels: 1,
      });
      expect((await readFile(path.join(root, "voice.wav"))).subarray(0, 4).toString()).toBe("RIFF");
    },
    600_000,
  );

  it(
    "produces a canonical transcript through whisper.cpp",
    async () => {
      const model = requiredEnv("FRAMEYARD_REAL_WHISPER_MODEL");
      const source = requiredEnv("FRAMEYARD_REAL_WHISPER_SOURCE");
      const root = await mkdtemp(path.join(tmpdir(), "frameyard-real-whisper-"));
      roots.push(root);

      const result = await run(
        [
          "transcribe",
          path.resolve(source),
          "--model",
          path.resolve(model),
          "--out",
          "transcript.json",
          "--words",
          "--export",
          "srt,vtt",
          "--json",
        ],
        root,
      );

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "transcribe",
        segments: expect.any(Number),
      });
      const transcript = JSON.parse(await readFile(path.join(root, "transcript.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(transcript).toMatchObject({ schemaVersion: 1 });
      expect(Array.isArray(transcript.words)).toBe(true);
    },
    900_000,
  );
});
