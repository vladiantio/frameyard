import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/server/server.ts";
import { assertFreshDist } from "./helpers/dist.ts";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const fixtureFont = path.resolve("test/fixtures/fonts/space-grotesk-latin-wght-normal.woff2");
const fixtureLicense = path.resolve("test/fixtures/fonts/OFL.txt");

let root: string;
let server: PreviewServer;

const composition = `<style>
  h1 { font-family: "Space Grotesk", system-ui, sans-serif; font-size: 44px; margin: 20px; }
</style>
<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <h1>Hola</h1>
</fy-composition>
`;

async function run(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await exec(process.execPath, [cli, ...args, "--project", options.cwd ?? root], {
    cwd: options.cwd ?? root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  await assertFreshDist();
  root = await mkdtemp(path.join(tmpdir(), "frameyard-fonts-e2e-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { format: { width: 320, height: 180, fps: 10 }, compositions: { hello: "./compositions/hello.html" } };\n`,
  );
  await writeFile(path.join(root, "compositions", "hello.html"), composition);
  server = await startPreviewServer({ projectRoot: root, port: 0 });
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("project fonts", () => {
  it("installs a local font, lists it, verifies it, and exposes it in context", async () => {
    const added = await run([
      "font",
      "add",
      "--file",
      fixtureFont,
      "--family",
      "Space Grotesk",
      "--id",
      "space-grotesk",
      "--weight",
      "300-700",
      "--subset",
      "latin",
      "--license",
      "OFL-1.1",
      "--license-file",
      fixtureLicense,
      "--json",
    ]);
    const addResult = JSON.parse(added.stdout) as {
      ok: boolean;
      font: { id: string; family: string; status: string };
      files: string[];
      warnings: unknown[];
    };
    expect(addResult).toMatchObject({
      ok: true,
      font: { id: "space-grotesk", family: "Space Grotesk", status: "ok" },
      warnings: [],
    });

    const listed = JSON.parse((await run(["font", "list", "--json"])).stdout) as {
      fonts: Array<{ id: string; status: string; license: string }>;
    };
    expect(listed.fonts).toEqual([expect.objectContaining({ id: "space-grotesk", status: "ok", license: "OFL-1.1" })]);

    const verified = JSON.parse((await run(["font", "verify", "--json"])).stdout) as {
      valid: boolean;
      diagnostics: unknown[];
    };
    expect(verified).toMatchObject({ valid: true, diagnostics: [] });

    const context = JSON.parse((await run(["context", "--json"])).stdout) as {
      fonts: Array<{ id: string; status: string }>;
      truncated: { fonts: boolean };
    };
    expect(context.fonts).toEqual([expect.objectContaining({ id: "space-grotesk", status: "ok" })]);
    expect(context.truncated.fonts).toBe(false);
  });

  it("serves the generated font sheet and injects it into composition documents", async () => {
    const cssResponse = await fetch(new URL("/__frameyard/fonts.css", server.url));
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get("content-type")).toContain("text/css");
    const css = await cssResponse.text();
    expect(css).toContain("@font-face");
    expect(css).toContain('font-family: "Space Grotesk"');
    expect(css).toContain("font-display: block");
    expect(css).toContain("font-weight: 300 700");
    expect(css).toContain("/assets/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2");

    const htmlResponse = await fetch(new URL("/compositions/hello.html", server.url));
    const html = await htmlResponse.text();
    expect(html).toContain('href="/__frameyard/fonts.css"');
  });

  it("captures the same still twice and rejects a modified font file", async () => {
    const first = path.join(root, "first.png");
    const second = path.join(root, "second.png");
    await run(["still", "hello", "--frame", "0", "--out", first, "--json"]);
    await run(["still", "hello", "--frame", "0", "--out", second, "--json"]);
    const compared = await exec(process.execPath, [cli, "compare", first, second, "--json"], { cwd: root });
    expect(JSON.parse(compared.stdout)).toMatchObject({ ok: true, identical: true });

    const manifest = JSON.parse(await readFile(path.join(root, "fy.fonts.json"), "utf8")) as {
      fonts: Array<{ files: Array<{ path: string }> }>;
    };
    const fontPath = path.join(root, manifest.fonts[0]!.files[0]!.path);
    const original = await readFile(fontPath);
    await writeFile(fontPath, Buffer.concat([original, Buffer.from("tamper")]));
    const failure = await exec(process.execPath, [cli, "still", "hello", "--frame", "0", "--json"], {
      cwd: root,
    }).then(
      () => undefined,
      (error: unknown) => error as { stdout?: string; stderr?: string },
    );
    expect(failure).toBeDefined();
    const envelope = JSON.parse(failure!.stdout ?? "{}") as { ok: boolean; error?: { code: string } };
    expect(envelope).toMatchObject({ ok: false, error: { code: "FONT_HASH_MISMATCH" } });
    await writeFile(fontPath, original);
  });

  it("reports a malformed manifest from font verify instead of failing to load the project", async () => {
    const manifestPath = path.join(root, "fy.fonts.json");
    const original = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ version: 1, fonts: [], extra: true }, null, 2));

    const failure = await exec(process.execPath, [cli, "font", "verify", "--project", root, "--json"], {
      cwd: root,
    }).then(
      () => undefined,
      (error: unknown) => error as { stdout?: string; stderr?: string; code?: number },
    );
    expect(failure).toBeDefined();
    const result = JSON.parse(failure!.stdout ?? "{}") as {
      ok: boolean;
      action: string;
      valid: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(result).toMatchObject({
      ok: true,
      action: "verify",
      valid: false,
      diagnostics: [expect.objectContaining({ code: "FONT_MANIFEST_INVALID" })],
    });
    expect(failure!.code).toBe(1);
    await writeFile(manifestPath, original);
  });

  it("fails a used face that cannot load", async () => {
    const missingRoot = await mkdtemp(path.join(tmpdir(), "frameyard-fonts-missing-"));
    try {
      await mkdir(path.join(missingRoot, "compositions"), { recursive: true });
      await writeFile(
        path.join(missingRoot, "fy.config.js"),
        `export default { format: { width: 320, height: 180, fps: 10 }, compositions: { missing: "./compositions/missing.html" } };\n`,
      );
      await writeFile(
        path.join(missingRoot, "compositions", "missing.html"),
        `<style>@font-face { font-family: "Missing"; src: url("/assets/missing.woff2") format("woff2"); } h1 { font-family: "Missing"; }</style>
<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><h1>Hola</h1></fy-composition>\n`,
      );
      const failure = await exec(
        process.execPath,
        [cli, "still", "missing", "--frame", "0", "--project", missingRoot, "--json"],
        { cwd: missingRoot },
      ).then(
        () => undefined,
        (error: unknown) => error as { stdout?: string },
      );
      expect(failure).toBeDefined();
      const envelope = JSON.parse(failure!.stdout ?? "{}") as { ok: boolean; error?: { code: string } };
      expect(envelope).toMatchObject({ ok: false, error: { code: "FONT_LOAD_FAILED" } });
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }
  });

  it("gates font removal and forced replacement with the resource policy", async () => {
    const policyPath = path.join(root, "fy.policy.json");
    await writeFile(policyPath, JSON.stringify({ version: 1, policy: "authoring" }, null, 2));
    try {
      const removeFailure = await exec(
        process.execPath,
        [cli, "font", "remove", "space-grotesk", "--project", root, "--json"],
        { cwd: root },
      ).then(
        () => undefined,
        (error: unknown) => error as { stdout?: string },
      );
      expect(removeFailure).toBeDefined();
      const removeResult = JSON.parse(removeFailure!.stdout ?? "{}") as {
        ok: boolean;
        error?: { code: string };
      };
      expect(removeResult).toMatchObject({ ok: false, error: { code: "RESOURCE_POLICY_BLOCKED" } });

      const forceFailure = await exec(
        process.execPath,
        [
          cli,
          "font",
          "add",
          "--file",
          fixtureFont,
          "--family",
          "Space Grotesk",
          "--id",
          "space-grotesk",
          "--weight",
          "300-700",
          "--license",
          "OFL-1.1",
          "--license-file",
          fixtureLicense,
          "--force",
          "--project",
          root,
          "--json",
        ],
        { cwd: root },
      ).then(
        () => undefined,
        (error: unknown) => error as { stdout?: string },
      );
      expect(forceFailure).toBeDefined();
      const forceResult = JSON.parse(forceFailure!.stdout ?? "{}") as {
        ok: boolean;
        error?: { code: string };
      };
      expect(forceResult).toMatchObject({ ok: false, error: { code: "RESOURCE_POLICY_BLOCKED" } });
    } finally {
      await rm(policyPath, { force: true });
    }
  });
});
