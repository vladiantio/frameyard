import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addLocalFont,
  fontManifestPath,
  parseFontManifest,
  parseFontStyle,
  parseFontWeight,
  readFontManifest,
  removeFont,
  renderFontCss,
  verifyFontManifest,
} from "../src/fonts/index.ts";
import type { FontManifest } from "../src/fonts/types.ts";

const fixtureFont = path.resolve("test/fixtures/fonts/space-grotesk-latin-wght-normal.woff2");
const fixtureLicense = path.resolve("test/fixtures/fonts/OFL.txt");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "frameyard-fonts-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default { format: { width: 320, height: 180, fps: 10 }, compositions: { hello: "./compositions/hello.html" } };\n`,
  );
  await writeFile(
    path.join(root, "compositions", "hello.html"),
    `<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><h1>Hola</h1></fy-composition>\n`,
  );
  return root;
}

async function addFixture(root: string, overrides: Record<string, unknown> = {}) {
  return addLocalFont({
    projectRoot: root,
    file: fixtureFont,
    family: "Space Grotesk",
    id: "space-grotesk",
    weight: { min: 300, max: 700 },
    style: "normal",
    subset: "latin",
    license: "OFL-1.1",
    licenseFile: fixtureLicense,
    force: false,
    ...overrides,
  });
}

const validManifest = (): FontManifest => ({
  version: 1,
  fonts: [
    {
      id: "space-grotesk",
      family: "Space Grotesk",
      provider: "local",
      license: { type: "OFL-1.1", file: "assets/fonts/space-grotesk/OFL.txt" },
      variable: true,
      files: [
        {
          path: "assets/fonts/space-grotesk/space-grotesk.woff2",
          subset: "latin",
          style: "normal",
          weight: { min: 300, max: 700 },
          format: "woff2",
          unicodeRange: "U+0000-00FF,U+0131",
          sha256: "a".repeat(64),
          bytes: 100,
        },
      ],
    },
  ],
});

describe("font manifest schema", () => {
  it("accepts a version 1 family manifest", () => {
    expect(parseFontManifest(validManifest())).toEqual(validManifest());
  });

  it("rejects unknown versions, fields, and duplicate families", () => {
    expect(() => parseFontManifest({ ...validManifest(), version: 2 })).toThrow(/version must be 1/);
    expect(() =>
      parseFontManifest({
        ...validManifest(),
        extra: true,
      }),
    ).toThrow(/unknown field "extra"/);
    const duplicate = validManifest();
    const copy = {
      ...duplicate.fonts[0]!,
      id: "copy",
      license: { type: "OFL-1.1" },
      files: [{ ...duplicate.fonts[0]!.files[0]!, path: "assets/fonts/copy/font.woff2" }],
    };
    duplicate.fonts.push(copy);
    expect(() => parseFontManifest(duplicate)).toThrow(/duplicate CSS font-family/);
  });

  it("rejects files outside the font asset directory and invalid weights", () => {
    const outside = validManifest();
    outside.fonts[0]!.files[0]!.path = "assets/other/font.woff2";
    expect(() => parseFontManifest(outside)).toThrow(/below assets\/fonts\/space-grotesk\//);
    const weight = validManifest();
    weight.fonts[0]!.files[0]!.weight = { min: 700, max: 300 };
    expect(() => parseFontManifest(weight)).toThrow(/min <= max/);
  });
});

describe("font options and CSS", () => {
  it("parses weights, styles, and CSS urls", () => {
    expect(parseFontWeight("400")).toBe(400);
    expect(parseFontWeight("300-700")).toEqual({ min: 300, max: 700 });
    expect(parseFontStyle("italic")).toBe("italic");
    expect(() => parseFontWeight("0-100")).toThrow(/between 1 and 1000/);
  });

  it("renders a deterministic @font-face sheet", () => {
    const manifest = validManifest();
    manifest.fonts[0]!.family = `Space "Grotesk"`;
    const css = renderFontCss(manifest);
    expect(css).toContain(`font-family: "Space \\"Grotesk\\"";`);
    expect(css).toContain("font-display: block;");
    expect(css).toContain("font-weight: 300 700;");
    expect(css).toContain('format("woff2-variations")');
    expect(css).toContain("unicode-range: U+0000-00FF,U+0131;");
  });
});

describe("local font installation", () => {
  it("vendors the file and license, then merges another face", async () => {
    const root = await createProject();
    const first = await addFixture(root);
    expect(first.font).toMatchObject({
      id: "space-grotesk",
      family: "Space Grotesk",
      provider: "local",
      variable: true,
      license: "OFL-1.1",
      files: 1,
      status: "ok",
    });

    const manifest = await readFontManifest(root);
    expect(manifest?.fonts[0]?.files[0]).toMatchObject({
      path: "assets/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2",
      subset: "latin",
      style: "normal",
      weight: { min: 300, max: 700 },
    });
    const copied = await readFile(path.join(root, manifest!.fonts[0]!.files[0]!.path));
    expect(createHash("sha256").update(copied).digest("hex")).toBe(manifest!.fonts[0]!.files[0]!.sha256);
    expect((await stat(path.join(root, "assets/fonts/space-grotesk/LICENSE.txt"))).isFile()).toBe(true);

    await addFixture(root, { style: "italic", weight: 400 });
    const merged = await readFontManifest(root);
    expect(merged?.fonts).toHaveLength(1);
    expect(merged?.fonts[0]?.files).toHaveLength(2);

    await expect(addFixture(root, { style: "italic", weight: 400 })).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    await addFixture(root, { style: "italic", weight: 400, force: true });
    expect((await readFontManifest(root))?.fonts[0]?.files).toHaveLength(2);
  });

  it("warns when a local font has no license", async () => {
    const root = await createProject();
    const result = await addFixture(root, { license: undefined, licenseFile: undefined });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "FONT_LICENSE_MISSING" })]);
    expect((await readFontManifest(root))?.fonts[0]?.license.type).toBe("unknown");
  });

  it("verifies hashes, licenses, and orphaned directories", async () => {
    const root = await createProject();
    await addFixture(root);
    const manifest = (await readFontManifest(root))!;
    const valid = await verifyFontManifest({
      projectRoot: root,
      manifest,
      hashes: true,
      licenses: true,
      orphans: true,
    });
    expect(valid.valid).toBe(true);

    const filePath = path.join(root, manifest.fonts[0]!.files[0]!.path);
    await writeFile(filePath, "changed");
    const changed = await verifyFontManifest({
      projectRoot: root,
      manifest,
      hashes: true,
      licenses: true,
      orphans: false,
    });
    expect(changed.valid).toBe(false);
    expect(changed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "FONT_HASH_MISMATCH", severity: "error" })]),
    );

    await mkdir(path.join(root, "assets/fonts/orphan"), { recursive: true });
    const orphaned = await verifyFontManifest({
      projectRoot: root,
      manifest,
      hashes: false,
      licenses: false,
      orphans: true,
    });
    expect(orphaned.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "FONT_ORPHANED", severity: "warning" })]),
    );
  });

  it("removes the manifest and directory, or keeps files on request", async () => {
    const root = await createProject();
    await addFixture(root);
    const removed = await removeFont({
      projectRoot: root,
      manifest: (await readFontManifest(root))!,
      id: "space-grotesk",
      keepFiles: false,
    });
    expect(removed.id).toBe("space-grotesk");
    expect(await readFontManifest(root)).toBeUndefined();
    await expect(stat(path.join(root, removed.files[0]!))).rejects.toMatchObject({ code: "ENOENT" });

    await addFixture(root);
    await removeFont({
      projectRoot: root,
      manifest: (await readFontManifest(root))!,
      id: "space-grotesk",
      keepFiles: true,
    });
    expect(await readFontManifest(root)).toBeUndefined();
    expect((await stat(path.join(root, removed.files[0]!))).isFile()).toBe(true);
    expect(fontManifestPath(root)).toContain("fy.fonts.json");
  });
});
