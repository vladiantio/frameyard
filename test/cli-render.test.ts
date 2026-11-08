import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";
import {
  audioMeanVolume,
  createCliProject,
  decodedVideoHash,
  ffprobe,
  runCli,
  type RunOptions,
} from "./helpers/cli-project.ts";
import { mediaPixel } from "./helpers/media.ts";

let root: string;

const cli = path.resolve("dist/cli.js");
const run = (args: string[], cwd = root, options?: RunOptions) => runCli(args, cwd, options);

beforeAll(async () => {
  root = await createCliProject();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.concurrent("CLI renders and workflow", () => {
  it("renders citty help, version, and colored human output", async () => {
    const help = await run(["--help"], root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("COMMANDS");
    expect(help.stdout).toContain("render");
    expect(help.stdout).not.toContain("\u001b[");

    const commandHelp = await run(["render", "--help"], root);
    expect(commandHelp.code, commandHelp.stderr).toBe(0);
    expect(commandHelp.stdout).toContain("USAGE frameyard render");
    expect(commandHelp.stdout).toContain("--workers");
    expect(commandHelp.stdout).toContain("--no-progress");

    const namedHelp = await run(["help", "render"], root);
    expect(namedHelp.code, namedHelp.stderr).toBe(0);
    expect(namedHelp.stdout).toContain("USAGE frameyard render");

    const unknownHelp = await run(["help", "nope"], root);
    expect(unknownHelp.code).toBe(2);
    expect(unknownHelp.stderr).toContain('Unknown command "nope"');

    expect((await run(["--version"], root)).stdout.trim()).toBe(VERSION);
    expect((await run(["-v"], root)).stdout.trim()).toBe(VERSION);

    const beforeCommand = await run(["--json", "context", "--project", root], root);
    expect(beforeCommand.code, beforeCommand.stderr).toBe(0);
    expect(JSON.parse(beforeCommand.stdout)).toMatchObject({ ok: true, command: "context" });

    const plain = await run(["context", "--project", root], root);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).not.toContain("\u001b[");

    const colored = await run(["context", "--project", root], root, {
      env: { FORCE_COLOR: "1", TERM: "xterm-256color" },
    });
    expect(colored.code, colored.stderr).toBe(0);
    expect(colored.stdout).toContain("\u001b[");
  });

  it("reports render and check progress on stderr without touching JSON stdout", async () => {
    const check = await run(["check", "demo", "--project", root, "--json"], root);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stderr).toContain("Checking 6/6 (100%)");
    expect(check.stdout).not.toContain("Checking");
    expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, command: "check", framesChecked: 6 });

    const render = await run(
      ["render", "demo", "--frames", "0-2", "--out", "progress.mp4", "--project", root, "--json"],
      root,
    );
    expect(render.code, render.stderr).toBe(0);
    expect(render.stderr).toContain("Capturing 3/3 (100%)");
    expect(render.stderr).toContain("Encoding video...");
    expect(render.stderr).toContain("Finalizing output...");
    expect(render.stdout).not.toContain("Capturing");
    expect(render.stdout).not.toContain("Rendering");
    expect(JSON.parse(render.stdout)).toMatchObject({ ok: true, command: "render", framesRendered: 3 });

    const quietCheck = await run(["check", "demo", "--project", root, "--json", "--no-progress"], root);
    expect(quietCheck.code, quietCheck.stderr).toBe(0);
    expect(quietCheck.stderr).not.toContain("Checking");
    expect(JSON.parse(quietCheck.stdout)).toMatchObject({ ok: true, command: "check", framesChecked: 6 });

    const quietRender = await run(
      [
        "render",
        "demo",
        "--frames",
        "0-2",
        "--out",
        "quiet-progress.mp4",
        "--project",
        root,
        "--json",
        "--no-progress",
      ],
      root,
    );
    expect(quietRender.code, quietRender.stderr).toBe(0);
    expect(quietRender.stderr).not.toContain("Capturing");
    expect(quietRender.stderr).not.toContain("Encoding");
    expect(JSON.parse(quietRender.stdout)).toMatchObject({ ok: true, command: "render", framesRendered: 3 });
  });

  it("checks and renders embedded video audio with the declared timeline", async () => {
    const check = await run(["check", "media", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({ ok: true, command: "check", composition: "media", framesChecked: 12 });
    const audio = checked.audio as { clips: number; details: Array<Record<string, unknown>> };
    expect(audio.clips).toBe(2);
    expect(checked.diagnostics).toEqual([]);
    expect(audio.details.map((clip) => clip.src)).toEqual(["assets/tone.wav", "assets/clip.webm"]);

    const sequential = await run(
      ["render", "media", "--out", "media-sequential.mp4", "--concurrency", "1", "--project", root, "--json"],
      root,
    );
    const parallel = await run(
      ["render", "media", "--out", "media-parallel.mp4", "--concurrency", "2", "--project", root, "--json"],
      root,
    );

    expect(sequential.code).toBe(0);
    expect(parallel.code).toBe(0);
    const rendered = JSON.parse(sequential.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      composition: "media",
      fps: 10,
      durationInFrames: 12,
      framesRendered: 12,
    });
    expect(rendered.audio).toMatchObject({ clips: 2 });
    expect(rendered.diagnostics).toEqual([]);

    const probe = await ffprobe(path.join(root, "media-sequential.mp4"), ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audioStream = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", width: 160, height: 90, nb_read_frames: "12" });
    expect(audioStream).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number((probe.format as Record<string, unknown>).duration)).toBeCloseTo(1.2, 1);

    expect(await decodedVideoHash(path.join(root, "media-parallel.mp4"))).toBe(
      await decodedVideoHash(path.join(root, "media-sequential.mp4")),
    );

    const embeddedOnly = await run(
      ["render", "media", "--props", "embedded-props.json", "--out", "media-embedded.mp4", "--project", root, "--json"],
      root,
    );
    expect(embeddedOnly.code).toBe(0);
    const embeddedJson = JSON.parse(embeddedOnly.stdout) as Record<string, unknown>;
    expect(embeddedJson.audio).toMatchObject({ clips: 1 });
    expect(embeddedJson.diagnostics).toEqual([]);
    const embeddedProbe = await ffprobe(path.join(root, "media-embedded.mp4"));
    const embeddedStreams = embeddedProbe.streams as Array<Record<string, unknown>>;
    expect(embeddedStreams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
    expect(await audioMeanVolume(path.join(root, "media-embedded.mp4"))).toBeGreaterThan(-40);
  });

  it("renders an MP4 with the declared frames and an audio stream", async () => {
    const result = await run(
      ["render", "demo", "--props", "props.json", "--out", "video.mp4", "--project", root, "--json"],
      root,
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      width: 160,
      height: 90,
      fps: 10,
      durationInFrames: 6,
      framesRendered: 6,
      concurrency: 1,
    });

    const outputPath = path.join(root, "video.mp4");
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);

    const probe = await ffprobe(outputPath, ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", width: 160, height: 90, nb_read_frames: "6" });
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number((probe.format as Record<string, unknown>).duration)).toBeCloseTo(0.6, 1);
  });

  it("reports the resolved encoder when --encoder is omitted", async () => {
    const result = await run(["render", "demo", "--out", "default-encoder.mp4", "--project", root, "--json"], root, {
      pinEncoder: false,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "render", framesRendered: 6 });
    expect(["libx264", "h264_nvenc", "h264_qsv"]).toContain(json.encoder);
  });

  it("rejects an invalid render concurrency", async () => {
    for (const value of ["0", "1.5", "many", "17"]) {
      const result = await run(
        ["render", "demo", "--out", "invalid.mp4", "--concurrency", value, "--project", root, "--json"],
        root,
      );

      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({
        ok: false,
        command: "render",
        error: { code: "USAGE" },
      });
      expect(String((json.error as Record<string, unknown>).message)).toContain("--concurrency");
    }
  });

  it("rejects an unknown render encoder", async () => {
    for (const value of ["vaapi", "libx264"]) {
      const result = await run(
        ["render", "demo", "--out", "invalid.mp4", "--encoder", value, "--project", root, "--json"],
        root,
      );

      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({
        ok: false,
        command: "render",
        error: { code: "USAGE" },
      });
      expect(String((json.error as Record<string, unknown>).message)).toContain("--encoder");
    }
  });

  it("rejects an unknown render codec and a codec/encoder mismatch", async () => {
    const unknown = await run(
      ["render", "demo", "--out", "invalid.mp4", "--codec", "av1", "--project", root, "--json"],
      root,
    );
    expect(unknown.code).toBe(2);
    const unknownJson = JSON.parse(unknown.stdout) as Record<string, unknown>;
    expect(unknownJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((unknownJson.error as Record<string, unknown>).message)).toContain("--codec");

    const mismatch = await run(
      [
        "render",
        "demo",
        "--out",
        "invalid.mp4",
        "--codec",
        "vp9",
        "--container",
        "mkv",
        "--encoder",
        "nvenc",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(mismatch.code).toBe(2);
    const mismatchJson = JSON.parse(mismatch.stdout) as Record<string, unknown>;
    expect(mismatchJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((mismatchJson.error as Record<string, unknown>).message)).toContain("has no nvenc encoder");
  });

  it("renders HEVC with the hvc1 sample entry", async () => {
    const result = await run(
      ["render", "demo", "--codec", "hevc", "--encoder", "software", "--out", "hevc.mp4", "--project", root, "--json"],
      root,
    );

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      codec: "hevc",
      encoder: "libx265",
      framesRendered: 6,
    });

    const probe = await ffprobe(path.join(root, "hevc.mp4"), ["-count_frames"]);
    const video = (probe.streams as Array<Record<string, unknown>>).find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({ codec_name: "hevc", codec_tag_string: "hvc1", nb_read_frames: "6" });
  });

  it("renders MOV and WebM containers with matching codecs", async () => {
    const mov = await run(
      [
        "render",
        "demo",
        "--container",
        "mov",
        "--encoder",
        "software",
        "--out",
        "demo.mov",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(mov.code).toBe(0);
    expect(JSON.parse(mov.stdout)).toMatchObject({
      ok: true,
      codec: "h264",
      container: "mov",
      encoder: "libx264",
    });
    const movProbe = await ffprobe(path.join(root, "demo.mov"), ["-count_frames"]);
    expect(String((movProbe.format as Record<string, unknown>).format_name)).toContain("mov");
    expect(
      (movProbe.streams as Array<Record<string, unknown>>).find((stream) => stream.codec_type === "video"),
    ).toMatchObject({ codec_name: "h264", nb_read_frames: "6" });

    const webm = await run(
      [
        "render",
        "demo",
        "--container",
        "webm",
        "--encoder",
        "software",
        "--out",
        "demo.webm",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(webm.code).toBe(0);
    expect(JSON.parse(webm.stdout)).toMatchObject({
      ok: true,
      codec: "vp9",
      container: "webm",
      encoder: "libvpx-vp9",
    });
    const webmProbe = await ffprobe(path.join(root, "demo.webm"), ["-count_frames"]);
    expect(String((webmProbe.format as Record<string, unknown>).format_name)).toContain("webm");
    const streams = webmProbe.streams as Array<Record<string, unknown>>;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "vp9",
      nb_read_frames: "6",
    });
    expect(streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "opus" });
  });

  it("rejects containers that cannot hold the codec or the output extension", async () => {
    for (const args of [
      ["--container", "avi"],
      ["--container", "mp4", "--codec", "vp9"],
      ["--container", "webm", "--codec", "hevc"],
    ]) {
      const result = await run(["render", "demo", "--out", "invalid.mp4", ...args, "--project", root, "--json"], root);
      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    }

    const extension = await run(
      ["render", "demo", "--container", "mkv", "--out", "wrong.mp4", "--project", root, "--json"],
      root,
    );
    expect(extension.code).toBe(2);
    const extensionJson = JSON.parse(extension.stdout) as Record<string, unknown>;
    expect(extensionJson).toMatchObject({ ok: false, command: "render", error: { code: "USAGE" } });
    expect(String((extensionJson.error as Record<string, unknown>).message)).toContain(".mkv");
  });

  it("renders identical frames with parallel capture sessions", async () => {
    const sequential = await run(
      [
        "render",
        "demo",
        "--props",
        "props.json",
        "--out",
        "sequential.mp4",
        "--concurrency",
        "1",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    const parallel = await run(
      [
        "render",
        "demo",
        "--props",
        "props.json",
        "--out",
        "parallel.mp4",
        "--concurrency",
        "2",
        "--project",
        root,
        "--json",
      ],
      root,
    );

    expect(sequential.code).toBe(0);
    expect(parallel.code).toBe(0);
    const json = JSON.parse(parallel.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "render",
      composition: "demo",
      durationInFrames: 6,
      framesRendered: 6,
      concurrency: 2,
    });

    const parallelProbe = await ffprobe(path.join(root, "parallel.mp4"), ["-count_frames"]);
    const streams = parallelProbe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", nb_read_frames: "6" });
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });

    // End-to-end smoke check only: x264 threading and rate control are not a
    // determinism guarantee. The capture-boundary check is "captures identical
    // PNGs from concurrent still sessions".
    expect(await decodedVideoHash(path.join(root, "parallel.mp4"))).toBe(
      await decodedVideoHash(path.join(root, "sequential.mp4")),
    );
  });

  it("stops a parallel render when a frame fails and publishes nothing", async () => {
    const outputPath = path.join(root, "throwing.mp4");
    const result = await run(
      ["render", "throwing", "--out", "throwing.mp4", "--concurrency", "2", "--project", root, "--json"],
      root,
    );

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "COMPOSITION_ERROR" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("frame boom");
    await expect(stat(outputPath)).rejects.toThrow();
  });

  it("refuses to overwrite an existing render unless asked", async () => {
    const outputPath = path.join(root, "overwrite.mp4");
    const before = Buffer.from("existing output");
    await writeFile(outputPath, before);
    const result = await run(["render", "demo", "--out", "overwrite.mp4", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: false, command: "render", error: { code: "OUTPUT_EXISTS" } });
    expect(await readFile(outputPath)).toEqual(before);

    const overwrite = await run(
      ["render", "demo", "--out", "overwrite.mp4", "--project", root, "--overwrite", "--json"],
      root,
    );
    expect(overwrite.code).toBe(0);
  });

  it("starts and stops the dev preview", async () => {
    const child = spawn(process.execPath, [cli, "dev", "--project", root, "--port", "0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dev did not start:\n${stderr}`)), 15_000);
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = /Frameyard preview: (http:\/\/\S+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve(match[1] as string);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`dev exited early with ${code}:\n${stderr}`));
        });
      });

      const response = await fetch(new URL("/__frameyard/", url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Frameyard Preview");

      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("scaffolds a working project with init", async () => {
    const target = path.join(root, "scaffold");
    const init = await run(["init", target, "--json"], root);

    expect(init.code).toBe(0);
    const json = JSON.parse(init.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, command: "init" });
    expect(json.files).toContain(".gitignore");
    expect(json.files).toContain("AGENTS.md");
    expect(json.files).toContain("package.json");
    expect(json.next).toEqual([
      "npx frameyard doctor",
      "npx frameyard dev",
      "npx frameyard check main",
      "npx frameyard render main",
    ]);
    expect((await stat(path.join(target, "fy.config.js"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "compositions", "hello.html"))).isFile()).toBe(true);
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toBe("out/\n");

    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    expect(manifest).toEqual({
      name: "scaffold",
      private: true,
      type: "module",
      scripts: {
        dev: `npx --yes frameyard@${VERSION} dev`,
        check: `npx --yes frameyard@${VERSION} check`,
        render: `npx --yes frameyard@${VERSION} render`,
        still: `npx --yes frameyard@${VERSION} still`,
      },
    });

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("fy-composition");
    expect(agents).toContain("data-fy-text");
    expect(agents).toContain("data-fy-anim-start");
    expect(agents).toContain('random("stable:key")');
    expect(agents).toContain("qwen-tts");
    expect(agents).toContain("whisper-cli");
    expect(agents).toContain("fy.assets.json");
    expect(agents).toContain("npx frameyard@");
    expect(agents).toContain("npx skills add vladiantio/frameyard");
    for (const command of [
      "npx frameyard doctor --json",
      "npx frameyard check main --json",
      "npx frameyard still main --frame 42 --out main-42.png --json",
      "npx frameyard render main --props props/main.json --workers 8 --scratch /path/to/scratch --json",
    ]) {
      expect(agents).toContain(command);
    }

    const readme = await readFile(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("AGENTS.md");
    for (const command of [
      "npx frameyard dev",
      "npx frameyard doctor",
      "npx frameyard check main",
      "npx frameyard render main --props props/main.json",
    ]) {
      expect(readme).toContain(command);
    }

    const human = await run(["init", path.join(root, "scaffold-human")], root);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Next: npx frameyard doctor && npx frameyard dev");

    const composition = await readFile(path.join(target, "compositions", "hello.html"), "utf8");
    expect(composition).toContain('duration-in-frames="150"');

    // The scaffold's full 150-frame metadata is covered above; one capture is
    // enough to prove the generated project renders through the real CLI.
    const still = await run(
      ["still", "hello", "--frame", "0", "--out", path.join(root, "scaffold-hello.png"), "--project", target, "--json"],
      root,
    );
    expect(still.code, still.stderr).toBe(0);
    expect(JSON.parse(still.stdout)).toMatchObject({
      ok: true,
      command: "still",
      composition: "hello",
      frame: 0,
    });
  });

  it("scaffolds into the current directory using its name", async () => {
    const target = path.join(root, "scaffold-dot");
    await mkdir(target);

    const init = await run(["init", ".", "--json"], target);
    expect(init.code).toBe(0);

    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    expect(manifest.name).toBe("scaffold-dot");
  });

  it("scaffolds into my-video when init has no directory", async () => {
    const target = path.join(root, "scaffold-default");
    await mkdir(target);

    const init = await run(["init", "--json"], target);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({
      ok: true,
      command: "init",
      project: path.join(target, "my-video"),
    });
    expect((await stat(path.join(target, "my-video", "fy.config.js"))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(target, "my-video", "package.json"), "utf8"));
    expect(manifest.name).toBe("my-video");

    const humanRoot = path.join(root, "scaffold-default-human");
    await mkdir(humanRoot);
    const human = await run(["init"], humanRoot);
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain("Project name");
    expect(human.stdout).toContain(`Created Frameyard project at ${path.join(humanRoot, "my-video")}`);
  });

  it.runIf(process.platform === "linux")("prompts for the project name when init has no directory", async () => {
    const target = path.join(root, "scaffold-prompt");
    await mkdir(target);

    const child = spawn(
      "script",
      ["-qec", `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} init`, "/dev/null"],
      {
        cwd: target,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    let prompted = false;
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (prompted) return;
      const plain = stdout
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "")
        .replace(/\s+/g, "");
      if (plain.includes("Projectname")) {
        prompted = true;
        child.stdin.write("demo-film\r");
      }
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`init did not finish:\n${stdout}\n${stderr}`));
      }, 20_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    expect(code, stderr).toBe(0);
    expect(stdout.replace(/\s+/g, "")).toContain("Projectname");
    expect((await stat(path.join(target, "demo-film", "fy.config.js"))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(target, "demo-film", "package.json"), "utf8"));
    expect(manifest.name).toBe("demo-film");
    await expect(stat(path.join(target, "fy.config.js"))).rejects.toThrow();
  });
  describe.concurrent("resource policy and lint", () => {
    const policyComposition = `<script type="application/json" data-fy="props">{ "label": "Hello" }</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div data-fy-text="label" style="color: white; font: 12px monospace"></div>
</fy-composition>
`;

    const riskyComposition = `<fy-composition width="160" height="90" fps="10" duration-in-frames="6">
  <div style="width: 100%; height: 100%; background: #123456"></div>
</fy-composition>
<script type="text/fy-controller">
export default {
  update() {
    return Math.random();
  },
};
</script>
`;

    const scaledComposition = `<style>
  .fill { background: #654321; }
  @media (max-resolution: 0.75dppx) { .fill { background: #00ff00; } }
</style>
<fy-composition width="160" height="100" fps="10" duration-in-frames="6">
  <div class="fill" style="width: 100%; height: 100%"></div>
</fy-composition>
`;

    const oddComposition = `<fy-composition width="161" height="91" fps="10" duration-in-frames="6">
  <div style="width: 100%; height: 100%; background: #123456"></div>
</fy-composition>
`;

    const policyTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "hello",
          track: "v1",
          source: { kind: "composition", id: "hello" },
          start: 0,
        },
      ],
      transitions: [],
    };

    async function createPolicyProject(): Promise<string> {
      const root = await mkdtemp(path.join(tmpdir(), "frameyard-policy-cli-"));
      await mkdir(path.join(root, "compositions"), { recursive: true });
      await mkdir(path.join(root, "timelines"), { recursive: true });
      await writeFile(path.join(root, "compositions", "hello.html"), policyComposition);
      await writeFile(path.join(root, "compositions", "risky.html"), riskyComposition);
      await writeFile(path.join(root, "compositions", "scaled.html"), scaledComposition);
      await writeFile(path.join(root, "compositions", "odd.html"), oddComposition);
      await writeFile(path.join(root, "timelines", "main.timeline.json"), JSON.stringify(policyTimeline, null, 2));
      await writeFile(
        path.join(root, "fy.config.js"),
        `export default { format: { width: 160, height: 90, fps: 10 }, compositions: { hello: "./compositions/hello.html", risky: "./compositions/risky.html", scaled: "./compositions/scaled.html", odd: "./compositions/odd.html" }, timelines: { main: "./timelines/main.timeline.json" } };\n`,
      );
      return root;
    }

    it("discovers the workspace policy from a nested working directory", async () => {
      const root = await createPolicyProject();
      const nested = path.join(root, "nested", "deeper");
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, "fy.policy.json"), JSON.stringify({ version: 1, policy: "authoring" }, null, 2));
      try {
        const result = await run(["render", "main", "--project", root, "--json"], nested, { policy: null });
        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          command: "render",
          error: { code: "RESOURCE_POLICY_BLOCKED", details: { operation: "render" } },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("lets an explicit env override replace the file for a dry run", async () => {
      const root = await createPolicyProject();
      await writeFile(path.join(root, "fy.policy.json"), JSON.stringify({ version: 1, policy: "authoring" }, null, 2));
      try {
        const result = await run(["render", "main", "--project", root, "--dry-run", "--json"], root, {
          env: { FRAMEYARD_POLICY: "full" },
        });
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({ ok: true, dryRun: true, plan: { frames: 6, segments: 1 } });
        expect(body.commandLine).not.toContain("FRAMEYARD_POLICY=full");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("prints a dry-run plan without creating output or launching Chromium", async () => {
      const root = await createPolicyProject();
      try {
        const result = await run(["render", "main", "--project", root, "--dry-run", "--json"], root, {
          env: { FRAMEYARD_POLICY: "authoring" },
        });
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({
          ok: true,
          command: "render",
          dryRun: true,
          policy: { policy: "authoring" },
          plan: { kind: "video", frames: 6, probed: false },
          output: { exists: false },
        });
        expect(body.commandLine).toContain("FRAMEYARD_POLICY=full");
        await expect(stat(path.join(root, "out"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("enforces the still cap and overwrite permission before capture", async () => {
      const root = await createPolicyProject();
      try {
        const limited = await run(["still", "main", "--project", root, "--frame", "0-4", "--json"], root, {
          env: { FRAMEYARD_POLICY: "authoring" },
        });
        expect(limited.code).not.toBe(0);
        expect(JSON.parse(limited.stdout)).toMatchObject({
          error: { code: "RESOURCE_POLICY_LIMIT", details: { limit: 4, requested: 5 } },
        });

        const overwrite = await run(
          ["still", "hello", "--project", root, "--frame", "0", "--overwrite", "--json"],
          root,
          { env: { FRAMEYARD_POLICY: "authoring" } },
        );
        expect(overwrite.code).not.toBe(0);
        expect(JSON.parse(overwrite.stdout)).toMatchObject({
          error: { code: "RESOURCE_POLICY_BLOCKED", details: { operation: "overwrite" } },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("rejects worker values above the shared-cpu profile cap", async () => {
      const root = await createPolicyProject();
      try {
        const result = await run(
          ["render", "main", "--project", root, "--dry-run", "--profile", "shared-cpu", "--workers", "4", "--json"],
          root,
          { env: { FRAMEYARD_POLICY: "full" } },
        );
        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          error: { code: "RESOURCE_PROFILE_CONFLICT", details: { option: "workers", limit: 2 } },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("lints a timeline without Chromium and reports controller determinism warnings", async () => {
      const root = await createPolicyProject();
      try {
        const timeline = await run(["lint", "main", "--project", root, "--json"], root, {
          env: { FRAMEYARD_POLICY: "authoring" },
        });
        expect(timeline.code).toBe(0);
        expect(JSON.parse(timeline.stdout)).toMatchObject({
          ok: true,
          command: "lint",
          kind: "timeline",
          framesProjected: 6,
          segments: 1,
        });

        const risky = await run(["lint", "risky", "--project", root, "--json"], root, {
          env: { FRAMEYARD_POLICY: "authoring" },
        });
        expect(risky.code).toBe(0);
        expect(JSON.parse(risky.stdout).diagnostics).toContainEqual(
          expect.objectContaining({ severity: "warning", code: "DETERMINISM_WARNING" }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("does not spawn tts or transcribe executables during a dry run", async () => {
      const root = await createPolicyProject();
      const log = path.join(root, "fake.log");
      const fake = path.join(root, "fake-tool.sh");
      const modelDir = path.join(root, "model");
      const textFile = path.join(root, "text.txt");
      const source = path.join(root, "source.wav");
      const model = path.join(root, "model.gguf");
      await mkdir(modelDir, { recursive: true });
      await writeFile(textFile, "hello");
      await writeFile(source, "fake");
      await writeFile(model, "fake");
      await writeFile(fake, `#!/bin/sh\necho invoked >> "$FRAMEYARD_FAKE_LOG"\n`);
      await chmod(fake, 0o755);
      const env = { FRAMEYARD_POLICY: "authoring", FRAMEYARD_FAKE_LOG: log };
      try {
        const tts = await run(
          [
            "tts",
            "--engine",
            "supertonic",
            "--speaker",
            "0",
            "--model-dir",
            modelDir,
            "--language",
            "en",
            "--out",
            path.join(root, "voice.wav"),
            "--text-file",
            textFile,
            "--executable",
            fake,
            "--project",
            root,
            "--dry-run",
            "--json",
          ],
          root,
          { env },
        );
        expect(tts.code).toBe(0);
        expect(JSON.parse(tts.stdout)).toMatchObject({ ok: true, dryRun: true, plan: { kind: "tts" } });

        const transcribe = await run(
          [
            "transcribe",
            source,
            "--model",
            model,
            "--out",
            path.join(root, "voice.json"),
            "--executable",
            fake,
            "--project",
            root,
            "--dry-run",
            "--json",
          ],
          root,
          { env },
        );
        expect(transcribe.code).toBe(0);
        expect(JSON.parse(transcribe.stdout)).toMatchObject({ ok: true, dryRun: true, plan: { kind: "transcribe" } });

        await expect(stat(log)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("writes template entries and reports the exact registration snippet", async () => {
      const root = await createPolicyProject();
      try {
        const list = await run(["add", "--list", "--json"], root);
        expect(list.code).toBe(0);
        expect(JSON.parse(list.stdout).templates.map((entry: { name: string }) => entry.name)).toEqual([
          "static-poster",
          "title-card",
          "lower-third",
          "slideshow",
        ]);

        const composition = await run(
          ["add", "composition", "intro", "--template", "lower-third", "--project", root, "--json"],
          root,
        );
        expect(composition.code).toBe(0);
        expect(JSON.parse(composition.stdout)).toMatchObject({
          ok: true,
          command: "add",
          kind: "composition",
          id: "intro",
          register: { compositions: { intro: "./compositions/intro.html" } },
        });
        expect((await stat(path.join(root, "compositions", "intro.html"))).isFile()).toBe(true);

        const timeline = await run(
          ["add", "timeline", "reel", "--template", "slideshow", "--project", root, "--json"],
          root,
        );
        expect(timeline.code).toBe(0);
        expect(JSON.parse(timeline.stdout)).toMatchObject({
          ok: true,
          command: "add",
          kind: "timeline",
          id: "reel",
          register: { timelines: { reel: "./timelines/reel.timeline.json" } },
        });
        expect((await stat(path.join(root, "timelines", "reel.timeline.json"))).isFile()).toBe(true);

        const duplicate = await run(
          ["add", "composition", "intro", "--template", "lower-third", "--project", root, "--json"],
          root,
        );
        expect(duplicate.code).not.toBe(0);
        expect(JSON.parse(duplicate.stdout)).toMatchObject({ error: { code: "OUTPUT_EXISTS" } });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("installs a recipe bundle and reports the registration snippet", async () => {
      const root = await createPolicyProject();
      try {
        const list = await run(["add", "--list", "--json"], root);
        expect(list.code).toBe(0);
        const listing = JSON.parse(list.stdout);
        expect(listing.recipes).toContainEqual(
          expect.objectContaining({
            id: "lower-third",
            files: expect.arrayContaining(["compositions/{id}.html"]),
          }),
        );

        const recipe = await run(["add", "recipe", "lower-third", "--id", "hero", "--project", root, "--json"], root);
        expect(recipe.code).toBe(0);
        expect(JSON.parse(recipe.stdout)).toMatchObject({
          ok: true,
          command: "add",
          kind: "recipe",
          recipe: "lower-third",
          id: "hero",
          files: [
            "compositions/hero.html",
            "timelines/hero-timeline.timeline.json",
            "props/hero.json",
            "recipes/hero.md",
          ],
          register: {
            compositions: { hero: "./compositions/hero.html" },
            timelines: { "hero-timeline": "./timelines/hero-timeline.timeline.json" },
          },
        });

        for (const file of [
          "compositions/hero.html",
          "timelines/hero-timeline.timeline.json",
          "props/hero.json",
          "recipes/hero.md",
        ]) {
          expect((await stat(path.join(root, file))).isFile()).toBe(true);
        }

        const timeline = JSON.parse(
          await readFile(path.join(root, "timelines", "hero-timeline.timeline.json"), "utf8"),
        );
        expect(timeline.clips[0].source).toEqual({ kind: "composition", id: "hero" });

        await writeFile(
          path.join(root, "fy.config.js"),
          `export default { format: { width: 160, height: 90, fps: 10 }, compositions: { hello: "./compositions/hello.html", risky: "./compositions/risky.html", hero: "./compositions/hero.html" }, timelines: { main: "./timelines/main.timeline.json", "hero-timeline": "./timelines/hero-timeline.timeline.json" } };\n`,
        );
        const lint = await run(["lint", "hero-timeline", "--project", root, "--json"], root);
        expect(lint.code).toBe(0);
        expect(JSON.parse(lint.stdout)).toMatchObject({
          ok: true,
          command: "lint",
          timeline: "hero-timeline",
        });

        const duplicate = await run(
          ["add", "recipe", "lower-third", "--id", "hero", "--project", root, "--json"],
          root,
        );
        expect(duplicate.code).not.toBe(0);
        expect(JSON.parse(duplicate.stdout)).toMatchObject({ error: { code: "OUTPUT_EXISTS" } });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("does not write recipe files when one target already exists", async () => {
      const root = await createPolicyProject();
      try {
        await writeFile(path.join(root, "timelines", "hero-timeline.timeline.json"), "{}\n");
        const result = await run(["add", "recipe", "lower-third", "--id", "hero", "--project", root, "--json"], root);
        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          error: {
            code: "OUTPUT_EXISTS",
            details: { conflicts: ["timelines/hero-timeline.timeline.json"] },
          },
        });
        await expect(stat(path.join(root, "compositions", "hero.html"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("renders composition frame ranges and scaled output", async () => {
      const root = await createPolicyProject();
      try {
        const range = await run(["render", "hello", "--frames", "1-3", "--project", root, "--json"], root);
        expect(range.code, range.stderr).toBe(0);
        expect(JSON.parse(range.stdout)).toMatchObject({
          ok: true,
          command: "render",
          kind: "video",
          composition: "hello",
          frameRange: { start: 1, end: 3 },
          durationInFrames: 3,
          framesRendered: 3,
          scale: 1,
          width: 160,
          height: 90,
        });
        const rangeProbe = await ffprobe(path.join(root, "out", "hello.mp4"), ["-count_frames"]);
        expect(rangeProbe.format).toMatchObject({ duration: "0.300000" });
        expect((rangeProbe.streams as Array<Record<string, unknown>>)[0]).toMatchObject({ nb_read_frames: "3" });

        const scaled = await run(["render", "scaled", "--scale", "0.5", "--project", root, "--json"], root);
        expect(scaled.code, scaled.stderr).toBe(0);
        expect(JSON.parse(scaled.stdout)).toMatchObject({
          ok: true,
          command: "render",
          kind: "video",
          composition: "scaled",
          frameRange: { start: 0, end: 5 },
          scale: 0.5,
          width: 80,
          height: 50,
        });
        const scaledProbe = await ffprobe(path.join(root, "out", "scaled.mp4"));
        expect((scaledProbe.streams as Array<Record<string, unknown>>)[0]).toMatchObject({
          width: 80,
          height: 50,
        });
        // The capture ran at 0.5 dppx. A full-size capture scaled during
        // encode would still rasterize at 1 dppx and keep the brown fill.
        const [red, green, blue] = await mediaPixel(path.join(root, "out", "scaled.mp4"), 40, 25);
        expect(green).toBeGreaterThan(200);
        expect(red).toBeLessThan(60);
        expect(blue).toBeLessThan(60);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("renders a timeline frame range", async () => {
      const root = await createPolicyProject();
      try {
        const result = await run(["render", "main", "--frames", "1-3", "--project", root, "--json"], root);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain("Rendering 1/3 (33%)");
        expect(result.stderr).toContain("Rendering 2/3 (66%)");
        expect(result.stderr).toContain("Rendering 3/3 (100%)");
        expect(result.stderr).toContain("Muxing segments...");
        expect(result.stderr).toContain("Finalizing output...");
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          command: "render",
          timeline: "main",
          frameRange: { start: 1, end: 3 },
          durationInFrames: 3,
          framesRendered: 3,
          scale: 1,
          width: 160,
          height: 90,
        });
        const probe = await ffprobe(path.join(root, "out", "main.mp4"), ["-count_frames"]);
        expect((probe.streams as Array<Record<string, unknown>>)[0]).toMatchObject({ nb_read_frames: "3" });

        const checked = await run(["check", "main", "--project", root, "--json"], root);
        expect(checked.code, checked.stderr).toBe(0);
        expect(checked.stderr).toContain("Checking 1/6 (16%)");
        expect(checked.stderr).toContain("Checking 6/6 (100%)");
        expect(JSON.parse(checked.stdout)).toMatchObject({
          ok: true,
          command: "check",
          timeline: "main",
          framesChecked: 6,
        });

        const scaled = await run(
          ["render", "main", "--scale", "0.5", "--out", "out/main-scaled.mp4", "--project", root, "--json"],
          root,
        );
        expect(scaled.code, scaled.stderr).toBe(0);
        expect(JSON.parse(scaled.stdout)).toMatchObject({
          timeline: "main",
          scale: 0.5,
          width: 80,
          height: 44,
        });
        const scaledProbe = await ffprobe(path.join(root, "out", "main-scaled.mp4"));
        expect((scaledProbe.streams as Array<Record<string, unknown>>)[0]).toMatchObject({
          width: 80,
          height: 44,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("writes a PNG sequence without an encoded video", async () => {
      const root = await createPolicyProject();
      try {
        const outDir = path.join(root, "sequence");
        const result = await run(
          ["render", "hello", "--sequence", outDir, "--frames", "0-2", "--project", root, "--json"],
          root,
        );
        expect(result.code, result.stderr).toBe(0);
        const json = JSON.parse(result.stdout) as {
          kind?: string;
          sequence?: string;
          frames?: Array<{ frame: number; path: string }>;
          scale?: number;
        };
        expect(json).toMatchObject({
          ok: true,
          command: "render",
          kind: "sequence",
          composition: "hello",
          sequence: outDir,
          scale: 1,
        });
        expect(json.frames?.map((frame) => frame.frame)).toEqual([0, 1, 2]);
        for (const frame of [0, 1, 2]) {
          expect((await stat(path.join(outDir, `sequence-hello-${frame}.png`))).isFile()).toBe(true);
        }
        await expect(stat(path.join(root, "out", "hello.mp4"))).rejects.toThrow();

        const timelineDir = path.join(root, "timeline-sequence");
        const timelineResult = await run(
          ["render", "main", "--sequence", timelineDir, "--frames", "0-1", "--project", root, "--json"],
          root,
        );
        expect(timelineResult.code, timelineResult.stderr).toBe(0);
        expect(JSON.parse(timelineResult.stdout)).toMatchObject({
          kind: "sequence",
          timeline: "main",
          sequence: timelineDir,
        });
        expect(JSON.parse(timelineResult.stdout).frames).toHaveLength(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("gates sequence renders with the same resource policy", async () => {
      const root = await createPolicyProject();
      try {
        const result = await run(
          ["render", "hello", "--sequence", path.join(root, "sequence"), "--frames", "0", "--project", root, "--json"],
          root,
          { env: { FRAMEYARD_POLICY: "authoring" } },
        );
        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          command: "render",
          error: { code: "RESOURCE_POLICY_BLOCKED" },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("rejects out-of-range frames and invalid scales before writing output", async () => {
      const root = await createPolicyProject();
      try {
        const frames = await run(["render", "hello", "--frames", "5-7", "--project", root, "--json"], root);
        expect(frames.code).not.toBe(0);
        expect(JSON.parse(frames.stdout)).toMatchObject({
          ok: false,
          command: "render",
          error: { code: "FRAME_OUT_OF_RANGE" },
        });
        await expect(stat(path.join(root, "out", "hello.mp4"))).rejects.toThrow();

        const scale = await run(["render", "hello", "--scale", "0.1", "--project", root, "--json"], root);
        expect(scale.code).toBe(2);
        expect(JSON.parse(scale.stdout)).toMatchObject({
          ok: false,
          command: "render",
          error: { code: "USAGE" },
        });
        await expect(stat(path.join(root, "out", "hello.mp4"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("rejects odd composition dimensions for video output", async () => {
      const root = await createPolicyProject();
      try {
        const result = await run(["render", "odd", "--project", root, "--json"], root);
        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          command: "render",
          error: {
            code: "RENDER_FAILED",
            message: expect.stringContaining("even dimensions"),
          },
        });
        await expect(stat(path.join(root, "out", "odd.mp4"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("reports the active policy and resources from doctor", async () => {
      const root = await createPolicyProject();
      await writeFile(
        path.join(root, "fy.policy.json"),
        JSON.stringify({ version: 1, policy: "authoring", profile: "shared-cpu" }, null, 2),
      );
      try {
        const result = await run(["doctor", "--json"], root, { policy: null });
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({
          ok: true,
          command: "doctor",
          policy: { status: "ok", policy: "authoring", profile: "shared-cpu" },
          resources: { cpus: expect.any(Number) },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("reports an invalid policy as a doctor finding without hiding the environment checks", async () => {
      const root = await createPolicyProject();
      await writeFile(path.join(root, "fy.policy.json"), JSON.stringify({ version: 1, policy: "turbo" }, null, 2));
      try {
        const result = await run(["doctor", "--json"], root, { policy: null });
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({
          ok: true,
          command: "doctor",
          policy: { status: "error", code: "POLICY_INVALID" },
          checks: expect.any(Array),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
  describe.concurrent("local-model scaffold installation", () => {
    const expectedFiles = [
      "fy.policy.json",
      ".opencode/opencode.jsonc",
      ".pi/settings.json",
      ".pi/APPEND_SYSTEM.md",
      ".pi/sandbox.json",
      "LOCAL-MODELS.md",
    ];

    it("installs the scaffold with init --local-models", async () => {
      const target = path.join(root, "init-local-models");
      const result = await run(["init", target, "--local-models", "--json"], root);
      try {
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({ ok: true, command: "init", localModels: true });
        expect(body.files).toEqual(expect.arrayContaining(expectedFiles));
        expect(body.next).toContain("Review .pi/settings.json and run pi --approve");
        for (const file of expectedFiles) {
          expect((await stat(path.join(target, file))).isFile(), file).toBe(true);
        }
        expect(JSON.parse(await readFile(path.join(target, "fy.policy.json"), "utf8"))).toMatchObject({
          version: 1,
          policy: "authoring",
          profile: "shared-cpu",
        });
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });

    it("installs the scaffold with add local-models and refuses overwrite", async () => {
      const target = path.join(root, "add-local-models");
      await mkdir(target, { recursive: true });
      try {
        const result = await run(["add", "local-models", "--project", target, "--json"], root);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          command: "add",
          kind: "scaffold",
          scaffold: "local-models",
        });
        for (const file of expectedFiles) {
          expect((await stat(path.join(target, file))).isFile(), file).toBe(true);
        }

        const duplicate = await run(["add", "local-models", "--project", target, "--json"], root);
        expect(duplicate.code).not.toBe(0);
        expect(JSON.parse(duplicate.stdout)).toMatchObject({
          error: { code: "OUTPUT_EXISTS", details: { conflicts: expect.arrayContaining(["fy.policy.json"]) } },
        });
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });
  });
});
