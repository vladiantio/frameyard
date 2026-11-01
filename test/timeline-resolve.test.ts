import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, type Project } from "../src/project.ts";
import { resolveProjectTimeline } from "../src/timeline/resolve.ts";

const roots: string[] = [];
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Z4sAAAAASUVORK5CYII=",
  "base64",
);

const compositionHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="1920" height="1080" fps="30" duration-in-frames="10"></fy-composition>
  </body>
</html>
`;

interface ProjectOptions {
  timeline: unknown;
  timelines?: Record<string, unknown>;
  compositionHtml?: string;
  timelineConfig?: Record<string, string>;
}

async function createProject(options: ProjectOptions): Promise<Project> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-resolve-"));
  roots.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });

  await writeFile(path.join(root, "compositions", "main.html"), options.compositionHtml ?? compositionHtml);
  await copyFile(path.join(repoRoot, "examples", "video", "assets", "clip.mp4"), path.join(root, "assets", "clip.mp4"));
  await copyFile(
    path.join(repoRoot, "examples", "demo", "assets", "chime.wav"),
    path.join(root, "assets", "chime.wav"),
  );
  await writeFile(path.join(root, "assets", "pixel.png"), pixelPng);

  const timelineEntries: Record<string, string> = options.timelineConfig ?? { main: "./timelines/main.json" };
  const allTimelines: Record<string, unknown> = options.timelines ?? { main: options.timeline };
  for (const [id, value] of Object.entries(allTimelines)) {
    const file = path.join(root, "timelines", `${id}.json`);
    await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }

  await writeFile(
    path.join(root, "video.config.js"),
    `export default {
      format: { width: 1920, height: 1080, fps: 30 },
      compositions: { intro: "./compositions/main.html" },
      timelines: ${JSON.stringify(timelineEntries)},
    };\n`,
  );

  return loadProject(root);
}

function timeline(
  clips: unknown[],
  tracks: unknown[] = [
    { id: "v1", kind: "video" },
    { id: "a1", kind: "audio" },
  ],
  extra: Record<string, unknown> = {},
) {
  return { version: 1, tracks, clips, ...extra };
}

async function resolveMain(project: Project, propsOverrides?: Record<string, unknown>) {
  const main = project.timelines.get("main");
  if (!main) {
    throw new Error("Missing main timeline.");
  }
  return resolveProjectTimeline({ project, timeline: main, ...(propsOverrides ? { propsOverrides } : {}) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("timeline resolution", () => {
  it("resolves composition, video, image, and audio sources with default durations", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "intro",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
        },
        {
          id: "broll",
          track: "v1",
          source: { kind: "video", src: "assets/clip.mp4" },
          start: 10,
          duration: 10,
          sourceIn: 30,
        },
        {
          id: "logo",
          track: "v1",
          source: { kind: "image", src: "assets/pixel.png" },
          start: 20,
          duration: 5,
        },
        {
          id: "music",
          track: "a1",
          source: { kind: "audio", src: "assets/chime.wav" },
          start: 0,
          duration: 20,
        },
      ]),
    });

    const resolved = await resolveMain(project);

    expect(resolved.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(resolved.timeline?.durationInFrames).toBe(25);
    expect(resolved.timeline?.clips.map((clip) => [clip.id, clip.duration, clip.end])).toEqual([
      ["intro", 10, 10],
      ["broll", 10, 20],
      ["logo", 5, 25],
      ["music", 20, 20],
    ]);
    expect(resolved.timeline?.clips[0]?.source).toMatchObject({
      kind: "composition",
      id: "intro",
      durationInFrames: 10,
    });
    expect(resolved.timeline?.clips[1]?.source).toMatchObject({
      kind: "video",
      src: "assets/clip.mp4",
      durationInFrames: 360,
      hasAudio: true,
    });
    expect(resolved.timeline?.clips[2]?.source).toMatchObject({ kind: "image", width: 1, height: 1 });
  });

  it("allows an audio clip to reference a video file", async () => {
    const project = await createProject({
      timeline: timeline(
        [
          {
            id: "dialogue",
            track: "a1",
            source: { kind: "audio", src: "assets/clip.mp4" },
            start: 0,
            duration: 30,
          },
        ],
        [{ id: "a1", kind: "audio" }],
      ),
    });

    const resolved = await resolveMain(project);

    expect(resolved.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(resolved.timeline?.clips[0]?.source).toMatchObject({ kind: "audio", hasAudio: true });
  });

  it("resolves nested timelines and reports their duration", async () => {
    const nested = timeline([
      {
        id: "nested-clip",
        track: "v1",
        source: { kind: "composition", id: "intro" },
        start: 0,
      },
    ]);
    const project = await createProject({
      timeline: timeline([
        {
          id: "nested",
          track: "v1",
          source: { kind: "timeline", id: "lower" },
          start: 0,
        },
      ]),
      timelines: {
        main: timeline([{ id: "nested", track: "v1", source: { kind: "timeline", id: "lower" }, start: 0 }]),
        lower: nested,
      },
      timelineConfig: { main: "./timelines/main.json", lower: "./timelines/lower.json" },
    });

    const resolved = await resolveMain(project);

    expect(resolved.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(resolved.timeline?.clips[0]?.source).toMatchObject({ kind: "timeline", id: "lower", durationInFrames: 10 });
  });

  it("rejects a missing composition reference", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "missing",
          track: "v1",
          source: { kind: "composition", id: "missing" },
          start: 0,
        },
      ]),
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TIMELINE_REFERENCE_NOT_FOUND",
        details: expect.objectContaining({ clip: "missing", track: "v1" }),
      }),
    );
  });

  it("rejects a missing nested timeline reference", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "missing",
          track: "v1",
          source: { kind: "timeline", id: "missing" },
          start: 0,
        },
      ]),
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_REFERENCE_NOT_FOUND")).toBe(true);
  });

  it("detects nested timeline cycles", async () => {
    const a = timeline([{ id: "to-b", track: "v1", source: { kind: "timeline", id: "b" }, start: 0 }]);
    const b = timeline([{ id: "to-a", track: "v1", source: { kind: "timeline", id: "a" }, start: 0 }]);
    const project = await createProject({
      timeline: a,
      timelines: { main: a, a, b },
      timelineConfig: { main: "./timelines/main.json", a: "./timelines/a.json", b: "./timelines/b.json" },
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_CYCLE")).toBe(true);
  });

  it("rejects a composition with a different frame rate", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "intro",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
        },
      ]),
      compositionHtml: compositionHtml.replace('fps="30"', 'fps="24"'),
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_FPS_MISMATCH")).toBe(true);
  });

  it("rejects a source range that exceeds the composition", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "intro",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
          duration: 11,
        },
      ]),
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_CLIP_OUT_OF_RANGE")).toBe(true);
  });

  it("rejects missing media and media kind mismatches", async () => {
    const missing = await createProject({
      timeline: timeline([
        {
          id: "missing",
          track: "v1",
          source: { kind: "video", src: "assets/missing.mp4" },
          start: 0,
          duration: 10,
        },
      ]),
    });
    const missingResult = await resolveMain(missing);
    expect(missingResult.timeline).toBeNull();
    expect(missingResult.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_MEDIA_INVALID")).toBe(true);

    const mismatch = await createProject({
      timeline: timeline([
        {
          id: "mismatch",
          track: "v1",
          source: { kind: "video", src: "assets/chime.wav" },
          start: 0,
          duration: 10,
        },
      ]),
    });
    const mismatchResult = await resolveMain(mismatch);
    expect(mismatchResult.timeline).toBeNull();
    expect(mismatchResult.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_MEDIA_INVALID")).toBe(true);
  });

  it("rejects overlaps and duration overrides after resolving omitted durations", async () => {
    const overlap = await createProject({
      timeline: timeline([
        {
          id: "a",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
        },
        {
          id: "b",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 5,
        },
      ]),
    });
    const overlapResult = await resolveMain(overlap);
    expect(overlapResult.timeline).toBeNull();
    expect(overlapResult.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_CLIP_OVERLAP")).toBe(true);

    const short = await createProject({
      timeline: timeline(
        [
          {
            id: "a",
            track: "v1",
            source: { kind: "composition", id: "intro" },
            start: 0,
          },
        ],
        undefined,
        { durationInFrames: 5 },
      ),
    });
    const shortResult = await resolveMain(short);
    expect(shortResult.timeline).toBeNull();
    expect(shortResult.diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_DURATION_INVALID")).toBe(true);
  });

  it("reports JSON syntax errors with a source location", async () => {
    const project = await createProject({
      timeline: '{\n  "version": 1,\n  "tracks": [\n}',
    });

    const resolved = await resolveMain(project);

    expect(resolved.timeline).toBeNull();
    const diagnostic = resolved.diagnostics.find((item) => item.code === "TIMELINE_INVALID");
    expect(diagnostic?.details).toMatchObject({
      path: "timelines/main.json",
      timeline: "main",
    });
  });

  it("applies top-level clip props overrides", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "intro",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
        },
      ]),
    });

    const resolved = await resolveMain(project, { intro: { title: "Override" } });

    expect(resolved.timeline?.clips[0]?.props).toEqual({ title: "Override" });
    expect(resolved.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const unknown = await resolveMain(project, { missing: { title: "Nope" } });
    expect(unknown.timeline).toBeNull();
    expect(unknown.diagnostics.some((diagnostic) => diagnostic.code === "PROPS_INVALID")).toBe(true);
  });

  it("adds clip and track context to composition diagnostics", async () => {
    const project = await createProject({
      timeline: timeline([
        {
          id: "intro",
          track: "v1",
          source: { kind: "composition", id: "intro" },
          start: 0,
        },
      ]),
      compositionHtml: compositionHtml.replace(
        "</fy-composition>",
        '<div data-fy-text="missing.path"></div></fy-composition>',
      ),
    });

    const resolved = await resolveMain(project);
    const warning = resolved.diagnostics.find((diagnostic) => diagnostic.code === "BINDING_PATH_MISSING");

    expect(warning?.details).toMatchObject({
      timeline: "main",
      clip: "intro",
      track: "v1",
      composition: "intro",
    });
  });
});
