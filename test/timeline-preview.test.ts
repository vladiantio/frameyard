import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

let root: string;
let server: PreviewServer;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-timeline-preview-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "timelines"), { recursive: true });
  await writeFile(
    path.join(root, "compositions", "intro.html"),
    `<fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition>`,
  );
  await writeFile(
    path.join(root, "compositions", "still.html"),
    `<fy-composition width="320" height="180"><div style="width: 100%; height: 100%; background: #123456"></div></fy-composition>`,
  );
  await writeFile(
    path.join(root, "timelines", "static.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "still",
            track: "v1",
            source: { kind: "composition", id: "still" },
            start: 0,
            duration: 10,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "timelines", "main.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "intro",
            track: "v1",
            source: { kind: "composition", id: "intro" },
            start: 0,
            duration: 10,
            blend: "multiply",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "timelines", "motion.json"),
    `${JSON.stringify(
      {
        version: 1,
        tracks: [{ id: "v1", kind: "video" }],
        clips: [
          {
            id: "intro",
            track: "v1",
            source: { kind: "composition", id: "intro" },
            start: 0,
            duration: 10,
            keyframes: {
              opacity: [
                { frame: 0, value: 0 },
                { frame: 10, value: 1, easing: "ease-out" },
              ],
              x: [
                { frame: 0, value: -20 },
                { frame: 10, value: 0 },
              ],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default {
      format: { width: 320, height: 180, fps: 10 },
      compositions: { intro: "./compositions/intro.html", still: "./compositions/still.html" },
      timelines: { main: "./timelines/main.json", motion: "./timelines/motion.json", static: "./timelines/static.json" },
    };\n`,
  );
  server = await startPreviewServer({ projectRoot: root, port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("timeline preview server", () => {
  it("publishes timeline data for the preview host", async () => {
    const response = await fetch(new URL("/__frameyard/timeline/main.json", server.url));

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      timeline: "main",
      entry: "timelines/main.json",
      format: { width: 320, height: 180, fps: 10 },
      durationInFrames: 10,
      audioClips: [],
      diagnostics: [],
    });
    expect(data.clips).toEqual([
      expect.objectContaining({
        id: "intro",
        track: "v1",
        start: 0,
        duration: 10,
        end: 10,
        sourceIn: 0,
        source: expect.objectContaining({
          kind: "composition",
          id: "intro",
          url: "/compositions/intro.html?__fy-manual=1",
          metadata: {
            width: 320,
            height: 180,
            fps: 10,
            durationInFrames: 10,
          },
        }),
        transform: { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        blend: "multiply",
      }),
    ]);
  });

  it("publishes keyframe tracks for the preview host", async () => {
    const response = await fetch(new URL("/__frameyard/timeline/motion.json", server.url));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { clips: Array<Record<string, unknown>> };
    expect(data.clips[0]).toMatchObject({
      id: "intro",
      keyframes: {
        opacity: [
          { frame: 0, value: 0 },
          { frame: 10, value: 1, easing: "ease-out" },
        ],
        x: [
          { frame: 0, value: -20 },
          { frame: 10, value: 0 },
        ],
      },
    });
  });

  it("publishes static composition sources without a duration", async () => {
    const response = await fetch(new URL("/__frameyard/timeline/static.json", server.url));

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      clips: Array<{ source: Record<string, unknown> }>;
    };
    expect(data.clips[0]?.source).toMatchObject({
      kind: "composition",
      id: "still",
      url: "/compositions/still.html?__fy-manual=1",
      metadata: {
        width: 320,
        height: 180,
        static: true,
      },
    });
    expect(data.clips[0]?.source).not.toHaveProperty("durationInFrames");
  });

  it("serves the timeline preview page and embedded host page", async () => {
    const preview = await fetch(new URL("/__frameyard/timeline/main", server.url));
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('data-timeline-id="main"');
    expect(html).toContain('data-embed="0"');
    expect(html).toContain("/__frameyard/framework/preview/timeline-main.js");
    expect(html).toContain("timeline");
    expect(html).toContain("composition-assets");
    expect(html).toContain("timeline-assets");
    expect(html).toContain("media-assets");
    expect(html).toContain('id="source-viewport"');
    expect(html).toContain('id="source-title"');
    expect(html).toContain('id="program-viewport"');
    expect(html).toContain('id="props-view"');
    expect(html).toContain('id="inspector-host"');
    expect(html).toContain("timeline-panel");
    expect(html).toContain(".keyframe-marker");
    expect(html).toContain('id="ruler-scale"');
    expect(html).toContain('id="timeline-inner"');
    expect(html).toContain('id="playhead"');
    expect(html).toContain(".playhead");
    expect(html).toContain("/__frameyard/framework/preview/fonts/space-mono-latin-400-normal.woff2");
    expect(html).not.toContain('href="/__frameyard/fonts.css"');
    expect(html).toContain("--accent: #b8f36b");

    const embed = await fetch(new URL("/__frameyard/timeline/main?__fy-embed=1", server.url));
    expect(embed.status).toBe(200);
    const embedHtml = await embed.text();
    expect(embedHtml).toContain('data-embed="1"');
    expect(embedHtml).toContain('id="stage"');
    expect(embedHtml).not.toContain('id="timeline"');
    expect(embedHtml).not.toContain('id="ruler-scale"');
  });

  it("lists the project format and timelines in project.json", async () => {
    const response = await fetch(new URL("/__frameyard/project.json", server.url));
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      format: { width: 320, height: 180, fps: 10 },
      timelines: expect.arrayContaining([
        expect.objectContaining({ id: "main", entry: "timelines/main.json", kind: "timeline" }),
        expect.objectContaining({ id: "static", entry: "timelines/static.json", kind: "timeline" }),
      ]),
    });
    const compositions = data.compositions as Array<{ id: string; metadata: unknown }>;
    expect(compositions.find((composition) => composition.id === "still")?.metadata).toEqual({
      width: 320,
      height: 180,
      static: true,
    });
  });
});
