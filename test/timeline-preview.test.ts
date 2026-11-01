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
    `<!doctype html><html><head><meta charset="utf-8"></head><body><fy-composition width="320" height="180" fps="10" duration-in-frames="10"></fy-composition></body></html>`,
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
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "video.config.js"),
    `export default {
      format: { width: 320, height: 180, fps: 10 },
      compositions: { intro: "./compositions/intro.html" },
      timelines: { main: "./timelines/main.json" },
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
          width: 320,
          height: 180,
          durationInFrames: 10,
        }),
        transform: { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      }),
    ]);
  });

  it("serves the timeline preview page and embedded host page", async () => {
    const preview = await fetch(new URL("/__frameyard/timeline/main", server.url));
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('data-timeline-id="main"');
    expect(html).toContain('data-embed="0"');
    expect(html).toContain("/__frameyard/framework/preview/timeline-main.js");
    expect(html).toContain("timeline");

    const embed = await fetch(new URL("/__frameyard/timeline/main?__fy-embed=1", server.url));
    expect(embed.status).toBe(200);
    const embedHtml = await embed.text();
    expect(embedHtml).toContain('data-embed="1"');
    expect(embedHtml).toContain('id="stage"');
    expect(embedHtml).not.toContain('id="timeline"');
  });

  it("lists the project format and timelines in project.json", async () => {
    const response = await fetch(new URL("/__frameyard/project.json", server.url));
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      format: { width: 320, height: 180, fps: 10 },
      timelines: [{ id: "main", entry: "timelines/main.json", kind: "timeline" }],
    });
    expect(Array.isArray(data.compositions)).toBe(true);
  });
});
