import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject, resolveProjectRoot } from "../src/project.ts";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";

let root: string;

const compositionSource = `
export default {
  width: 320,
  height: 180,
  fps: 10,
  durationInFrames: 5,
  mount() {},
  update() {},
};
`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-project-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { compositions: { alpha: "./compositions/alpha.js" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "alpha.js"), compositionSource);
  await writeFile(path.join(root, "assets", "hello.txt"), "0123456789");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project configuration", () => {
  it("loads explicitly listed composition entries", async () => {
    const project = await loadProject(root);

    expect(project.root).toBe(root);
    expect(project.configPath).toBe(path.join(root, "video.config.js"));
    expect(project.compositions.get("alpha")).toEqual({
      id: "alpha",
      entry: "compositions/alpha.js",
      absoluteEntry: path.join(root, "compositions", "alpha.js"),
    });
  });

  it("finds the project root from a nested directory", async () => {
    const nested = path.join(root, "compositions");

    await expect(resolveProjectRoot(nested)).resolves.toBe(root);
  });

  it("reports a missing project configuration", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "frameyard-empty-"));
    try {
      await expect(loadProject(empty)).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("rejects entries that escape the project root", async () => {
    const bad = await mkdtemp(path.join(tmpdir(), "frameyard-bad-"));
    try {
      await writeFile(
        path.join(bad, "video.config.js"),
        `export default { compositions: { bad: "../outside.js" } };\n`,
      );
      await expect(loadProject(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  it("rejects missing composition modules", async () => {
    const bad = await mkdtemp(path.join(tmpdir(), "frameyard-missing-"));
    try {
      await writeFile(
        path.join(bad, "video.config.js"),
        `export default { compositions: { missing: "./compositions/missing.js" } };\n`,
      );
      await expect(loadProject(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe("preview server", () => {
  let server: PreviewServer;

  beforeAll(async () => {
    server = await startPreviewServer({ projectRoot: root, port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves the preview page with a framework import map", async () => {
    const response = await fetch(new URL("/__frameyard/", server.url));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('"frameyard": "/__frameyard/framework/index.js"');
    expect(html).toContain('"frameyard/runtime": "/__frameyard/framework/runtime/index.js"');
    expect(html).toContain("/__frameyard/framework/preview/main.js");
  });

  it("publishes the explicit composition list", async () => {
    const response = await fetch(new URL("/__frameyard/project.json", server.url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      compositions: [{ id: "alpha", entry: "compositions/alpha.js" }],
    });
  });

  it("serves composition modules and assets from the project root", async () => {
    const moduleResponse = await fetch(new URL("/compositions/alpha.js", server.url));
    const assetResponse = await fetch(new URL("/assets/hello.txt", server.url));

    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("content-type")).toContain("text/javascript");
    expect(await moduleResponse.text()).toContain("durationInFrames: 5");
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe("0123456789");
  });

  it("serves the built framework runtime", async () => {
    const response = await fetch(new URL("/__frameyard/framework/runtime/random.js", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("export function random");
  });

  it("supports byte ranges for seekable audio", async () => {
    const response = await fetch(new URL("/assets/hello.txt", server.url), {
      headers: { Range: "bytes=2-4" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("234");
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const response = await fetch(new URL("/assets/hello.txt", server.url), {
      headers: { Range: "bytes=20-30" },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("does not serve paths outside the project", async () => {
    const response = await fetch(new URL("/..%2f..%2fetc%2fpasswd", server.url));

    expect([403, 404]).toContain(response.status);
  });

  it("returns 404 for missing files", async () => {
    const response = await fetch(new URL("/assets/missing.txt", server.url));

    expect(response.status).toBe(404);
  });

  it("redirects the root to the preview", async () => {
    const response = await fetch(new URL("/", server.url), { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/__frameyard/");
  });
});
