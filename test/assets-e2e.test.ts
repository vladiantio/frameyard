import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

const fakeQwenTts = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (args.includes("--help")) {
  const printHelp = () => {
    process.stdout.write(
      "qwentts.cpp 5916bf7c79dbb4e66fc059cdc507a79a23a28bb4 (2026-10-28)\nUsage: qwen-tts --model <gguf> --codec <gguf> --speaker <name> --lang <name> --instruct <str> --format <fmt> -o <out.wav>\n",
    );
    process.exit(0);
  };
  if (process.env.FAKE_TTS_HELP_SLEEP) {
    if (process.env.FAKE_TTS_HELP_READY) fs.writeFileSync(process.env.FAKE_TTS_HELP_READY, "ready");
    setTimeout(printHelp, Number(process.env.FAKE_TTS_HELP_SLEEP));
  } else {
    printHelp();
  }
  return;
}

const out = args[args.indexOf("-o") + 1];
const text = fs.readFileSync(0, "utf8");
if (process.env.FAKE_TTS_LOG) {
  fs.writeFileSync(process.env.FAKE_TTS_LOG, JSON.stringify({ args, text }));
}
if (process.env.FAKE_TTS_FAIL === "1") {
  fs.writeFileSync(out, "partial");
  process.exit(3);
}

function writeWav() {
  const sampleRate = 24000;
  const seconds = 0.25;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  const amplitude = 1000 + text.length;
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * amplitude), 44 + index * 2);
  }
  fs.writeFileSync(out, buffer);
  process.stderr.write("fake qwen-tts complete\n");
}

if (process.env.FAKE_TTS_SLEEP) {
  if (process.env.FAKE_TTS_READY) fs.writeFileSync(process.env.FAKE_TTS_READY, "ready");
  setTimeout(writeWav, Number(process.env.FAKE_TTS_SLEEP));
} else {
  writeWav();
}
`;

const fakeSherpaOnnxTts = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(
    [
      "Offline/Non-streaming text-to-speech with sherpa-onnx",
      "Supertonic TTS:",
      " --supertonic-duration-predictor   : ./model/duration_predictor.int8.onnx",
      " --supertonic-text-encoder         : ./model/text_encoder.int8.onnx",
      " --supertonic-vector-estimator     : ./model/vector_estimator.int8.onnx",
      " --supertonic-vocoder              : ./model/vocoder.int8.onnx",
      " --supertonic-tts-json             : ./model/tts.json",
      " --supertonic-unicode-indexer      : ./model/unicode_indexer.bin",
      " --supertonic-voice-style          : ./model/voice.bin",
      " --sid                             : 0",
      " --lang                            : en",
      " --output-filename                 : ./generated.wav",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function flagValue(flag) {
  const prefix = flag + "=";
  const inline = args.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const out = flagValue("--output-filename");
if (!out) process.exit(2);
const text = args[args.length - 1];
if (process.env.FAKE_SHERPA_LOG) {
  fs.writeFileSync(process.env.FAKE_SHERPA_LOG, JSON.stringify({ args, text }));
}
if (process.env.FAKE_SHERPA_FAIL === "1") {
  fs.writeFileSync(out, "partial");
  process.exit(3);
}

function writeWav() {
  const sampleRate = 44100;
  const seconds = 0.25;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  const amplitude = 1000 + text.length;
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * amplitude), 44 + index * 2);
  }
  fs.writeFileSync(out, buffer);
  process.stderr.write("fake sherpa-onnx-offline-tts complete\n");
}

writeWav();
`;

const fakeWhisperCli = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("whisper.cpp version: 0.0.0-fake\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(
    "usage: whisper-cli -m FNAME, --model FNAME -f FNAME, --file FNAME -ojf, --output-json-full -of FNAME, --output-file FNAME -l LANG, --language LANG -np, --no-prints\n",
  );
  process.exit(0);
}

const value = (flag) => args[args.indexOf(flag) + 1];
const input = value("-f");
const base = value("-of");
if (!input || !base) process.exit(2);

const header = fs.readFileSync(input).subarray(0, 44);
const sampleRate = header.readUInt32LE(24);
const channels = header.readUInt16LE(22);
if (sampleRate !== 16000 || channels !== 1) {
  process.stderr.write("expected 16 kHz mono input, got " + sampleRate + " Hz / " + channels + " channel(s)\n");
  process.exit(4);
}
if (process.env.FAKE_WHISPER_LOG) {
  fs.writeFileSync(
    process.env.FAKE_WHISPER_LOG,
    JSON.stringify({ args, sampleRate, channels, language: value("-l") }),
  );
}
if (process.env.FAKE_WHISPER_FAIL === "1") process.exit(5);
if (process.env.FAKE_WHISPER_SLEEP) {
  if (process.env.FAKE_WHISPER_READY) fs.writeFileSync(process.env.FAKE_WHISPER_READY, "ready");
  setTimeout(writeJson, Number(process.env.FAKE_WHISPER_SLEEP));
} else {
  writeJson();
}

function writeJson() {
  const noWords = process.env.FAKE_WHISPER_NO_WORDS === "1";
  const tokensA = noWords
    ? []
    : [
        { text: " Hello", offsets: { from: 0, to: 500 } },
        { text: " world", offsets: { from: 520, to: 1100 } },
        { text: ".", offsets: { from: 1100, to: 1200 } },
      ];
  const tokensB = noWords
    ? []
    : [
        { text: " Goodbye", offsets: { from: 1200, to: 1700 } },
        { text: " now", offsets: { from: 1720, to: 2250 } },
        { text: ".", offsets: { from: 2250, to: 2400 } },
      ];
  const output = {
    systeminfo: "fake",
    model: { type: "fake" },
    params: { model: value("-m"), language: value("-l"), translate: false },
    result: { language: "en" },
    transcription: [
      { offsets: { from: 0, to: 1200 }, text: " Hello world.", tokens: tokensA },
      { offsets: { from: 1200, to: 2400 }, text: " Goodbye now.", tokens: tokensB },
    ],
  };
  fs.writeFileSync(base + ".json", JSON.stringify(output));
  process.stderr.write("fake whisper-cli complete\n");
}
`;

function toneWav(seconds = 0.5, sampleRate = 8_000): Buffer {
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 330 * index) / sampleRate) * 4_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

let root: string;
let bin: string;
let logDir: string;

interface RunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function run(args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not finish: ${args.join(" ")}\n${stderr}`));
    }, 90_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "fy.assets.json"), "utf8")) as Record<string, unknown>;
}

function artifacts(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  return manifest.artifacts as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-assets-"));
  bin = path.join(root, "bin");
  logDir = path.join(root, "logs");
  await mkdir(path.join(root, "models"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "transcripts"), { recursive: true });
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(logDir, { recursive: true });

  await writeFile(path.join(bin, "qwen-tts"), fakeQwenTts);
  await writeFile(path.join(bin, "whisper-cli"), fakeWhisperCli);
  await writeFile(path.join(bin, "sherpa-onnx-offline-tts"), fakeSherpaOnnxTts);
  await chmod(path.join(bin, "qwen-tts"), 0o755);
  await chmod(path.join(bin, "whisper-cli"), 0o755);
  await chmod(path.join(bin, "sherpa-onnx-offline-tts"), 0o755);

  await writeFile(path.join(root, "models", "talker.gguf"), "fake talker model");
  await writeFile(path.join(root, "models", "codec.gguf"), "fake codec model");
  await writeFile(path.join(root, "models", "whisper.bin"), "fake whisper model");
  const supertonicDir = path.join(root, "models", "supertonic");
  await mkdir(supertonicDir, { recursive: true });
  for (const name of [
    "duration_predictor.int8.onnx",
    "text_encoder.int8.onnx",
    "vector_estimator.int8.onnx",
    "vocoder.int8.onnx",
    "tts.json",
    "unicode_indexer.bin",
    "voice.bin",
  ]) {
    await writeFile(path.join(supertonicDir, name), `fake ${name}`);
  }
  const supertonicFp32Dir = path.join(root, "models", "supertonic-fp32");
  await mkdir(supertonicFp32Dir, { recursive: true });
  for (const name of [
    "duration_predictor.onnx",
    "text_encoder.onnx",
    "vector_estimator.onnx",
    "vocoder.onnx",
    "tts.json",
    "unicode_indexer.bin",
    "voice.bin",
  ]) {
    await writeFile(path.join(supertonicFp32Dir, name), `fake fp32 ${name}`);
  }
  await writeFile(path.join(root, "assets", "source.wav"), toneWav());
  await writeFile(path.join(root, "script.txt"), "Hello from Frameyard.");
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { compositions: { checked: "./compositions/checked.html", karaoke: "./compositions/karaoke.html" } };\n`,
  );
  await writeFile(
    path.join(root, "compositions", "checked.html"),
    `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <fy-transcript src="transcripts/checked.json"></fy-transcript>
    </fy-composition>
`,
  );
  await writeFile(
    path.join(root, "compositions", "karaoke.html"),
    `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
      <fy-transcript src="transcripts/no-words.json" words></fy-transcript>
    </fy-composition>
`,
  );
  const source = {
    schemaVersion: 1,
    text: "Hello world.",
    language: "en",
    source: { path: "assets/source.wav", sha256: sha256(toneWav()), bytes: toneWav().length },
    segments: [{ startMs: 0, endMs: 1200, text: "Hello world." }],
    words: [
      { startMs: 0, endMs: 500, text: "Hello" },
      { startMs: 520, endMs: 1100, text: "world." },
    ],
  };
  await writeFile(path.join(root, "transcripts", "checked.json"), JSON.stringify(source));
  await writeFile(path.join(root, "transcripts", "no-words.json"), JSON.stringify({ ...source, words: undefined }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local asset production", () => {
  it("synthesizes a 24 kHz mono WAV and records provenance", async () => {
    const log = path.join(logDir, "tts.json");
    const result = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--text-file",
        "script.txt",
        "--style",
        "calm",
        "--language",
        "English",
        "--device",
        "CPU",
        "--out",
        "generated/voice.wav",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_TTS_LOG: log } },
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "tts",
      sampleRate: 24_000,
      channels: 1,
      speaker: "vivian",
      language: "English",
    });

    const invocation = JSON.parse(await readFile(log, "utf8")) as {
      args: string[];
      text: string;
    };
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--speaker",
        "vivian",
        "--format",
        "wav16",
        "--lang",
        "English",
        "--instruct",
        "calm",
        "--device",
        "CPU",
      ]),
    );
    expect(invocation.text).toBe("Hello from Frameyard.");

    const output = await readFile(path.join(root, "generated", "voice.wav"));
    expect(json.sha256).toBe(sha256(output));
    const probe = await exec("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels,codec_name",
      "-of",
      "json",
      path.join(root, "generated", "voice.wav"),
    ]);
    const stream = (JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>> }).streams[0];
    expect(stream).toMatchObject({ sample_rate: "24000", channels: 1, codec_name: "pcm_s16le" });

    const manifest = await readManifest();
    expect(manifest.schemaVersion).toBe(1);
    const artifact = artifacts(manifest).find((entry) => entry.path === "generated/voice.wav");
    expect(artifact).toMatchObject({
      kind: "audio",
      operation: "tts",
      sha256: sha256(output),
      bytes: output.length,
      generator: {
        name: "frameyard",
        command: "tts",
        integration: "qwentts.cpp",
      },
      parameters: {
        speaker: "vivian",
        style: "calm",
        language: "English",
        device: "CPU",
        format: "wav16",
        sampleRate: 24_000,
        channels: 1,
      },
    });
    const models = artifact?.models as Array<Record<string, unknown>> | undefined;
    expect(models?.map((model) => model.role)).toEqual(["talker", "codec"]);
  });

  it("synthesizes Supertonic speech, normalizes it to 24 kHz mono, and records provenance", async () => {
    const log = path.join(logDir, "supertonic.json");
    const result = await run(
      [
        "tts",
        "--engine",
        "supertonic",
        "--speaker",
        "3",
        "--model-dir",
        "models/supertonic",
        "--language",
        "es",
        "--text-file",
        "script.txt",
        "--out",
        "generated/supertonic.wav",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_SHERPA_LOG: log } },
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "tts",
      engine: "supertonic",
      sampleRate: 24_000,
      channels: 1,
      speaker: "3",
      language: "es",
    });

    const invocation = JSON.parse(await readFile(log, "utf8")) as {
      args: string[];
      text: string;
    };
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        `--supertonic-duration-predictor=${path.join(root, "models", "supertonic", "duration_predictor.int8.onnx")}`,
        `--supertonic-text-encoder=${path.join(root, "models", "supertonic", "text_encoder.int8.onnx")}`,
        `--supertonic-vector-estimator=${path.join(root, "models", "supertonic", "vector_estimator.int8.onnx")}`,
        `--supertonic-vocoder=${path.join(root, "models", "supertonic", "vocoder.int8.onnx")}`,
        `--supertonic-tts-json=${path.join(root, "models", "supertonic", "tts.json")}`,
        `--supertonic-unicode-indexer=${path.join(root, "models", "supertonic", "unicode_indexer.bin")}`,
        `--supertonic-voice-style=${path.join(root, "models", "supertonic", "voice.bin")}`,
        "--sid=3",
        "--lang=es",
      ]),
    );
    expect(invocation.args.slice(-2)).toEqual(["--", "Hello from Frameyard."]);
    expect(invocation.text).toBe("Hello from Frameyard.");

    const output = await readFile(path.join(root, "generated", "supertonic.wav"));
    expect(json.sha256).toBe(sha256(output));
    const probe = await exec("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels,codec_name",
      "-of",
      "json",
      path.join(root, "generated", "supertonic.wav"),
    ]);
    const stream = (JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>> }).streams[0];
    expect(stream).toMatchObject({ sample_rate: "24000", channels: 1, codec_name: "pcm_s16le" });

    const manifest = await readManifest();
    const artifact = artifacts(manifest).find((entry) => entry.path === "generated/supertonic.wav");
    expect(artifact).toMatchObject({
      kind: "audio",
      operation: "tts",
      sha256: sha256(output),
      bytes: output.length,
      generator: {
        name: "frameyard",
        command: "tts",
        integration: "sherpa-onnx",
        referenceRevision: "af2d8d81dbfa61c4cea4c568da78f3982edca005",
      },
      parameters: {
        engine: "supertonic",
        speaker: "3",
        language: "es",
        format: "wav16",
        sampleRate: 24_000,
        channels: 1,
        sourceSampleRate: 44_100,
        sourceChannels: 1,
        modelFiles: 7,
        modelArchive: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
      },
    });
    const models = artifact?.models as Array<Record<string, unknown>> | undefined;
    const expectedModels = [
      ["duration-predictor", "duration_predictor.int8.onnx"],
      ["text-encoder", "text_encoder.int8.onnx"],
      ["vector-estimator", "vector_estimator.int8.onnx"],
      ["vocoder", "vocoder.int8.onnx"],
      ["tts-json", "tts.json"],
      ["unicode-indexer", "unicode_indexer.bin"],
      ["voice-style", "voice.bin"],
    ];
    expect(models?.map((model) => [model.role, model.sha256])).toEqual(
      expectedModels.map(([role, name]) => [role, sha256(`fake ${name}`)]),
    );
  });

  it("marks a non-int8 Supertonic directory as custom archive provenance", async () => {
    const result = await run(
      [
        "tts",
        "--engine",
        "supertonic",
        "--speaker",
        "0",
        "--model-dir",
        "models/supertonic-fp32",
        "--language",
        "es",
        "--out",
        "generated/supertonic-fp32.wav",
        "--json",
      ],
      { input: "Text.", env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    expect(result.code).toBe(0);
    const manifest = await readManifest();
    const artifact = artifacts(manifest).find((entry) => entry.path === "generated/supertonic-fp32.wav");
    expect(artifact?.parameters).toMatchObject({ modelArchive: "custom" });
  });

  it("reports a missing Supertonic model file without publishing an artifact", async () => {
    const result = await run(
      [
        "tts",
        "--engine",
        "supertonic",
        "--speaker",
        "0",
        "--model-dir",
        "models/supertonic-missing",
        "--language",
        "es",
        "--out",
        "assets/missing-supertonic.wav",
        "--json",
      ],
      { input: "Text.", env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "ASSET_NOT_FOUND" },
    });
    await expect(stat(path.join(root, "assets", "missing-supertonic.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a missing Supertonic executable", async () => {
    const result = await run(
      [
        "tts",
        "--engine",
        "supertonic",
        "--speaker",
        "0",
        "--model-dir",
        "models/supertonic",
        "--language",
        "es",
        "--executable",
        "/nonexistent/sherpa-onnx-offline-tts",
        "--out",
        "assets/missing-executable.wav",
        "--json",
      ],
      { input: "Text." },
    );

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "EXECUTABLE_NOT_FOUND" },
    });
  });

  it("passes Supertonic text that starts with a dash after the option terminator", async () => {
    const log = path.join(logDir, "supertonic-dash.json");
    const result = await run(
      [
        "tts",
        "--engine",
        "supertonic",
        "--speaker",
        "0",
        "--model-dir",
        "models/supertonic",
        "--language",
        "es",
        "--out",
        "generated/supertonic-dash.wav",
        "--json",
      ],
      {
        input: "--leading dashes",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_SHERPA_LOG: log },
      },
    );

    expect(result.code).toBe(0);
    const invocation = JSON.parse(await readFile(log, "utf8")) as { args: string[]; text: string };
    expect(invocation.args.slice(-2)).toEqual(["--", "--leading dashes"]);
    expect(invocation.text).toBe("--leading dashes");
  });

  it("rejects engine-specific flags and invalid Supertonic values", async () => {
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const base = [
      "tts",
      "--engine",
      "supertonic",
      "--speaker",
      "0",
      "--model-dir",
      "models/supertonic",
      "--out",
      "assets/invalid.wav",
      "--json",
    ];

    const qwenFlag = await run([...base, "--language", "es", "--talker-model", "models/talker.gguf"], {
      input: "Text.",
      env,
    });
    expect(qwenFlag.code).not.toBe(0);
    expect(JSON.parse(qwenFlag.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "USAGE" },
    });

    const missingLanguage = await run(base, { input: "Text.", env });
    expect(missingLanguage.code).not.toBe(0);
    expect(JSON.parse(missingLanguage.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "USAGE" },
    });

    const invalidLanguage = await run([...base, "--language", "xx"], { input: "Text.", env });
    expect(invalidLanguage.code).not.toBe(0);
    expect(JSON.parse(invalidLanguage.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "USAGE" },
    });

    const invalidSpeaker = await run([...base, "--speaker", "vivian", "--language", "es"], {
      input: "Text.",
      env,
    });
    expect(invalidSpeaker.code).not.toBe(0);
    expect(JSON.parse(invalidSpeaker.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "USAGE" },
    });

    for (const forbidden of ["--style", "--device"]) {
      const result = await run([...base, "--language", "es", forbidden, "calm"], { input: "Text.", env });
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        command: "tts",
        error: { code: "USAGE" },
      });
    }

    const qwenModelDir = await run(
      [
        "tts",
        "--engine",
        "qwen",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--model-dir",
        "models/supertonic",
        "--out",
        "assets/invalid.wav",
        "--json",
      ],
      { input: "Text.", env },
    );
    expect(qwenModelDir.code).not.toBe(0);
    expect(JSON.parse(qwenModelDir.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "USAGE" },
    });
  });

  it("reads text from stdin and honors --force", async () => {
    const first = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/stdin.wav",
        "--json",
      ],
      {
        input: "Piped text.",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
    expect(first.code).toBe(0);
    const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
    const before = await readFile(path.join(root, "assets", "stdin.wav"));

    const refused = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/stdin.wav",
        "--json",
      ],
      {
        input: "Replacement text.",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "OUTPUT_EXISTS" },
    });
    expect(await readFile(path.join(root, "assets", "stdin.wav"))).toEqual(before);

    const overwritten = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/stdin.wav",
        "--force",
        "--json",
      ],
      {
        input: "Replacement text.",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
    expect(overwritten.code).toBe(0);
    const after = JSON.parse(overwritten.stdout) as Record<string, unknown>;
    expect(after.sha256).not.toBe(firstJson.sha256);
  });

  it("leaves no artifact or manifest entry after a failed synthesis", async () => {
    const result = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/failed.wav",
        "--json",
      ],
      {
        input: "This will fail.",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_TTS_FAIL: "1",
        },
      },
    );

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "TTS_FAILED" },
    });
    await expect(stat(path.join(root, "assets", "failed.wav"))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = await readManifest();
    expect(artifacts(manifest).some((entry) => entry.path === "assets/failed.wav")).toBe(false);
  });

  it("reports missing models and executables", async () => {
    const missingModel = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/missing.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/missing.wav",
        "--json",
      ],
      { input: "Text.", env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );
    expect(missingModel.code).not.toBe(0);
    expect(JSON.parse(missingModel.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "ASSET_NOT_FOUND" },
    });

    const missingExecutable = await run(
      [
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/missing.wav",
        "--executable",
        "/nonexistent/qwen-tts",
        "--json",
      ],
      { input: "Text." },
    );
    expect(missingExecutable.code).not.toBe(0);
    expect(JSON.parse(missingExecutable.stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "EXECUTABLE_NOT_FOUND" },
    });
  });

  it("cancels a running synthesis and removes partial outputs", async () => {
    const ready = path.join(logDir, "tts-ready");
    const child = spawn(
      process.execPath,
      [
        cli,
        "tts",
        "--speaker",
        "vivian",
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--out",
        "assets/cancelled.wav",
        "--json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_TTS_SLEEP: "10000",
          FAKE_TTS_READY: ready,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stdin.end("Cancelled text.");

    await waitForFile(ready);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(130);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      command: "tts",
      error: { code: "CANCELLED" },
    });
    await expect(stat(path.join(root, "assets", "cancelled.wav"))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = await readManifest();
    expect(artifacts(manifest).some((entry) => entry.path === "assets/cancelled.wav")).toBe(false);
  });
});

describe("local transcription", () => {
  it("normalizes audio, records canonical JSON, and exports subtitles", async () => {
    const log = path.join(logDir, "whisper.json");
    const result = await run(
      [
        "transcribe",
        "assets/source.wav",
        "--model",
        "models/whisper.bin",
        "--out",
        "generated/transcripts/source.json",
        "--words",
        "--export",
        "srt,vtt",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_WHISPER_LOG: log } },
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "transcribe",
      language: "en",
      segments: 2,
      words: 4,
    });

    const invocation = JSON.parse(await readFile(log, "utf8")) as {
      args: string[];
      sampleRate: number;
      channels: number;
      language: string;
    };
    expect(invocation).toMatchObject({ sampleRate: 16_000, channels: 1, language: "auto" });
    expect(invocation.args).toEqual(expect.arrayContaining(["-ojf", "-of", "-np"]));

    const transcript = JSON.parse(
      await readFile(path.join(root, "generated", "transcripts", "source.json"), "utf8"),
    ) as Record<string, unknown>;
    const source = await readFile(path.join(root, "assets", "source.wav"));
    expect(transcript).toMatchObject({
      schemaVersion: 1,
      text: "Hello world. Goodbye now.",
      language: "en",
      source: { path: "assets/source.wav", sha256: sha256(source), bytes: source.length },
    });
    expect((transcript.segments as Array<Record<string, unknown>>).map((segment) => segment.text)).toEqual([
      "Hello world.",
      "Goodbye now.",
    ]);
    expect((transcript.words as Array<Record<string, unknown>>).map((word) => word.text)).toEqual([
      "Hello",
      "world.",
      "Goodbye",
      "now.",
    ]);

    expect(await readFile(path.join(root, "generated", "transcripts", "source.srt"), "utf8")).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:01,200",
        "Hello world.",
        "",
        "2",
        "00:00:01,200 --> 00:00:02,400",
        "Goodbye now.",
        "",
      ].join("\n"),
    );
    expect(await readFile(path.join(root, "generated", "transcripts", "source.vtt"), "utf8")).toBe(
      [
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:01.200",
        "Hello world.",
        "",
        "00:00:01.200 --> 00:00:02.400",
        "Goodbye now.",
        "",
      ].join("\n"),
    );

    const manifest = await readManifest();
    const artifact = artifacts(manifest).find((entry) => entry.path === "generated/transcripts/source.json");
    expect(artifact).toMatchObject({
      kind: "transcript",
      operation: "transcribe",
      source: { path: "assets/source.wav", sha256: sha256(source) },
      generator: { integration: "whisper.cpp", command: "transcribe" },
      parameters: { words: true, language: "auto" },
    });
    const derived = artifact?.derived as Array<Record<string, unknown>> | undefined;
    expect(derived?.map((entry) => entry.format)).toEqual(["srt", "vtt"]);
  });

  it("omits word timings unless requested", async () => {
    const result = await run(
      [
        "transcribe",
        "assets/source.wav",
        "--model",
        "models/whisper.bin",
        "--out",
        "transcripts/segments-only.json",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );
    expect(result.code).toBe(0);
    const transcript = JSON.parse(
      await readFile(path.join(root, "transcripts", "segments-only.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(transcript.words).toBeUndefined();
  });

  it("fails when --words is requested but no measured word timings exist", async () => {
    const result = await run(
      [
        "transcribe",
        "assets/source.wav",
        "--model",
        "models/whisper.bin",
        "--out",
        "transcripts/missing-words.json",
        "--words",
        "--json",
      ],
      {
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_WHISPER_NO_WORDS: "1",
        },
      },
    );

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "transcribe",
      error: { code: "TRANSCRIPT_WORDS_UNAVAILABLE" },
    });
    await expect(stat(path.join(root, "transcripts", "missing-words.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const manifest = await readManifest();
    expect(artifacts(manifest).some((entry) => entry.path === "transcripts/missing-words.json")).toBe(false);
  });

  it("cancels a running transcription and removes partial outputs", async () => {
    const ready = path.join(logDir, "whisper-ready");
    const child = spawn(
      process.execPath,
      [
        cli,
        "transcribe",
        "assets/source.wav",
        "--model",
        "models/whisper.bin",
        "--out",
        "transcripts/cancelled.json",
        "--json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_WHISPER_SLEEP: "10000",
          FAKE_WHISPER_READY: ready,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    await waitForFile(ready);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(130);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      command: "transcribe",
      error: { code: "CANCELLED" },
    });
    await expect(stat(path.join(root, "transcripts", "cancelled.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const manifest = await readManifest();
    expect(artifacts(manifest).some((entry) => entry.path === "transcripts/cancelled.json")).toBe(false);
  });

  it("validates transcript requirements during check", async () => {
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const valid = await run(["check", "checked", "--json"], { env });
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      ok: true,
      command: "check",
      transcripts: {
        clips: 1,
        details: [{ src: "transcripts/checked.json", segments: 1, words: 2, language: "en", durationMs: 1200 }],
      },
    });

    const karaoke = await run(["check", "karaoke", "--json"], { env });
    expect(karaoke.code).not.toBe(0);
    expect(JSON.parse(karaoke.stdout)).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "TRANSCRIPT_WORDS_UNAVAILABLE" },
    });

    const still = await run(["still", "karaoke", "--frame", "0", "--out", "karaoke.png", "--json"], { env });
    expect(still.code).not.toBe(0);
    expect(JSON.parse(still.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "TRANSCRIPT_WORDS_UNAVAILABLE" },
    });

    const render = await run(["render", "karaoke", "--out", "karaoke.mp4", "--json"], { env });
    expect(render.code).not.toBe(0);
    expect(JSON.parse(render.stdout)).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "TRANSCRIPT_WORDS_UNAVAILABLE" },
    });
  });
});

describe("doctor", () => {
  it("reports core requirements, integrations, and manifest integrity", async () => {
    const result = await run(
      [
        "doctor",
        "--qwen-tts",
        path.join(bin, "qwen-tts"),
        "--whisper-cli",
        path.join(bin, "whisper-cli"),
        "--talker-model",
        "models/talker.gguf",
        "--codec-model",
        "models/codec.gguf",
        "--model",
        "models/whisper.bin",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "doctor",
      healthy: true,
      integrations: {
        tts: { status: "ok", name: "qwen-tts", referenceRevision: expect.any(String) },
        transcribe: {
          status: "ok",
          name: "whisper-cli",
          version: "whisper.cpp version: 0.0.0-fake",
        },
      },
      manifest: { exists: true, valid: true },
    });
    expect(json.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "talker", status: "ok", sha256: expect.any(String) }),
        expect.objectContaining({ role: "codec", status: "ok", sha256: expect.any(String) }),
        expect.objectContaining({ role: "whisper", status: "ok", sha256: expect.any(String) }),
      ]),
    );
    const checks = json.checks as Array<Record<string, unknown>>;
    expect(checks.filter((check) => check.required).every((check) => check.status === "ok")).toBe(true);
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "node",
        "ffmpeg",
        "ffmpeg-encoders",
        "ffmpeg-opus-encoder",
        "ffmpeg-video-encoders",
        "ffprobe",
        "chromium",
        "manifest",
      ]),
    );
    expect(checks.find((check) => check.name === "ffmpeg-opus-encoder")).toMatchObject({ required: false });
    const videoEncoders = checks.find((check) => check.name === "ffmpeg-video-encoders");
    expect(videoEncoders).toMatchObject({ required: false });
    expect(String(videoEncoders?.detail)).toContain("libx264");
  });

  it("reports the sherpa-onnx integration and Supertonic model directory", async () => {
    const result = await run(
      [
        "doctor",
        "--sherpa-onnx-tts",
        path.join(bin, "sherpa-onnx-offline-tts"),
        "--model-dir",
        "models/supertonic",
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "doctor",
      healthy: true,
      integrations: {
        sherpaOnnxTts: {
          name: "sherpa-onnx-offline-tts",
          status: "ok",
          requested: true,
          referenceRevision: expect.any(String),
        },
      },
    });
    expect(json.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "supertonic",
          status: "ok",
          bytes: expect.any(Number),
          sha256: expect.any(String),
        }),
      ]),
    );
  });

  it("exits nonzero when required tools are missing", async () => {
    const result = await run(["doctor", "--json"], { env: { PATH: bin } });
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "doctor", healthy: false });
    const checks = json.checks as Array<Record<string, unknown>>;
    expect(checks.find((check) => check.name === "ffmpeg")).toMatchObject({ status: "error" });
    expect(checks.find((check) => check.name === "ffprobe")).toMatchObject({ status: "error" });
  });

  it("reports unreadable requested models", async () => {
    const result = await run(["doctor", "--talker-model", "models/missing.gguf", "--json"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "doctor", healthy: false });
    expect(json.models).toEqual([expect.objectContaining({ role: "talker", status: "error" })]);
  });

  it("cancels a running doctor probe", async () => {
    const ready = path.join(logDir, "tts-help-ready");
    const child = spawn(process.execPath, [cli, "doctor", "--qwen-tts", path.join(bin, "qwen-tts"), "--json"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_TTS_HELP_SLEEP: "10000",
        FAKE_TTS_HELP_READY: ready,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    await waitForFile(ready);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(130);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      command: "doctor",
      error: { code: "CANCELLED" },
    });
  });

  it("detects provenance manifest tampering", async () => {
    const manifest = await readManifest();
    const first = artifacts(manifest)[0] as Record<string, unknown>;
    const tamperedPath = path.join(logDir, "tampered-manifest.json");
    await writeFile(
      tamperedPath,
      JSON.stringify({
        schemaVersion: 1,
        artifacts: [{ ...first, sha256: "0".repeat(64) }],
      }),
    );

    const result = await run(
      [
        "doctor",
        "--manifest",
        tamperedPath,
        "--qwen-tts",
        path.join(bin, "qwen-tts"),
        "--whisper-cli",
        path.join(bin, "whisper-cli"),
        "--json",
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "doctor",
      healthy: false,
      manifest: { exists: true, valid: false },
    });
    const checks = json.checks as Array<Record<string, unknown>>;
    expect(checks.find((check) => check.name === "manifest")).toMatchObject({ status: "error" });
    expect(String((json.manifest as Record<string, unknown>).detail)).toContain("hash");
  });
});
