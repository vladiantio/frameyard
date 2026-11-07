import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG_SIGNATURE, createCliProject, ffprobe, pngPixel, runCli, type RunOptions } from "./helpers/cli-project.ts";

let root: string;

const run = (args: string[], cwd = root, options?: RunOptions) => runCli(args, cwd, options);

beforeAll(async () => {
  root = await createCliProject();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.concurrent("CLI stills and composition checks", () => {
  it("checks every frame and resolves audio", async () => {
    const result = await run(["check", "demo", "--project", root, "--json"], root);

    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      command: "check",
      composition: "demo",
      metadata: {
        width: 160,
        height: 90,
        fps: 10,
        durationInFrames: 6,
      },
      framesChecked: 6,
    });
    expect(json.audio).toMatchObject({ clips: 1 });
    expect(json.diagnostics).toEqual([]);
  });

  it("checks, stills, and renders an HTML composition", async () => {
    const check = await run(["check", "html", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({
      ok: true,
      command: "check",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      metadata: { width: 160, height: 90, fps: 10, durationInFrames: 6 },
      framesChecked: 6,
      audio: { clips: 1 },
      diagnostics: [],
    });

    const still = await run(
      ["still", "html", "--frame", "3", "--out", "html-3.png", "--project", root, "--json"],
      root,
    );
    expect(still.code).toBe(0);
    const stillJson = JSON.parse(still.stdout) as Record<string, unknown>;
    expect(stillJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      frame: 3,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    const pixel = await pngPixel(path.join(root, "html-3.png"), 25, 5);
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[1]).toBeGreaterThan(40);
    expect(pixel[2]).toBeLessThan(40);

    await mkdir(path.join(root, "nested"), { recursive: true });
    const render = await run(
      ["render", "html", "--encoder", "software", "--project", root, "--json"],
      path.join(root, "nested"),
    );
    expect(render.code).toBe(0);
    const rendered = JSON.parse(render.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      composition: "html",
      entry: "compositions/html.html",
      controller: { kind: "inline" },
      path: path.join(root, "out", "html.mp4"),
      framesRendered: 6,
      encoder: "libx264",
      audio: { clips: 1 },
      diagnostics: [],
    });
    const probe = await ffprobe(path.join(root, "out", "html.mp4"), ["-count_frames"]);
    const streams = probe.streams as Array<Record<string, unknown>>;
    expect(streams.find((stream) => stream.codec_type === "video")).toMatchObject({
      codec_name: "h264",
      width: 160,
      height: 90,
      nb_read_frames: "6",
    });
    expect(streams.find((stream) => stream.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
  });

  it("checks, stills, and renders a static composition as a PNG", async () => {
    const check = await run(["check", "static", "--project", root, "--json"], root);
    expect(check.code).toBe(0);
    const checked = JSON.parse(check.stdout) as Record<string, unknown>;
    expect(checked).toMatchObject({
      ok: true,
      command: "check",
      composition: "static",
      entry: "compositions/static.html",
      kind: "static",
      metadata: { width: 160, height: 90, static: true },
      framesChecked: 1,
      diagnostics: [],
    });
    expect(checked).not.toHaveProperty("audio");
    expect(checked).not.toHaveProperty("transcripts");

    const still = await run(
      ["still", "static", "--frame", "0", "--out", "static-0.png", "--project", root, "--json"],
      root,
    );
    expect(still.code).toBe(0);
    const stillJson = JSON.parse(still.stdout) as Record<string, unknown>;
    expect(stillJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "static",
      entry: "compositions/static.html",
      frame: 0,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    const pixel = await pngPixel(path.join(root, "static-0.png"), 80, 45);
    expect(pixel[2]).toBeGreaterThan(pixel[0] ?? 0);

    const outPath = path.join(root, "out", "static.png");
    const render = await run(["render", "static", "--project", root, "--json"], root, { pinEncoder: false });
    expect(render.code).toBe(0);
    const rendered = JSON.parse(render.stdout) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      ok: true,
      command: "render",
      kind: "image",
      composition: "static",
      entry: "compositions/static.html",
      path: outPath,
      width: 160,
      height: 90,
      diagnostics: [],
    });
    expect(rendered).not.toHaveProperty("codec");
    expect(rendered).not.toHaveProperty("framesRendered");
    expect((await stat(outPath)).size).toBeGreaterThan(0);

    const outOfRange = await run(["still", "static", "--frame", "1", "--project", root, "--json"], root);
    expect(outOfRange.code).toBe(1);
    expect(JSON.parse(outOfRange.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "FRAME_OUT_OF_RANGE" },
    });

    const videoFlag = await run(["render", "static", "--container", "mp4", "--project", root, "--json"], root, {
      pinEncoder: false,
    });
    expect(videoFlag.code).toBe(2);
    expect(JSON.parse(videoFlag.stdout)).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "USAGE" },
    });
  });

  it("returns static diagnostics for an invalid HTML composition", async () => {
    const result = await run(["check", "html-invalid", "--project", root, "--json"], root);
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "BINDING_INVALID" },
    });
    expect(json.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "BINDING_INVALID",
          details: expect.objectContaining({
            line: expect.any(Number),
            column: expect.any(Number),
            attribute: "data-fy-txt",
          }),
          fix: expect.objectContaining({
            kind: "attribute",
            from: "data-fy-txt",
            to: "data-fy-text",
            docs: expect.any(String),
          }),
        }),
      ]),
    );
    expect(json.error).toMatchObject({
      fix: { kind: "attribute", to: "data-fy-text", docs: expect.any(String) },
    });
  });

  it("fails a legacy full document with COMPOSITION_DOCUMENT_SHELL", async () => {
    const result = await run(["check", "legacy", "--project", root, "--json"], root);
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "COMPOSITION_DOCUMENT_SHELL" },
    });
    expect(json.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "COMPOSITION_DOCUMENT_SHELL",
          details: expect.objectContaining({
            path: "compositions/legacy.html",
            suggestion: expect.stringContaining("migration-0.8.md"),
          }),
        }),
      ]),
    );
  });

  it("fails check with invalid props and a structured error", async () => {
    const result = await run(["check", "demo", "--props", "bad-props.json", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "PROPS_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("label must be a string");
  });

  it("validates composition props against a declared schema before Chromium", async () => {
    const missing = await run(
      ["check", "schema-required", "--props", "schema-missing.json", "--project", root, "--json"],
      root,
    );
    expect(missing.code).not.toBe(0);
    const missingJson = JSON.parse(missing.stdout) as Record<string, unknown>;
    expect(missingJson).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "PROPS_SCHEMA_INVALID", details: { path: "title" } },
    });
    expect(missingJson.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({ path: "title" }),
      }),
    );

    const wrongType = await run(
      ["check", "schema-required", "--props", "schema-wrong-type.json", "--project", root, "--json"],
      root,
    );
    expect(wrongType.code).not.toBe(0);
    expect(JSON.parse(wrongType.stdout)).toMatchObject({
      error: { code: "PROPS_SCHEMA_INVALID", details: { path: "title" } },
    });

    const badEnum = await run(
      ["check", "schema-required", "--props", "schema-bad-enum.json", "--project", root, "--json"],
      root,
    );
    expect(badEnum.code).not.toBe(0);
    expect(JSON.parse(badEnum.stdout)).toMatchObject({
      error: { code: "PROPS_SCHEMA_INVALID", details: { path: "accent" } },
    });

    const still = await run(
      [
        "still",
        "schema-required",
        "--frame",
        "0",
        "--props",
        "schema-missing.json",
        "--out",
        "schema-invalid.png",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(still.code).not.toBe(0);
    expect(JSON.parse(still.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "PROPS_SCHEMA_INVALID" },
    });
    await expect(stat(path.join(root, "schema-invalid.png"))).rejects.toThrow();

    const render = await run(
      [
        "render",
        "schema-required",
        "--props",
        "schema-missing.json",
        "--out",
        "schema-invalid.mp4",
        "--project",
        root,
        "--json",
      ],
      root,
    );
    expect(render.code).not.toBe(0);
    expect(JSON.parse(render.stdout)).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "PROPS_SCHEMA_INVALID" },
    });
    await expect(stat(path.join(root, "schema-invalid.mp4"))).rejects.toThrow();

    const valid = await run(["check", "schema", "--props", "schema-valid.json", "--project", root, "--json"], root);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      ok: true,
      command: "check",
      composition: "schema",
      diagnostics: [],
    });

    const context = await run(["context", "--project", root, "--json"], root);
    expect(context.code).toBe(0);
    const contextJson = JSON.parse(context.stdout) as {
      compositions: Array<{ id: string; propsSchema?: unknown; props: Array<{ path: string; type: string }> }>;
    };
    const schema = contextJson.compositions.find((composition) => composition.id === "schema");
    expect(schema?.propsSchema).toMatchObject({ type: "object", required: ["title"] });
    expect(schema?.props).toContainEqual(expect.objectContaining({ path: "count", type: "number" }));

    const malformedLint = await run(["lint", "schema-malformed", "--project", root, "--json"], root);
    expect(malformedLint.code).not.toBe(0);
    expect(JSON.parse(malformedLint.stdout)).toMatchObject({
      ok: false,
      command: "lint",
      error: { code: "PROPS_SCHEMA_INVALID_SCHEMA" },
    });

    const malformedCheck = await run(["check", "schema-malformed", "--project", root, "--json"], root);
    expect(malformedCheck.code).not.toBe(0);
    expect(JSON.parse(malformedCheck.stdout)).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "PROPS_SCHEMA_INVALID_SCHEMA" },
    });
  });

  it("explains diagnostic codes with examples, docs, and a complete list", async () => {
    const explained = await run(["explain", "BINDING_INVALID", "--json"], root);
    expect(explained.code).toBe(0);
    expect(JSON.parse(explained.stdout)).toMatchObject({
      ok: true,
      command: "explain",
      code: "BINDING_INVALID",
      message: expect.any(String),
      docs: expect.any(String),
      examples: {
        failing: expect.stringContaining("data-fy-txt"),
        corrected: expect.stringContaining("data-fy-text"),
      },
    });

    const human = await run(["explain", "BINDING_INVALID"], root);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Cause:");
    expect(human.stdout).toContain("Failing:");
    expect(human.stdout).toContain("Corrected:");
    expect(human.stdout).toContain("Docs:");

    const list = await run(["explain", "--list", "--json"], root);
    expect(list.code).toBe(0);
    const listing = JSON.parse(list.stdout) as {
      codes?: Array<{ code: string; summary: string }>;
    };
    expect(listing.codes?.length).toBeGreaterThan(90);
    expect(listing.codes).toContainEqual(
      expect.objectContaining({ code: "BINDING_INVALID", summary: expect.any(String) }),
    );

    const unknown = await run(["explain", "NOT_A_CODE", "--json"], root);
    expect(unknown.code).not.toBe(0);
    const unknownJson = JSON.parse(unknown.stdout) as { error?: { code?: string; message?: string } };
    expect(unknownJson.error).toMatchObject({ code: "USAGE" });
    expect(unknownJson.error?.message).toContain("explain --list");
  });

  it("fails check when a required asset is missing", async () => {
    const result = await run(["check", "broken", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "MEDIA_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain('Composition "broken"');
    expect(String((json.error as Record<string, unknown>).message)).toContain("assets/missing.wav");
  });

  it("fails check when an embedded video is missing", async () => {
    const result = await run(["check", "missing-video", "--project", root, "--json"], root);

    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "check",
      error: { code: "MEDIA_INVALID" },
    });
    expect(String((json.error as Record<string, unknown>).message)).toContain("assets/missing.webm");
  });

  it("returns a JSON error envelope for usage failures", async () => {
    const result = await run(["render", "--json"], root);

    expect(result.code).toBe(2);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "USAGE" },
    });
  });

  it("captures deterministic stills through the production path", async () => {
    const first = await run(
      ["still", "demo", "--frame", "3", "--out", "still-a.png", "--props", "props.json", "--project", root, "--json"],
      root,
    );
    const second = await run(
      ["still", "demo", "--frame", "3", "--out", "still-b.png", "--props", "props.json", "--project", root, "--json"],
      root,
    );

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstJson).toMatchObject({
      ok: true,
      command: "still",
      composition: "demo",
      frame: 3,
      width: 160,
      height: 90,
    });
    expect(firstJson.frames).toEqual([{ frame: 3, path: path.join(root, "still-a.png") }]);

    const [a, b] = await Promise.all([
      readFile(path.join(root, "still-a.png")),
      readFile(path.join(root, "still-b.png")),
    ]);
    expect(a.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));

    const probe = await ffprobe(path.join(root, "still-a.png"));
    const stream = (probe.streams as Array<Record<string, unknown>>)[0];
    expect(stream).toMatchObject({ width: 160, height: 90 });
  });

  it("captures embedded video and WebGL stills deterministically", async () => {
    const first = await run(
      ["still", "media", "--frame", "3", "--out", "media-3a.png", "--project", root, "--json"],
      root,
    );
    const second = await run(
      ["still", "media", "--frame", "3", "--out", "media-3b.png", "--project", root, "--json"],
      root,
    );
    const later = await run(
      ["still", "media", "--frame", "7", "--out", "media-7.png", "--project", root, "--json"],
      root,
    );

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(later.code).toBe(0);

    const [a, b, c] = await Promise.all([
      readFile(path.join(root, "media-3a.png")),
      readFile(path.join(root, "media-3b.png")),
      readFile(path.join(root, "media-7.png")),
    ]);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    expect(createHash("sha256").update(a).digest("hex")).not.toBe(createHash("sha256").update(c).digest("hex"));

    const earlyVideo = await pngPixel(path.join(root, "media-3a.png"), 10, 10);
    const earlyWebGl = await pngPixel(path.join(root, "media-3a.png"), 100, 10);
    expect(earlyVideo[0]).toBeGreaterThan(180);
    expect(earlyVideo[1]).toBeLessThan(60);
    expect(earlyWebGl[2]).toBeGreaterThan(200);
    expect(earlyWebGl[0]).toBeLessThan(20);

    const lateVideo = await pngPixel(path.join(root, "media-7.png"), 10, 10);
    const lateWebGl = await pngPixel(path.join(root, "media-7.png"), 100, 10);
    expect(lateVideo[1]).toBeGreaterThan(180);
    expect(lateVideo[0]).toBeLessThan(60);
    expect(lateWebGl[0]).toBeGreaterThan(200);
    expect(lateWebGl[2]).toBeLessThan(20);
  });

  it("captures identical PNGs from concurrent still sessions", async () => {
    const capturePair = async (compositionId: string, frame: number, label: string, extraArgs: string[] = []) => {
      const baseArgs = ["still", compositionId, "--frame", String(frame), "--project", root, "--json", ...extraArgs];
      const [first, second] = await Promise.all([
        run([...baseArgs, "--out", `${label}-a.png`], root),
        run([...baseArgs, "--out", `${label}-b.png`], root),
      ]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
      const secondJson = JSON.parse(second.stdout) as Record<string, unknown>;
      expect(firstJson).toMatchObject({ ok: true, command: "still", composition: compositionId, frame });
      expect(secondJson).toMatchObject({ ok: true, command: "still", composition: compositionId, frame });

      const [a, b] = await Promise.all([
        readFile(path.join(root, `${label}-a.png`)),
        readFile(path.join(root, `${label}-b.png`)),
      ]);
      expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    };

    await capturePair("demo", 3, "concurrent-demo", ["--props", "props.json"]);
    await capturePair("media", 3, "concurrent-media");
  });

  it("captures a batch of stills in one session", async () => {
    const result = await run(
      ["still", "demo", "--frame", "0,3,5", "--props", "props.json", "--out", "batch", "--project", root, "--json"],
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      frames?: Array<{ frame: number; path: string }>;
      frame?: number;
      path?: string;
    };
    expect(json.frames?.map((entry) => entry.frame)).toEqual([0, 3, 5]);
    expect(json).not.toHaveProperty("frame");
    expect(json).not.toHaveProperty("path");

    for (const frame of [0, 3, 5]) {
      const batchPath = path.join(root, "batch", `still-demo-${frame}.png`);
      expect(json.frames?.find((entry) => entry.frame === frame)?.path).toBe(batchPath);
      expect((await readFile(batchPath)).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    }

    // One reference capture proves the batch path matches a standalone still
    // without re-running every frame in a second browser session.
    const reference = await run(
      ["still", "demo", "--frame", "3", "--props", "props.json", "--out", "single-3.png", "--project", root, "--json"],
      root,
    );
    expect(reference.code, reference.stderr).toBe(0);
    const [batchPng, referencePng] = await Promise.all([
      readFile(path.join(root, "batch", "still-demo-3.png")),
      readFile(path.join(root, "single-3.png")),
    ]);
    expect(createHash("sha256").update(batchPng).digest("hex")).toBe(
      createHash("sha256").update(referencePng).digest("hex"),
    );
  });

  it("expands ranges, preserves order, and removes duplicates", async () => {
    const result = await run(
      ["still", "long", "--frame", " 2-4, 4, 0 ", "--out", "range", "--project", root, "--json"],
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as { frames?: Array<{ frame: number; path: string }> };
    expect(json.frames?.map((entry) => entry.frame)).toEqual([2, 3, 4, 0]);
    expect(json.frames?.map((entry) => path.basename(entry.path))).toEqual([
      "still-long-2.png",
      "still-long-3.png",
      "still-long-4.png",
      "still-long-0.png",
    ]);
  });

  it("enforces the 32-frame still cap", async () => {
    const accepted = await run(
      ["still", "long", "--frame", "0-31", "--out", "cap-ok", "--project", root, "--json"],
      root,
    );
    expect(accepted.code, accepted.stderr).toBe(0);
    const acceptedJson = JSON.parse(accepted.stdout) as { frames?: unknown[] };
    expect(acceptedJson.frames).toHaveLength(32);

    const rejected = await run(
      ["still", "long", "--frame", "0-32", "--out", "cap-rejected", "--project", root, "--json"],
      root,
    );
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "USAGE", details: { cap: 32, count: 33 } },
    });
    await expect(stat(path.join(root, "cap-rejected"))).rejects.toThrow();
  }, 120_000);

  it("rejects malformed and descending frame specs before creating output", async () => {
    for (const spec of ["4-2", "2-", "0,,2", "0 - 2", "2.5", "abc"]) {
      const result = await run(
        ["still", "long", "--frame", spec, "--out", "invalid-spec", "--project", root, "--json"],
        root,
      );
      expect(result.code, spec).toBe(2);
      expect(JSON.parse(result.stdout), spec).toMatchObject({
        ok: false,
        command: "still",
        error: { code: "USAGE" },
      });
    }
    await expect(stat(path.join(root, "invalid-spec"))).rejects.toThrow();
  });

  it("rejects out-of-range still frames before capture", async () => {
    const result = await run(
      ["still", "demo", "--frame", "0,99", "--out", "out-of-range", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "FRAME_OUT_OF_RANGE",
        details: { invalidFrames: [99], validRange: { min: 0, max: 5 } },
      },
    });
    await expect(stat(path.join(root, "out-of-range"))).rejects.toThrow();
  });

  it("reports frame bounds before output conflicts", async () => {
    const outDir = path.join(root, "bounds-before-conflicts");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "still-demo-0.png"), "existing");

    const result = await run(
      ["still", "demo", "--frame", "0,99", "--out", "bounds-before-conflicts", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: { code: "FRAME_OUT_OF_RANGE" },
    });
  });

  it("preflights every still output before capture", async () => {
    const outDir = path.join(root, "conflicts");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "still-demo-0.png"), "existing");
    await writeFile(path.join(outDir, "still-demo-3.png"), "existing");

    const result = await run(
      ["still", "demo", "--frame", "0,2,3", "--props", "props.json", "--out", "conflicts", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "OUTPUT_EXISTS",
        details: {
          conflicts: [path.join(outDir, "still-demo-0.png"), path.join(outDir, "still-demo-3.png")],
        },
        fix: {
          kind: "value",
          patch: { overwrite: true },
          docs: expect.any(String),
        },
      },
    });
    await expect(stat(path.join(outDir, "still-demo-2.png"))).rejects.toThrow();

    const overwrite = await run(
      [
        "still",
        "demo",
        "--frame",
        "0,2,3",
        "--props",
        "props.json",
        "--out",
        "conflicts",
        "--project",
        root,
        "--overwrite",
        "--json",
      ],
      root,
    );
    expect(overwrite.code, overwrite.stderr).toBe(0);
    expect((await readFile(path.join(outDir, "still-demo-0.png"))).subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("uses a file for one still and a directory for many", async () => {
    const single = await run(
      ["still", "demo", "--frame", "0", "--out", "single-output.png", "--project", root, "--json"],
      root,
    );
    expect(single.code, single.stderr).toBe(0);
    const singleJson = JSON.parse(single.stdout) as { frame?: number; path?: string; frames?: unknown[] };
    expect(singleJson).toMatchObject({ frame: 0, path: path.join(root, "single-output.png") });
    expect(singleJson.frames).toHaveLength(1);

    const pngDirectory = await run(
      ["still", "demo", "--frame", "0,1", "--out", "not-a-directory.png", "--project", root, "--json"],
      root,
    );
    expect(pngDirectory.code).toBe(2);
    expect(JSON.parse(pngDirectory.stdout)).toMatchObject({ error: { code: "USAGE" } });

    await writeFile(path.join(root, "still-file"), "existing");
    const fileDirectory = await run(
      ["still", "demo", "--frame", "0,1", "--out", "still-file", "--project", root, "--json"],
      root,
    );
    expect(fileDirectory.code).toBe(2);
    expect(JSON.parse(fileDirectory.stdout)).toMatchObject({ error: { code: "USAGE" } });
  });

  it("publishes no stills when a later frame fails", async () => {
    const outDir = path.join(root, "throwing-batch");
    const result = await run(
      ["still", "throwing", "--frame", "0-5", "--out", "throwing-batch", "--project", root, "--json"],
      root,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "still",
      error: {
        code: "COMPOSITION_ERROR",
        details: { frames: [0, 1, 2, 3, 4, 5], failedFrame: 3 },
      },
    });
    await expect(stat(outDir)).rejects.toThrow();
  });

  it("captures embedded video and WebGL frames in one batch", async () => {
    const batch = await run(
      ["still", "media", "--frame", "3,7", "--out", "media-batch", "--project", root, "--json"],
      root,
    );
    expect(batch.code, batch.stderr).toBe(0);
    const batchJson = JSON.parse(batch.stdout) as { frames?: Array<{ frame: number; path: string }> };
    expect(batchJson.frames?.map((entry) => entry.frame)).toEqual([3, 7]);

    const [earlyVideo, earlyWebGl] = await Promise.all([
      pngPixel(path.join(root, "media-batch", "still-media-3.png"), 10, 10),
      pngPixel(path.join(root, "media-batch", "still-media-3.png"), 100, 10),
    ]);
    expect(earlyVideo[0]).toBeGreaterThan(180);
    expect(earlyVideo[1]).toBeLessThan(60);
    expect(earlyWebGl[2]).toBeGreaterThan(200);
    expect(earlyWebGl[0]).toBeLessThan(20);

    const [lateVideo, lateWebGl] = await Promise.all([
      pngPixel(path.join(root, "media-batch", "still-media-7.png"), 10, 10),
      pngPixel(path.join(root, "media-batch", "still-media-7.png"), 100, 10),
    ]);
    expect(lateVideo[1]).toBeGreaterThan(180);
    expect(lateVideo[0]).toBeLessThan(60);
    expect(lateWebGl[0]).toBeGreaterThan(200);
    expect(lateWebGl[2]).toBeLessThan(20);
  });

  it("uses still-<id>-<frame>.png when --out is omitted", async () => {
    const cwd = path.join(root, "default-names");
    await mkdir(cwd, { recursive: true });
    const result = await run(["still", "long", "--frame", "0,2", "--project", root, "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect((await stat(path.join(cwd, "still-long-0.png"))).size).toBeGreaterThan(0);
    expect((await stat(path.join(cwd, "still-long-2.png"))).size).toBeGreaterThan(0);

    const single = await run(["still", "long", "--frame", "1", "--project", root, "--json"], cwd);
    expect(single.code, single.stderr).toBe(0);
    expect((await stat(path.join(cwd, "still-long-1.png"))).size).toBeGreaterThan(0);
  });

  it("prints one line per still and a summary in human mode", async () => {
    const result = await run(["still", "demo", "--frame", "0,3", "--out", "human-batch", "--project", root], root);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Wrote frame 0 of demo");
    expect(lines[1]).toContain("Wrote frame 3 of demo");
    expect(lines[2]).toContain("Wrote 2 frames of demo");
  });
  describe.concurrent("composition format inheritance", () => {
    const inheritedComposition = `<fy-composition duration-in-frames="6">
      <div style="width: 100%; height: 100%; background: #123456"></div>
    </fy-composition>
`;

    async function createFormatProject(options: { format?: boolean } = {}): Promise<string> {
      const projectRoot = await mkdtemp(path.join(tmpdir(), "frameyard-cli-format-"));
      await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
      await writeFile(path.join(projectRoot, "compositions", "plain.html"), inheritedComposition);
      await writeFile(
        path.join(projectRoot, "fy.config.js"),
        `export default { ${
          options.format === false ? "" : "format: { width: 160, height: 90, fps: 10 }, "
        }compositions: { plain: "./compositions/plain.html" } };\n`,
      );
      return projectRoot;
    }

    it("checks and stills a composition that inherits the project format", async () => {
      const projectRoot = await createFormatProject();
      try {
        const check = await run(["check", "plain", "--project", projectRoot, "--json"], projectRoot);
        expect(check.code).toBe(0);
        expect(JSON.parse(check.stdout)).toMatchObject({
          ok: true,
          command: "check",
          composition: "plain",
          metadata: { width: 160, height: 90, fps: 10, durationInFrames: 6 },
          framesChecked: 6,
        });

        const still = await run(
          [
            "still",
            "plain",
            "--frame",
            "0",
            "--project",
            projectRoot,
            "--out",
            path.join(projectRoot, "still.png"),
            "--json",
          ],
          projectRoot,
        );
        expect(still.code).toBe(0);
        expect(JSON.parse(still.stdout)).toMatchObject({ ok: true, width: 160, height: 90 });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it("rejects an unresolved composition format without a project format", async () => {
      const projectRoot = await createFormatProject({ format: false });
      try {
        const result = await run(["check", "plain", "--project", projectRoot, "--json"], projectRoot);

        expect(result.code).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          command: "check",
          error: { code: "COMPOSITION_FORMAT_UNRESOLVED" },
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
