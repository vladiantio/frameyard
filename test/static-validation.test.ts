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

function documentHtml(options: { root?: string; head?: string; body?: string; doctype?: string } = {}): string {
  const doctype = options.doctype ?? "<!doctype html>";
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

  return `${doctype}
<html>
  <head>
    <meta charset="utf-8">
    <script type="application/json" data-fy="props">
    { "title": "Hello", "accent": "#b8f36b", "show": true, "items": [{ "label": "A" }, { "label": "B" }] }
    </script>
    ${options.head ?? ""}
  </head>
  <body>
    ${rootMarkup}
    ${options.body ?? '<script type="text/fy-controller" src="./hello.controller.js"></script>'}
  </body>
</html>`;
}

async function validate(name: string, html: string, props?: unknown) {
  const entry = `compositions/${name}.html`;
  await writeFile(path.join(root, entry), html);
  return validateHtmlComposition({ projectRoot: root, entry, props });
}

describe("HTML composition static validation", () => {
  it("validates a complete composition and resolves metadata, controller, and clips", async () => {
    const result = await validate("valid", documentHtml());

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

  it("reports a missing doctype and returns no info", async () => {
    const result = await validate("no-doctype", documentHtml({ doctype: "" }));

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "COMPOSITION_INVALID",
        details: expect.objectContaining({ line: 1 }),
      }),
    );
  });

  it("reports invalid metadata with an attribute location", async () => {
    const result = await validate(
      "bad-metadata",
      documentHtml({
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

  it("warns on missing binding paths with a suggestion", async () => {
    const result = await validate(
      "missing-path",
      documentHtml({
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
      documentHtml({
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
      documentHtml({
        root: '<fy-composition width="320" height="180" fps="10" duration-in-frames="5"><audio data-fy-attr-src="voice"></audio></fy-composition>',
      }),
      { voice: "assets/tone.wav" },
    );

    expect(result.info?.audioClips[0]).toMatchObject({ src: "assets/tone.wav" });
  });

  it("rejects event handler bindings, root conditionals, and text on void elements", async () => {
    const result = await validate(
      "bad-targets",
      documentHtml({
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
      documentHtml({
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
      documentHtml({
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
      documentHtml({
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
      documentHtml({
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
      documentHtml({
        head: '<base href="/"><meta http-equiv="refresh" content="0">',
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
      documentHtml({
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
      documentHtml({
        body: '<script type="text/fy-controller" src="./hello.controller.js">export default {};</script>',
      }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONTROLLER_INVALID" }));
  });

  it("rejects a missing external controller file", async () => {
    const result = await validate(
      "missing-controller",
      documentHtml({ body: '<script type="text/fy-controller" src="./missing.js"></script>' }),
    );

    expect(result.info).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONTROLLER_INVALID" }));
  });

  it("rejects missing or remote media and transcripts", async () => {
    const result = await validate(
      "missing-media",
      documentHtml({
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
      documentHtml({
        body: '<p>Outside</p><script type="text/fy-controller" src="./hello.controller.js"></script>',
      }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "CONTENT_OUTSIDE_ROOT" }),
    );
  });
});
