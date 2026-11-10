import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateHtmlComposition } from "../src/html/validate.ts";

let root: string;

const transcript = {
  schemaVersion: 1,
  text: "Hello",
  source: { path: "assets/tone.wav", sha256: "a".repeat(64), bytes: 0 },
  segments: [{ startMs: 0, endMs: 1000, text: "Hello" }],
  words: [{ startMs: 0, endMs: 500, text: "Hello" }],
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "frameyard-html-"));
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "tone.wav"), "");
  await writeFile(path.join(root, "assets", "voice.transcript.json"), JSON.stringify(transcript));
  await writeFile(
    path.join(root, "compositions", "hello.controller.js"),
    "export default { mount() {}, update() {} };\n",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function fragmentHtml(options: { root?: string; top?: string; body?: string; props?: string | false } = {}): string {
  const rootMarkup =
    options.root ??
    `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
      <h1 data-fy-text="title" data-fy-anim-start="0" data-fy-anim-duration="5"></h1>
      <p data-fy-if="show" data-fy-text="subtitle"></p>
      <template data-fy-repeat="items">
        <span data-fy-text="item.label" data-fy-attr-data-index="index"></span>
      </template>
      <audio src="assets/tone.wav" data-fy-start="0"></audio>
      <fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
    </fy-composition>`;

  const props =
    options.props === false
      ? ""
      : (options.props ??
        `<script type="application/json" data-fy="props">
  { "title": "Hello", "accent": "#b8f36b", "show": true, "items": [{ "label": "A" }, { "label": "B" }] }
  </script>`);

  return `${props}
  ${options.top ?? ""}
  ${rootMarkup}
  ${options.body ?? '<script type="text/fy-controller" src="./hello.controller.js"></script>'}`;
}

function documentHtml(options: { root?: string; top?: string; body?: string } = {}): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>${fragmentHtml(options)}</body>
</html>`;
}

async function validate(
  name: string,
  html: string,
  props?: unknown,
  format?: { width: number; height: number; fps: number },
) {
  const entry = `compositions/${name}.html`;
  await writeFile(path.join(root, entry), html);
  return validateHtmlComposition({ projectRoot: root, entry, props, ...(format ? { format } : {}) });
}

async function writePartial(name: string, html: string): Promise<void> {
  const directory = path.join(root, "compositions", "partials");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), html);
}

describe("HTML composition static validation", () => {
  it("warns once per remote font or stylesheet URL", async () => {
    const result = await validate(
      "remote-fonts",
      fragmentHtml({
        top: `<style>
  @import url("https://fonts.googleapis.com/css2?family=Inter");
  @font-face { font-family: Remote; src: url(https://cdn.example.com/remote.woff2) format("woff2"); }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">`,
      }),
    );

    const remote = result.diagnostics.filter((diagnostic) => diagnostic.code === "FONT_REMOTE");
    expect(remote).toHaveLength(3);
    expect(remote.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });

  it("validates a complete composition and resolves metadata, controller, and clips", async () => {
    const result = await validate("valid", fragmentHtml());

    expect(result.info).not.toBeNull();
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "BINDING_PATH_MISSING",
        details: expect.objectContaining({ value: "subtitle" }),
        fix: expect.objectContaining({
          kind: "path",
          from: "subtitle",
          message: expect.stringContaining("subtitle"),
          docs: expect.any(String),
        }),
      }),
    );
    expect(result.info?.metadata).toEqual({ width: 320, height: 180, fps: 10, durationInFrames: 5 });
    expect(result.info?.declaredFormat).toEqual({ width: 320, height: 180, fps: 10 });
    expect(result.info?.defaultProps).toMatchObject({ title: "Hello", accent: "#b8f36b" });
    expect(result.info?.controller).toMatchObject({
      kind: "external",
      src: "compositions/hello.controller.js",
    });
    expect(result.info?.audioClips).toHaveLength(1);
    expect(result.info?.audioClips[0]).toMatchObject({
      src: "assets/tone.wav",
      startFrame: 0,
      trimStart: 0,
      volume: 1,
    });
    expect(result.info?.embeddedAudioClips).toEqual([]);
    expect(result.info?.transcriptClips).toEqual([{ src: "assets/voice.transcript.json", words: true }]);
  });

  it("accepts a fragment without a document shell", async () => {
    const result = await validate("fragment", fragmentHtml());

    expect(result.info).not.toBeNull();
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "COMPOSITION_DOCUMENT_SHELL" }));
  });

  it("rejects a full document with COMPOSITION_DOCUMENT_SHELL and no info", async () => {
    const result = await validate("full-document", documentHtml());

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "COMPOSITION_DOCUMENT_SHELL",
        details: expect.objectContaining({
          path: "compositions/full-document.html",
          suggestion: expect.stringContaining("migration-0.8.md"),
        }),
      }),
    );
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "COMPOSITION_DOCUMENT_SHELL")).toHaveLength(4);
  });

  it("reports invalid metadata with an attribute location", async () => {
    const result = await validate(
      "bad-metadata",
      fragmentHtml({
        root: '<fy-composition width="0" height="180" fps="10" duration-in-frames="5"></fy-composition>',
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "COMPOSITION_INVALID",
        details: expect.objectContaining({ attribute: "width", value: "0" }),
      }),
    );
  });

  it("inherits width, height, and fps from the project format", async () => {
    const result = await validate(
      "inherited-format",
      fragmentHtml({ root: '<fy-composition duration-in-frames="5"></fy-composition>' }),
      undefined,
      { width: 640, height: 360, fps: 24 },
    );

    expect(result.formatUnresolved).toBe(false);
    expect(result.info?.metadata).toEqual({ width: 640, height: 360, fps: 24, durationInFrames: 5 });
    expect(result.info?.declaredFormat).toEqual({ width: null, height: null, fps: null });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("prefers declared format values over the project format", async () => {
    const result = await validate(
      "declared-format",
      fragmentHtml({ root: '<fy-composition width="320" height="180" duration-in-frames="5"></fy-composition>' }),
      undefined,
      { width: 640, height: 360, fps: 24 },
    );

    expect(result.info?.metadata).toEqual({ width: 320, height: 180, fps: 24, durationInFrames: 5 });
    expect(result.info?.declaredFormat).toEqual({ width: 320, height: 180, fps: null });
  });

  it("flags an unresolved format without a document diagnostic", async () => {
    const result = await validate(
      "unresolved-format",
      fragmentHtml({ root: '<fy-composition duration-in-frames="5"></fy-composition>' }),
    );

    expect(result.info).toBeNull();
    expect(result.formatUnresolved).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("rejects declaring width without height", async () => {
    const result = await validate(
      "half-format",
      fragmentHtml({ root: '<fy-composition width="320" duration-in-frames="5"></fy-composition>' }),
      undefined,
      { width: 640, height: 360, fps: 24 },
    );

    expect(result.info).toBeNull();
    expect(result.formatUnresolved).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("declared together"),
      }),
    );
  });

  it("warns on missing binding paths with a suggestion", async () => {
    const result = await validate(
      "missing-path",
      fragmentHtml({
        root: '<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><h1 data-fy-text="titel"></h1></fy-composition>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "BINDING_PATH_MISSING",
        details: expect.objectContaining({ value: "titel", suggestion: "title" }),
      }),
    );
  });

  it("validates attribute and class bindings", async () => {
    const result = await validate(
      "attr-class",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <div data-fy-class-active="show" data-fy-attr-title="title"></div>
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("resolves props-bound media sources", async () => {
    const result = await validate(
      "bound-media",
      fragmentHtml({
        root: '<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><audio data-fy-attr-src="voice"></audio></fy-composition>',
      }),
      { voice: "assets/tone.wav" },
    );

    expect(result.info?.audioClips[0]).toMatchObject({ src: "assets/tone.wav" });
  });

  it("rejects event handler bindings, root conditionals, and text on void elements", async () => {
    const result = await validate(
      "bad-targets",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5" data-fy-if="show">
          <div data-fy-attr-onclick="show"></div>
          <img data-fy-text="title">
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "BINDING_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "EVENT_HANDLER_NOT_ALLOWED" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "BINDING_TARGET_INVALID" }));
  });

  it("rejects invalid repeat paths, animation values, and media attributes on non-media", async () => {
    const result = await validate(
      "bad-attributes",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <template data-fy-repeat="missing"></template>
          <h1 data-fy-anim-start="-1"></h1>
          <div data-fy-start="0"></div>
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "BINDING_REPEAT_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ANIMATION_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "MEDIA_INVALID" }));
  });

  it("accepts animation presets and rejects unknown preset names with a fix", async () => {
    const valid = await validate(
      "preset-valid",
      fragmentHtml({
        props: false,
        body: "",
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <div data-fy-anim-preset="fade-up" data-fy-anim-start="0" data-fy-anim-duration="5" data-fy-anim-easing="ease-out"></div>
</fy-composition>`,
      }),
    );
    expect(valid.info).not.toBeNull();
    expect(valid.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const invalid = await validate(
      "preset-invalid",
      fragmentHtml({
        props: false,
        body: "",
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <div data-fy-anim-preset="zoom"></div>
</fy-composition>`,
      }),
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "ANIMATION_INVALID",
        details: expect.objectContaining({
          attribute: "data-fy-anim-preset",
          value: "zoom",
        }),
        fix: expect.objectContaining({
          kind: "value",
          message: expect.stringContaining("fade-up"),
          docs: expect.stringContaining("deterministic-authoring.md"),
        }),
      }),
    );
  });

  it("rejects animation presets in a static composition", async () => {
    const result = await validate(
      "static-preset",
      `<fy-composition width="320" height="180">
  <div data-fy-anim-preset="fade"></div>
</fy-composition>`,
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "STATIC_ANIMATION_UNSUPPORTED" }),
    );
  });

  it("rejects unknown data-fy attributes", async () => {
    const result = await validate(
      "unknown-attribute",
      fragmentHtml({
        root: '<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><h1 data-fy-txt="title"></h1></fy-composition>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "BINDING_INVALID",
        details: expect.objectContaining({ attribute: "data-fy-txt" }),
      }),
    );
  });

  it("rejects repeat misuse", async () => {
    const result = await validate(
      "bad-repeat",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <div data-fy-repeat="items"></div>
          <template data-fy-repeat="items"><template data-fy-repeat="items"></template></template>
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BINDING_REPEAT_INVALID", details: expect.objectContaining({ element: "div" }) }),
    );
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "BINDING_REPEAT_NESTED" }));
  });

  it("rejects executable scripts, event handlers, and javascript URLs", async () => {
    const result = await validate(
      "scripts",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <div onclick="alert(1)"><a href="javascript:alert(1)">x</a></div>
        </fy-composition>`,
        body: '<script type="module">console.log("no")</script>',
      }),
    );

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT_NOT_ALLOWED" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "EVENT_HANDLER_NOT_ALLOWED" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "URL_NOT_ALLOWED" }));
  });

  it("rejects unsupported visual elements and document features", async () => {
    const result = await validate(
      "unsupported",
      fragmentHtml({
        top: '<base href="/"><meta http-equiv="refresh" content="0">',
        root: '<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><iframe src="x"></iframe></fy-composition>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ELEMENT_NOT_SUPPORTED", details: expect.objectContaining({ element: "base" }) }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "ELEMENT_NOT_SUPPORTED",
        details: expect.objectContaining({ element: "iframe" }),
      }),
    );
  });

  it("supports inline controllers and reports their source location", async () => {
    const result = await validate(
      "inline-controller",
      fragmentHtml({
        body: `<script type="text/fy-controller">
export default {
  mount() {},
  update() {},
};
</script>`,
      }),
    );

    expect(result.info?.controller).toMatchObject({ kind: "inline" });
    expect(result.info?.controller?.line).toBeGreaterThan(1);
    expect(result.info?.controller?.column).toBeGreaterThan(0);
  });

  it("rejects a controller with both inline source and src", async () => {
    const result = await validate(
      "both-controllers",
      fragmentHtml({
        body: '<script type="text/fy-controller" src="./hello.controller.js">export default {};</script>',
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONTROLLER_INVALID" }));
  });

  it("rejects a missing external controller file", async () => {
    const result = await validate(
      "missing-controller",
      fragmentHtml({ body: '<script type="text/fy-controller" src="./missing.js"></script>' }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONTROLLER_INVALID" }));
  });

  it("rejects missing or remote media and transcripts", async () => {
    const result = await validate(
      "missing-media",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <audio src="assets/missing.wav"></audio>
          <audio src="https://example.com/tone.wav"></audio>
          <fy-transcript src="assets/missing.json"></fy-transcript>
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "MEDIA_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TRANSCRIPT_INVALID" }));
  });

  it("warns on visual content outside the composition root", async () => {
    const result = await validate(
      "outside-root",
      fragmentHtml({
        body: '<p>Outside</p><script type="text/fy-controller" src="./hello.controller.js"></script>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "CONTENT_OUTSIDE_ROOT" }),
    );
  });

  it("requires the composition root to be top-level", async () => {
    const result = await validate(
      "nested-root",
      fragmentHtml({
        root: '<div><fy-composition width="320" height="180" fps="10" duration-in-frames="5"></fy-composition></div>',
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("top-level element"),
      }),
    );
  });

  it("requires the props block to be top-level", async () => {
    const result = await validate(
      "nested-props",
      fragmentHtml({
        props: false,
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <script type="application/json" data-fy="props">{ "title": "Hello" }</script>
        </fy-composition>`,
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        message: expect.stringContaining("top-level element"),
      }),
    );
  });

  it("validates props against a declared schema and applies schema defaults", async () => {
    const result = await validate(
      "schema-valid",
      fragmentHtml({
        top: `<script type="application/json" data-fy="props-schema">
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "accent": { "type": "string", "enum": ["lime", "orange"], "default": "lime" },
    "palette": {
      "type": "object",
      "default": {},
      "properties": {
        "background": { "type": "string", "default": "#080b10" }
      }
    }
  },
  "required": ["title"]
}
</script>`,
        props: `<script type="application/json" data-fy="props">{ "title": "Document" }</script>`,
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <h1 data-fy-text="title"></h1>
</fy-composition>`,
        body: "",
      }),
    );

    expect(result.info).not.toBeNull();
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.info?.propsSchema).toMatchObject({
      type: "object",
      required: ["title"],
      properties: {
        accent: { type: "string", enum: ["lime", "orange"], default: "lime" },
      },
    });
    expect(result.info?.defaultProps).toMatchObject({
      title: "Document",
      accent: "lime",
      palette: { background: "#080b10" },
    });
  });

  it("reports missing, mistyped, enum, and nested schema failures", async () => {
    const schema = `<script type="application/json" data-fy="props-schema">
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "accent": { "type": "string", "enum": ["lime", "orange"] },
    "palette": {
      "type": "object",
      "properties": { "foreground": { "type": "string" } },
      "required": ["foreground"]
    }
  },
  "required": ["title"]
}
</script>`;
    const root = `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
  <h1 data-fy-text="title"></h1>
</fy-composition>`;

    const missing = await validate("schema-missing", fragmentHtml({ top: schema, props: false, root, body: "" }), {
      accent: "lime",
    });
    expect(missing.info).toBeNull();
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({ path: "title", suggestion: expect.stringContaining("title") }),
      }),
    );

    const mistyped = await validate("schema-mistyped", fragmentHtml({ top: schema, props: false, root, body: "" }), {
      title: 3,
      accent: "lime",
    });
    expect(mistyped.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({ path: "title" }),
      }),
    );

    const invalidEnum = await validate("schema-enum", fragmentHtml({ top: schema, props: false, root, body: "" }), {
      title: "A",
      accent: "blue",
    });
    expect(invalidEnum.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({ path: "accent" }),
      }),
    );

    const nested = await validate("schema-nested", fragmentHtml({ top: schema, props: false, root, body: "" }), {
      title: "A",
      accent: "lime",
      palette: {},
    });
    expect(nested.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({ path: "palette.foreground" }),
      }),
    );
  });

  it("reports malformed props schemas with a source location", async () => {
    const result = await validate(
      "schema-malformed",
      fragmentHtml({
        top: `<script type="application/json" data-fy="props-schema">
{ "type": "object", "properties": { "title": { "type": "wat" } } }
</script>`,
        props: false,
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5"></fy-composition>`,
        body: "",
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID_SCHEMA",
        details: expect.objectContaining({
          path: "compositions/schema-malformed.html",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      }),
    );
  });

  it("requires the controller block to be top-level", async () => {
    const result = await validate(
      "nested-controller",
      fragmentHtml({
        body: "",
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <script type="text/fy-controller">export default { update() {} };</script>
        </fy-composition>`,
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("top-level element"),
      }),
    );
  });

  it("accepts a top-level import map", async () => {
    const result = await validate(
      "import-map",
      fragmentHtml({
        top: '<script type="importmap">{"imports":{"demo-lib":"./demo-lib.js"}}</script>',
      }),
    );

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("rejects nested import maps", async () => {
    const result = await validate(
      "nested-import-map",
      fragmentHtml({
        root: `<fy-composition width="320" height="180" fps="10" duration-in-frames="5">
          <script type="importmap">{"imports":{"demo-lib":"./demo-lib.js"}}</script>
        </fy-composition>`,
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "IMPORT_MAP_INVALID",
        message: expect.stringContaining("top-level"),
      }),
    );
  });

  it("rejects invalid import map JSON and reserved specifiers", async () => {
    const invalidJson = await validate(
      "invalid-import-map",
      fragmentHtml({ top: '<script type="importmap">{</script>' }),
    );
    expect(invalidJson.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "IMPORT_MAP_INVALID",
        message: expect.stringContaining("Invalid import map JSON"),
      }),
    );

    const reserved = await validate(
      "reserved-import-map",
      fragmentHtml({
        top: '<script type="importmap">{"imports":{"frameyard/runtime":"./runtime.js"}}</script>',
      }),
    );
    expect(reserved.diagnostics).toContainEqual(
      expect.objectContaining({ code: "IMPORT_MAP_INVALID", message: expect.stringContaining("reserved") }),
    );

    const forbidden = await validate(
      "import-map-src",
      fragmentHtml({ top: '<script type="importmap" src="./map.json"></script>' }),
    );
    expect(forbidden.diagnostics).toContainEqual(
      expect.objectContaining({ code: "IMPORT_MAP_INVALID", message: expect.stringContaining('"src" attribute') }),
    );
  });

  it("rejects document-level title and meta elements", async () => {
    const result = await validate(
      "document-level-elements",
      fragmentHtml({ top: '<title>Hello</title><meta name="theme-color" content="#000">' }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "ELEMENT_NOT_SUPPORTED",
        details: expect.objectContaining({ element: "title" }),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "ELEMENT_NOT_SUPPORTED",
        details: expect.objectContaining({ element: "meta" }),
      }),
    );
  });

  it("reserves data-fy-host and data-fy=format", async () => {
    const result = await validate(
      "reserved-attributes",
      fragmentHtml({
        top: '<script type="application/json" data-fy="format" data-fy-host>{"width":1}</script>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("data-fy-host"),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining('data-fy="format"'),
      }),
    );
  });
});

describe("static composition validation", () => {
  it("resolves a composition without duration or fps as static", async () => {
    const result = await validate("static", '<fy-composition width="320" height="180"><p>Still</p></fy-composition>');

    expect(result.info?.metadata).toEqual({ width: 320, height: 180, static: true });
    expect(result.formatUnresolved).toBe(false);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("requires duration-in-frames when fps is declared", async () => {
    const result = await validate("static-fps", '<fy-composition width="320" height="180" fps="10"></fy-composition>');

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("duration-in-frames"),
      }),
    );
  });

  it("rejects time drivers and media on a static composition", async () => {
    const result = await validate(
      "static-drivers",
      `<fy-composition width="320" height="180">
        <div data-fy-anim-start="0"></div>
        <audio src="assets/tone.wav"></audio>
        <fy-transcript src="assets/voice.transcript.json" words></fy-transcript>
      </fy-composition>`,
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "STATIC_ANIMATION_UNSUPPORTED" }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "STATIC_MEDIA_UNSUPPORTED" }),
    );
  });

  it("inherits dimensions for a static composition from the project format", async () => {
    const result = await validate("static-inherit", "<fy-composition></fy-composition>", undefined, {
      width: 640,
      height: 360,
      fps: 30,
    });

    expect(result.info?.metadata).toEqual({ width: 640, height: 360, static: true });
    expect(result.formatUnresolved).toBe(false);
  });

  it("reports an unresolved format when a static composition has no dimensions or project format", async () => {
    const result = await validate("static-noformat", "<fy-composition></fy-composition>");

    expect(result.info).toBeNull();
    expect(result.formatUnresolved).toBe(true);
  });
});

describe("composition includes", () => {
  it("expands repeated partials with scoped props, styles, and host attributes", async () => {
    await writePartial(
      "badge.html",
      `<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <script type="application/json" data-fy="props-schema">
  { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }
  </script>
  <style>.badge { color: red; }</style>
  <span class="badge" data-fy-text="label"></span>
</fy-partial>`,
    );

    const result = await validate(
      "includes",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/badge.html" props='{"label":"Live"}'></fy-include>
  <fy-include src="./partials/badge.html" props='{"label":"Replay"}' class="replay"></fy-include>
</fy-composition>`,
    );

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.expandedFragment).toContain('data-fy-include="include-1"');
    expect(result.expandedFragment).toContain('data-fy-include="include-2"');
    expect(result.expandedFragment).toContain('data-fy-props="{&quot;label&quot;:&quot;Live&quot;}"');
    expect(result.expandedFragment).toContain('data-fy-props="{&quot;label&quot;:&quot;Replay&quot;}"');
    expect(result.expandedFragment).toContain('class="replay"');
    expect(result.expandedFragment).toContain('@scope ([data-fy-include="include-1"]) to ([data-fy-include])');
    expect(result.expandedFragment).toContain('@scope ([data-fy-include="include-2"]) to ([data-fy-include])');
    expect(result.expandedFragment).toContain("data-fy-source-line");
  });

  it("scopes included bindings to the include props and reports the partial path and line", async () => {
    await writePartial(
      "scope.html",
      `<fy-partial>
  <script type="application/json" data-fy="props">{ "label": "Idle" }</script>
  <span data-fy-text="label"></span>
  <span data-fy-text="parentOnly"></span>
</fy-partial>`,
    );

    const result = await validate(
      "include-scope",
      `<script type="application/json" data-fy="props">{ "parentOnly": "parent" }</script>
<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/scope.html"></fy-include>
</fy-composition>`,
    );

    const missing = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "BINDING_PATH_MISSING" && diagnostic.details?.value === "parentOnly",
    );
    expect(missing).toMatchObject({
      severity: "warning",
      code: "BINDING_PATH_MISSING",
      details: {
        path: "compositions/partials/scope.html",
        element: "span",
        value: "parentOnly",
        includeChain: ["compositions/include-scope.html", "compositions/partials/scope.html"],
      },
    });
    expect(missing?.details?.line).toBeGreaterThan(0);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.details?.value === "label")).toEqual([]);
  });

  it("validates include props against the partial schema", async () => {
    await writePartial(
      "required.html",
      `<fy-partial>
  <script type="application/json" data-fy="props-schema">
  { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }
  </script>
  <span data-fy-text="title"></span>
</fy-partial>`,
    );

    const invalid = await validate(
      "include-required",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/required.html"></fy-include>
</fy-composition>`,
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_SCHEMA_INVALID",
        details: expect.objectContaining({
          path: "compositions/partials/required.html",
          value: "title",
        }),
      }),
    );

    const valid = await validate(
      "include-required-valid",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/required.html" props='{"title":"Provided"}'></fy-include>
</fy-composition>`,
    );
    expect(valid.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("reports nested include chains on binding diagnostics", async () => {
    await writePartial(
      "nested-outer.html",
      `<fy-partial>
  <fy-include src="./nested-inner.html"></fy-include>
</fy-partial>`,
    );
    await writePartial(
      "nested-inner.html",
      `<fy-partial>
  <span data-fy-text="missing"></span>
</fy-partial>`,
    );

    const result = await validate(
      "include-nested-chain",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/nested-outer.html"></fy-include>
</fy-composition>`,
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BINDING_PATH_MISSING",
        details: expect.objectContaining({
          path: "compositions/partials/nested-inner.html",
          value: "missing",
          includeChain: [
            "compositions/include-nested-chain.html",
            "compositions/partials/nested-outer.html",
            "compositions/partials/nested-inner.html",
          ],
        }),
      }),
    );
  });

  it("resolves nested includes and reports a missing target with the include chain", async () => {
    await writePartial(
      "outer.html",
      `<fy-partial>
  <fy-include src="./inner.html"></fy-include>
</fy-partial>`,
    );

    const result = await validate(
      "include-missing",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/outer.html"></fy-include>
</fy-composition>`,
    );

    const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "INCLUDE_NOT_FOUND");
    expect(missing).toMatchObject({
      severity: "error",
      code: "INCLUDE_NOT_FOUND",
      details: {
        path: "compositions/partials/outer.html",
        line: expect.any(Number),
        includeChain: [
          "compositions/include-missing.html",
          "compositions/partials/outer.html",
          "compositions/partials/inner.html",
        ],
      },
    });
  });

  it("rejects include cycles and invalid partial shapes", async () => {
    await writePartial("a.html", `<fy-partial><fy-include src="./b.html"></fy-include></fy-partial>`);
    await writePartial("b.html", `<fy-partial><fy-include src="./a.html"></fy-include></fy-partial>`);
    await writePartial("flat.html", `<div>not a partial</div>`);

    const cycle = await validate(
      "include-cycle",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/a.html"></fy-include>
</fy-composition>`,
    );
    expect(cycle.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "INCLUDE_CYCLE",
        details: expect.objectContaining({
          includeChain: [
            "compositions/include-cycle.html",
            "compositions/partials/a.html",
            "compositions/partials/b.html",
            "compositions/partials/a.html",
          ],
        }),
      }),
    );

    const invalid = await validate(
      "include-invalid",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/flat.html"></fy-include>
</fy-composition>`,
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "INCLUDE_INVALID",
        details: expect.objectContaining({ path: "compositions/partials/flat.html" }),
      }),
    );
  });

  it("rejects a literal <fy-partial> in a composition", async () => {
    const result = await validate(
      "include-literal",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-partial><div>Literal</div></fy-partial>
</fy-composition>`,
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "INCLUDE_INVALID",
        message: expect.stringContaining("Use <fy-include>"),
      }),
    );
  });

  it("rejects document shells, multiple roots, and content outside the partial", async () => {
    const fixtures = {
      "shell.html": `<!doctype html><html><body><fy-partial><div></div></fy-partial></body></html>`,
      "two-roots.html": `<fy-partial><div></div></fy-partial><fy-partial></fy-partial>`,
      "outside.html": `<fy-partial></fy-partial><div>outside</div>`,
      "nested-composition.html": `<fy-partial><fy-composition></fy-composition></fy-partial>`,
      "import-map.html": `<fy-partial><script type="importmap">{}</script><div></div></fy-partial>`,
    };
    for (const [name, html] of Object.entries(fixtures)) {
      await writePartial(name, html);
      const result = await validate(
        `include-shape-${name.replace(".html", "")}`,
        `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/${name}"></fy-include>
</fy-composition>`,
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "INCLUDE_INVALID",
          details: expect.objectContaining({ path: `compositions/partials/${name}` }),
        }),
      );
    }
  });

  it("rejects global style at-rules and invalid controller declarations", async () => {
    await writePartial(
      "global-style.html",
      `<fy-partial>
  <style>@font-face { font-family: Remote; src: url(./remote.woff2); }</style>
  <div></div>
</fy-partial>`,
    );
    await writePartial(
      "inline-controller.html",
      `<fy-partial>
  <script type="text/fy-controller">export default { mount() {} };</script>
  <div></div>
</fy-partial>`,
    );
    await writePartial(
      "external-controller.html",
      `<fy-partial>
  <script type="text/fy-controller" src="./badge.controller.js"></script>
  <div></div>
</fy-partial>`,
    );
    await writePartial(
      "missing-controller.html",
      `<fy-partial>
  <script type="text/fy-controller" src="./missing.controller.js"></script>
  <div></div>
</fy-partial>`,
    );
    await writePartial(
      "two-controllers.html",
      `<fy-partial>
  <script type="text/fy-controller">export default { mount() {} };</script>
  <script type="text/fy-controller">export default { mount() {} };</script>
  <div></div>
</fy-partial>`,
    );
    await writeFile(
      path.join(root, "compositions", "partials", "badge.controller.js"),
      "export default { mount() {} };\n",
    );

    const style = await validate(
      "include-style",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/global-style.html"></fy-include>
</fy-composition>`,
    );
    expect(style.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "INCLUDE_INVALID",
        message: expect.stringContaining("@font-face"),
        details: expect.objectContaining({ path: "compositions/partials/global-style.html" }),
      }),
    );

    const inline = await validate(
      "include-inline-controller",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/inline-controller.html"></fy-include>
</fy-composition>`,
    );
    expect(inline.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const external = await validate(
      "include-external-controller",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/external-controller.html"></fy-include>
</fy-composition>`,
    );
    expect(external.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(external.expandedFragment).toContain('data-fy-controller-path="compositions/partials/badge.controller.js"');

    const missing = await validate(
      "include-missing-controller",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/missing-controller.html"></fy-include>
</fy-composition>`,
    );
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("does not exist"),
        details: expect.objectContaining({ path: "compositions/partials/missing-controller.html" }),
      }),
    );

    const two = await validate(
      "include-two-controllers",
      `<fy-composition width="160" height="90" fps="10" duration-in-frames="2">
  <fy-include src="./partials/two-controllers.html"></fy-include>
</fy-composition>`,
    );
    expect(two.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("at most one controller"),
        details: expect.objectContaining({ path: "compositions/partials/two-controllers.html" }),
      }),
    );
  });
});
