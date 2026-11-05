import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshDist } from "./helpers/dist.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const fixtureFont = path.resolve("test/fixtures/fonts/space-grotesk-latin-wght-normal.woff2");
const fixtureLicense = path.resolve("test/fixtures/fonts/OFL.txt");

let server: Server;
let baseUrl: string;
let fontBytes: Buffer;
let licenseBytes: Buffer;
const temporaryDirectories: string[] = [];

const summary = {
  id: "space-grotesk",
  family: "Space Grotesk",
  subsets: ["latin", "latin-ext"],
  weights: [300, 400, 500, 600, 700],
  styles: ["normal", "italic"],
  defSubset: "latin",
  variable: true,
  lastModified: "2025-09-10",
  category: "sans-serif",
  license: "OFL-1.1",
  type: "google",
};

const otherSummary = {
  ...summary,
  id: "archivo",
  family: "Archivo",
  variable: false,
  weights: [400, 700],
  styles: ["normal"],
  subsets: ["latin"],
};

function detail(id: string) {
  if (id === "archivo") {
    return {
      ...otherSummary,
      version: "v1",
      npmVersion: "9.9.9",
      unicodeRange: { latin: "U+0000-00FF" },
      variants: {
        "400": {
          normal: {
            latin: { url: { woff2: `${baseUrl}/fontsource/fonts/archivo@9.9.9/latin-400-normal.woff2` } },
          },
        },
        "700": {
          normal: {
            latin: { url: { woff2: `${baseUrl}/fontsource/fonts/archivo@9.9.9/latin-700-normal.woff2` } },
          },
        },
      },
    };
  }
  return {
    ...summary,
    version: "v22",
    npmVersion: "9.9.9",
    unicodeRange: { latin: "U+0000-00FF", "latin-ext": "U+0100-024F" },
    variants: {
      "400": {
        normal: {
          latin: { url: { woff2: `${baseUrl}/fontsource/fonts/space-grotesk@9.9.9/latin-400-normal.woff2` } },
        },
        italic: {
          latin: { url: { woff2: `${baseUrl}/fontsource/fonts/space-grotesk@9.9.9/latin-400-italic.woff2` } },
        },
      },
      "700": {
        normal: {
          latin: { url: { woff2: `${baseUrl}/fontsource/fonts/space-grotesk@9.9.9/latin-700-normal.woff2` } },
        },
      },
    },
  };
}

function json(response: import("node:http").ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

beforeAll(async () => {
  await assertFreshDist();
  fontBytes = await readFile(fixtureFont);
  licenseBytes = await readFile(fixtureLicense);
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/fonts") {
      json(response, [summary, otherSummary]);
      return;
    }
    if (url.pathname === "/v1/fonts/space-grotesk") {
      json(response, detail("space-grotesk"));
      return;
    }
    if (url.pathname === "/v1/fonts/archivo") {
      json(response, detail("archivo"));
      return;
    }
    if (
      url.pathname === "/fontsource/fonts/space-grotesk:vf@9.9.9/latin-wght-normal.woff2" ||
      url.pathname === "/fontsource/fonts/space-grotesk:vf@9.9.9/latin-ext-wght-normal.woff2" ||
      url.pathname === "/fontsource/fonts/space-grotesk@9.9.9/latin-400-normal.woff2" ||
      url.pathname === "/fontsource/fonts/space-grotesk@9.9.9/latin-700-normal.woff2" ||
      url.pathname === "/fontsource/fonts/archivo@9.9.9/latin-400-normal.woff2" ||
      url.pathname === "/fontsource/fonts/archivo@9.9.9/latin-700-normal.woff2" ||
      url.pathname === "/font.woff2"
    ) {
      response.writeHead(200, { "content-type": "font/woff2", "content-length": fontBytes.length });
      response.end(fontBytes);
      return;
    }
    if (url.pathname === "/npm/@fontsource-variable/space-grotesk@9.9.9/metadata.json") {
      json(response, {
        variable: { wght: { min: "300", max: "700", default: "400", step: "1" } },
        license: { type: "OFL-1.1", attribution: "Space Grotesk authors" },
      });
      return;
    }
    if (url.pathname === "/npm/@fontsource-variable/space-grotesk@9.9.9/unicode.json") {
      json(response, { latin: "U+0000-00FF", "latin-ext": "U+0100-024F" });
      return;
    }
    if (
      url.pathname === "/npm/@fontsource-variable/space-grotesk@9.9.9/LICENSE" ||
      url.pathname === "/npm/@fontsource/space-grotesk@9.9.9/LICENSE"
    ) {
      response.writeHead(200, { "content-type": "text/plain", "content-length": licenseBytes.length });
      response.end(licenseBytes);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake Fontsource server did not expose a port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-fontsource-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "video.config.js"),
    `export default { format: { width: 320, height: 180, fps: 10 }, compositions: { hello: "./compositions/hello.html" } };\n`,
  );
  await writeFile(
    path.join(root, "compositions", "hello.html"),
    `<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><h1>Hola</h1></fy-composition>\n`,
  );
  return root;
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FRAMEYARD_FONTSOURCE_API: `${baseUrl}/v1`,
    FRAMEYARD_FONTSOURCE_CDN: baseUrl,
  };
}

async function run(args: string[], root: string): Promise<{ stdout: string }> {
  const result = await exec(process.execPath, [cli, ...args, "--json"], { cwd: root, env: env() });
  return { stdout: result.stdout };
}

async function failed(args: string[], root: string): Promise<{ stdout: string }> {
  return exec(process.execPath, [cli, ...args, "--json"], { cwd: root, env: env() }).then(
    () => {
      throw new Error("Expected command to fail.");
    },
    (error: unknown) => error as { stdout: string },
  );
}

describe("Fontsource acquisition", () => {
  it("searches the catalog with filters and works outside a project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frameyard-fontsource-search-"));
    temporaryDirectories.push(root);
    const result = JSON.parse(
      (await run(["font", "search", "grotesk", "--subset", "latin", "--variable", "--limit", "1"], root)).stdout,
    ) as {
      provider: string;
      results: Array<{ id: string; family: string; variable: boolean }>;
      truncated: boolean;
    };
    expect(result.provider).toBe("fontsource");
    expect(result.results).toEqual([expect.objectContaining({ id: "space-grotesk", variable: true })]);
    expect(result.truncated).toBe(false);
  });

  it("installs the variable Fontsource face with the pinned version and license", async () => {
    const root = await createProject();
    const result = JSON.parse((await run(["font", "add", "space-grotesk", "--subset", "latin"], root)).stdout) as {
      font: { provider: string; version: string; variable: boolean; license: string };
      files: string[];
      warnings: unknown[];
    };
    expect(result.font).toMatchObject({
      provider: "fontsource",
      version: "9.9.9",
      variable: true,
      license: "OFL-1.1",
    });
    expect(result.files).toEqual(["assets/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2"]);
    expect(result.warnings).toEqual([]);

    const manifest = JSON.parse(await readFile(path.join(root, "frameyard.fonts.json"), "utf8")) as {
      fonts: Array<{
        provider: string;
        providerVersion: string;
        license: { file: string; attribution?: string };
        axes: { wght: { min: number; max: number } };
        files: Array<{ weight: { min: number; max: number }; source: string; unicodeRange: string }>;
      }>;
    };
    expect(manifest.fonts[0]).toMatchObject({
      provider: "fontsource",
      providerVersion: "9.9.9",
      license: { file: "assets/fonts/space-grotesk/LICENSE.txt", attribution: "Space Grotesk authors" },
      axes: { wght: { min: 300, max: 700 } },
      files: [
        {
          weight: { min: 300, max: 700 },
          source: `${baseUrl}/fontsource/fonts/space-grotesk:vf@9.9.9/latin-wght-normal.woff2`,
          unicodeRange: "U+0000-00FF",
        },
      ],
    });

    const verified = JSON.parse((await run(["font", "verify"], root)).stdout) as {
      valid: boolean;
      diagnostics: unknown[];
    };
    expect(verified).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("installs explicit static weights in a separate project", async () => {
    const root = await createProject();
    const result = JSON.parse(
      (await run(["font", "add", "space-grotesk", "--static", "--weight", "400,700", "--subset", "latin"], root))
        .stdout,
    ) as { font: { files: number; variable: boolean }; files: string[] };
    expect(result.font).toMatchObject({ files: 2, variable: false });
    expect(result.files).toEqual([
      "assets/fonts/space-grotesk/space-grotesk-latin-400-normal.woff2",
      "assets/fonts/space-grotesk/space-grotesk-latin-700-normal.woff2",
    ]);
  });

  it("merges a second subset into an existing Fontsource family", async () => {
    const root = await createProject();
    await run(["font", "add", "space-grotesk", "--subset", "latin"], root);
    const result = JSON.parse((await run(["font", "add", "space-grotesk", "--subset", "latin-ext"], root)).stdout) as {
      font: { files: number; subsets: string[] };
      files: string[];
    };
    expect(result.font).toMatchObject({ files: 2, subsets: ["latin", "latin-ext"] });
    expect(result.files).toEqual([
      "assets/fonts/space-grotesk/space-grotesk-latin-ext-wght-normal.woff2",
      "assets/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2",
    ]);
  });

  it("downloads a loopback URL font and checks an optional hash", async () => {
    const root = await createProject();
    const added = JSON.parse(
      (
        await run(
          [
            "font",
            "add",
            "--url",
            `${baseUrl}/font.woff2`,
            "--family",
            "URL Font",
            "--license",
            "OFL-1.1",
            "--license-file",
            fixtureLicense,
          ],
          root,
        )
      ).stdout,
    ) as { font: { provider: string; family: string }; warnings: unknown[] };
    expect(added.font).toMatchObject({ provider: "url", family: "URL Font" });
    expect(added.warnings).toEqual([]);

    const mismatch = await failed(
      [
        "font",
        "add",
        "--url",
        `${baseUrl}/font.woff2`,
        "--family",
        "Other URL Font",
        "--license",
        "OFL-1.1",
        "--sha256",
        "0".repeat(64),
      ],
      root,
    );
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      ok: false,
      error: { code: "FONT_HASH_MISMATCH" },
    });
  });

  it("requires the full tier for a URL import without a license", async () => {
    const root = await createProject();
    await writeFile(path.join(root, "frameyard.policy.json"), JSON.stringify({ version: 1, policy: "authoring" }));
    const result = await failed(
      ["font", "add", "--url", `${baseUrl}/font.woff2`, "--family", "Unlicensed URL Font"],
      root,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_POLICY_BLOCKED" },
    });
  });

  it("reports an unknown Fontsource family as FONT_NOT_FOUND", async () => {
    const root = await createProject();
    const result = await failed(["font", "add", "does-not-exist"], root);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "FONT_NOT_FOUND" },
    });
  });
});
