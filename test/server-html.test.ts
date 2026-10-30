import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "../src/project.ts";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

let root: string;
let server: PreviewServer;

const helloHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">{ "title": "Hello" }</script>
  </head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="5">
      <h1 data-fy-text="title"></h1>
    </fy-composition>
    <script type="text/fy-controller">
export default {
  mount() {},
  update() {},
};
    </script>
  </body>
</html>
`;

const badHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <fy-composition width="320" height="180" fps="10" duration-in-frames="5"></fy-composition>
    <script type="module">console.log("bad")</script>
  </body>
</html>
`;

const plainHtml = `<!doctype html><html><body><h1>Plain</h1></body></html>`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-html-server-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { hello: "./compositions/hello.html", bad: "./compositions/bad.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "hello.html"), helloHtml);
  await writeFile(path.join(root, "compositions", "bad.html"), badHtml);
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
  });

  it("injects the import map, sizing style, and host into composition HTML", async () => {
    const response = await fetch(new URL("/compositions/hello.html", server.url));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('"frameyard":"/__frameyard/framework/index.js"');
    expect(html).toContain('"frameyard/runtime":"/__frameyard/framework/runtime/index.js"');
    expect(html).toContain("/__frameyard/framework/runtime/host.js");
    expect(html).toContain("data-fy-host");
    expect(html).toContain("data-fy-host-style");
    expect(html).toContain('<h1 data-fy-text="title"></h1>');
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
