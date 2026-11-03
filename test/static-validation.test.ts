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

describe("HTML composition static validation", () => {
  it("validates a complete composition and resolves metadata, controller, and clips", async () => {
    const result = await validate("valid", fragmentHtml());

    expect(result.info).not.toBeNull();
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "BINDING_PATH_MISSING",
        details: expect.objectContaining({ value: "subtitle" }),
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
