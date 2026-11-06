import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

let root: string;
let server: PreviewServer;

const helloHtml = `<script type="application/json" data-fy="props">{ "title": "Hello" }</script>
<script type="importmap">{"imports":{"demo-lib":"./demo-lib.js"}}</script>
<style>h1 { color: rgb(1, 2, 3); }</style>
<link rel="stylesheet" href="https://example.com/style.css">
<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <h1 data-fy-text="title"></h1>
</fy-composition>
<script type="text/fy-controller">
export default {
  mount() {},
  update() {},
};
</script>
`;

const badHtml = `<fy-composition width="320" height="180" fps="10" duration-in-frames="5"></fy-composition>
<script type="module">console.log("bad")</script>
`;

const oldHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="5"></fy-composition>
  </body>
</html>
`;

const plainHtml = `<!doctype html><html><body><h1>Plain</h1></body></html>`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-html-server-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { compositions: { hello: "./compositions/hello.html", bad: "./compositions/bad.html", old: "./compositions/old.html" }, format: { width: 320, height: 180, fps: 10 } };\n`,
  );
  await writeFile(path.join(root, "compositions", "hello.html"), helloHtml);
  await writeFile(path.join(root, "compositions", "bad.html"), badHtml);
  await writeFile(path.join(root, "compositions", "old.html"), oldHtml);
  await writeFile(path.join(root, "compositions", "plain.html"), plainHtml);
  server = await startPreviewServer({ projectRoot: root, port: 0 });
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("HTML composition server", () => {
  it("loads .html composition entries", async () => {
    const project = await loadProject(root);

    expect(project.compositions.get("hello")).toMatchObject({
      id: "hello",
      entry: "compositions/hello.html",
      kind: "html",
    });
  });

  it("publishes HTML metadata, controller, and diagnostics", async () => {
    const response = await fetch(new URL("/__frameyard/project.json", server.url));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { compositions: Array<Record<string, unknown>> };
    const hello = body.compositions.find((composition) => composition.id === "hello");
    expect(hello).toMatchObject({
      id: "hello",
      entry: "compositions/hello.html",
      kind: "html",
      metadata: { width: 320, height: 180, fps: 10, durationInFrames: 5 },
      controller: { kind: "inline" },
    });
    expect(Array.isArray(hello?.diagnostics)).toBe(true);

    const bad = body.compositions.find((composition) => composition.id === "bad");
    expect(bad?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SCRIPT_NOT_ALLOWED" })]));

    const old = body.compositions.find((composition) => composition.id === "old");
    expect(old?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPOSITION_DOCUMENT_SHELL" })]),
    );
  });

  it("wraps a fragment in the fixed document shell and hoists head content", async () => {
    const response = await fetch(new URL("/compositions/hello.html", server.url));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>Frameyard composition</title>");
    expect(html).toContain('"frameyard":"/__frameyard/framework/index.js"');
    expect(html).toContain('"frameyard/runtime":"/__frameyard/framework/runtime/index.js"');
    expect(html).toContain('"demo-lib":"./demo-lib.js"');
    expect(html).toContain("/__frameyard/framework/runtime/host.js");
    expect(html).toContain("data-fy-host");
    expect(html).toContain('<h1 data-fy-text="title"></h1>');

    expect(html.indexOf('"frameyard/runtime"')).toBeLessThan(html.indexOf('"demo-lib"'));
    expect(html.indexOf('"demo-lib"')).toBeLessThan(html.indexOf("host.js"));
    expect(html.indexOf("html, body { margin: 0")).toBeLessThan(html.indexOf("h1 { color: rgb(1, 2, 3); }"));
    expect(html.indexOf("h1 { color: rgb(1, 2, 3); }")).toBeLessThan(html.indexOf("host.js"));
    expect(html.indexOf('href="https://example.com/style.css"')).toBeGreaterThan(
      html.indexOf("h1 { color: rgb(1, 2, 3); }"),
    );

    const bodyStart = html.indexOf("<body>");
    expect(bodyStart).toBeGreaterThan(-1);
    expect(html.indexOf('data-fy="props"')).toBeGreaterThan(bodyStart);
    expect(html.indexOf("<fy-composition")).toBeGreaterThan(bodyStart);
    expect(html.indexOf('type="text/fy-controller"')).toBeGreaterThan(bodyStart);
    expect((html.match(/h1 \{ color: rgb\(1, 2, 3\); \}/g) ?? []).length).toBe(1);
  });

  it("returns a diagnostic page for a legacy full document", async () => {
    const response = await fetch(new URL("/compositions/old.html", server.url));
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain("COMPOSITION_DOCUMENT_SHELL");
    expect(html).toContain("migration-0.8.md");
  });

  it("serves an inline controller through the virtual module URL", async () => {
    const response = await fetch(new URL("/compositions/hello.html?__fy-controller", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("export default");
  });

  it("returns 404 for the virtual controller of a composition without an inline controller", async () => {
    const response = await fetch(new URL("/compositions/bad.html?__fy-controller", server.url));

    expect(response.status).toBe(404);
  });

  it("returns a diagnostic page for a statically invalid composition", async () => {
    const response = await fetch(new URL("/compositions/bad.html", server.url));
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain("SCRIPT_NOT_ALLOWED");
    expect(html).toContain("bad.html");
  });

  it("does not inject into HTML files that are not composition entries", async () => {
    const response = await fetch(new URL("/compositions/plain.html", server.url));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("data-fy-host");
    expect(html).toContain("<h1>Plain</h1>");
  });

  it("supports HEAD for injected composition HTML", async () => {
    const response = await fetch(new URL("/compositions/hello.html", server.url), { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.text()).toBe("");
  });
});
