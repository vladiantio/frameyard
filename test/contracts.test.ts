import { describe, expect, it } from "vitest";
import { assertJsonSerializable, mergeProps, normalizeAudioClip, normalizeTranscriptClip } from "../src/index.ts";
import { upsertAsset } from "../src/assets/provenance.ts";
import { diagnosticFix } from "../src/diagnostic-fixes.ts";
import { applyPropsSchemaDefaults, parsePropsSchema, validatePropsAgainstSchema } from "../src/props-schema.ts";

describe("props", () => {
  it("merges overrides over shallow defaults and freezes the result", () => {
    const props = mergeProps({ title: "Default", palette: { accent: "blue" } }, { title: "Custom" });

    expect(props).toEqual({ title: "Custom", palette: { accent: "blue" } });
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props.palette)).toBe(true);
  });

  it("returns defaults when overrides are omitted", () => {
    const props = mergeProps({ title: "Default" });

    expect(props).toEqual({ title: "Default" });
    expect(Object.isFrozen(props)).toBe(true);
  });

  it("rejects non-object overrides", () => {
    expect(() => mergeProps({ title: "Default" }, "Custom")).toThrow(/plain JSON object/);
    expect(() => mergeProps({ title: "Default" }, [])).toThrow(/plain JSON object/);
    expect(() => mergeProps({ title: "Default" }, null)).toThrow(/plain JSON object/);
  });

  it("rejects non-JSON prop values", () => {
    expect(() => mergeProps({ title: "Default" }, { title: undefined })).toThrow(/JSON/);
    expect(() => mergeProps({ title: "Default" }, { count: Number.NaN })).toThrow(/JSON/);
    expect(() => mergeProps({ title: "Default" }, { render: () => {} })).toThrow(/JSON/);
  });

  it("accepts arrays and nested JSON objects", () => {
    const value = { list: [1, "two", { three: true }], empty: null };

    expect(() => assertJsonSerializable(value, "props")).not.toThrow();
    expect(assertJsonSerializable(value, "props")).toEqual(value);
  });

  it("accepts shared references that are not circular", () => {
    const shared = { accent: "blue" };
    const value = { primary: shared, secondary: shared };

    expect(() => assertJsonSerializable(value, "props")).not.toThrow();
  });

  it("rejects circular values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => assertJsonSerializable(value, "props")).toThrow(/circular/i);
  });

  it("rejects non-plain objects", () => {
    expect(() => assertJsonSerializable({ when: new Date() }, "props")).toThrow(/JSON/);
    expect(() => assertJsonSerializable({ map: new Map() }, "props")).toThrow(/JSON/);
  });
});

describe("props schema", () => {
  const schema = parsePropsSchema({
    type: "object",
    properties: {
      title: { type: "string", description: "Card title" },
      accent: { type: "string", enum: ["lime", "orange"], default: "lime" },
      palette: {
        type: "object",
        default: {},
        properties: {
          background: { type: "string", default: "#080b10" },
          foreground: { type: "string", default: "#f4f7fb" },
        },
      },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  });

  it("parses the supported subset and preserves descriptions and defaults", () => {
    expect(schema).toMatchObject({
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Card title" },
        accent: { type: "string", enum: ["lime", "orange"], default: "lime" },
        tags: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("rejects malformed schemas", () => {
    expect(() => parsePropsSchema([])).toThrow(/PROPS_SCHEMA_INVALID_SCHEMA|JSON object/);
    expect(() => parsePropsSchema({ type: "string" })).toThrow(/root/);
    expect(() => parsePropsSchema({ type: "object", extra: true })).toThrow(/unsupported keyword/);
    expect(() => parsePropsSchema({ type: "array", items: { type: "string" } })).toThrow(/root/);
    expect(() => parsePropsSchema({ type: "object", properties: {}, required: ["title"] })).toThrow(/unknown property/);
    expect(() => parsePropsSchema({ type: "object", properties: { tags: { type: "array" } } })).toThrow(
      /items is required/,
    );
    expect(() =>
      parsePropsSchema({
        type: "object",
        properties: { mode: { type: "string", enum: ["a", 2] } },
      }),
    ).toThrow(/enum values must match type/);
    expect(() =>
      parsePropsSchema({
        type: "object",
        properties: { title: { type: "string", default: 3 } },
      }),
    ).toThrow(/default/);
  });

  it("applies schema defaults without overriding explicit values", () => {
    const defaults = applyPropsSchemaDefaults(schema, { title: "Explicit" });
    expect(defaults).toEqual({
      title: "Explicit",
      accent: "lime",
      palette: { background: "#080b10", foreground: "#f4f7fb" },
    });

    const merged = mergeProps(
      applyPropsSchemaDefaults(schema, mergeProps(defaults, { accent: "orange", palette: { foreground: "#fff" } })),
      undefined,
    );
    expect(merged).toEqual({
      title: "Explicit",
      accent: "orange",
      palette: { foreground: "#fff", background: "#080b10" },
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.palette)).toBe(true);
  });

  it("reports missing, mistyped, enum, and array item issues with paths", () => {
    expect(validatePropsAgainstSchema(schema, {})).toContainEqual(
      expect.objectContaining({
        path: "title",
        message: expect.stringContaining("Required prop"),
        suggestion: expect.stringContaining("title"),
      }),
    );
    expect(validatePropsAgainstSchema(schema, { title: 3 })).toContainEqual(
      expect.objectContaining({ path: "title", message: expect.stringContaining("must be a string") }),
    );
    expect(validatePropsAgainstSchema(schema, { title: "A", accent: "blue" })).toContainEqual(
      expect.objectContaining({ path: "accent", message: expect.stringContaining("must be one of") }),
    );
    expect(validatePropsAgainstSchema(schema, { title: "A", tags: ["ok", 2] })).toContainEqual(
      expect.objectContaining({ path: "tags[1]", message: expect.stringContaining("must be a string") }),
    );
  });

  it("accepts valid props", () => {
    expect(
      validatePropsAgainstSchema(schema, {
        title: "A",
        accent: "orange",
        tags: ["one", "two"],
        palette: { background: "#000", foreground: "#fff" },
      }),
    ).toEqual([]);
  });
});

describe("diagnostic fixes", () => {
  it("maps an unknown data-fy attribute to a concrete replacement", () => {
    expect(
      diagnosticFix(
        "BINDING_INVALID",
        { attribute: "data-fy-txt", value: "title" },
        'Unknown Frameyard attribute "data-fy-txt".',
      ),
    ).toMatchObject({
      kind: "attribute",
      from: "data-fy-txt",
      to: "data-fy-text",
      docs: expect.stringContaining("bindings.md"),
    });
  });

  it("maps a missing binding path to a path fix with the missing name", () => {
    expect(
      diagnosticFix(
        "BINDING_PATH_MISSING",
        { value: "titel", suggestion: "title" },
        'data-fy-text references prop "titel".',
      ),
    ).toMatchObject({
      kind: "path",
      from: "titel",
      to: "title",
      message: expect.stringContaining("titel"),
      docs: expect.stringContaining("bindings.md"),
    });
  });

  it.each([
    "ANIMATION_INVALID",
    "CONTROLLER_INVALID",
    "STATIC_MEDIA_UNSUPPORTED",
    "ASSET_NOT_FOUND",
    "TIMELINE_CLIP_OVERLAP",
    "TIMELINE_TRANSITION_GEOMETRY",
    "FONT_LOAD_FAILED",
    "OUTPUT_EXISTS",
  ] as const)("provides a baseline fix for %s", (code) => {
    expect(diagnosticFix(code, {}, "failure")).toMatchObject({
      kind: expect.any(String),
      message: expect.any(String),
      docs: expect.any(String),
    });
  });
});

describe("asset manifest", () => {
  it("upserts remote assets without dropping generated artifacts", () => {
    const artifacts = [{ path: "generated/voice.wav" }] as never;
    const manifest = upsertAsset(
      { schemaVersion: 1, artifacts },
      {
        src: "assets/cover.png",
        sha256: "a".repeat(64),
        bytes: 12,
        source: "https://example.com/cover.png",
        fetchedAt: "2026-11-07T00:00:00.000Z",
      },
    );

    expect(manifest.artifacts).toBe(artifacts);
    expect(manifest.assets).toEqual([
      {
        src: "assets/cover.png",
        sha256: "a".repeat(64),
        bytes: 12,
        source: "https://example.com/cover.png",
        fetchedAt: "2026-11-07T00:00:00.000Z",
      },
    ]);
  });
});

describe("audio timeline", () => {
  it("normalizes clip defaults", () => {
    expect(normalizeAudioClip({ src: "./assets/hit.wav", startFrame: 12 }, 0)).toEqual({
      src: "./assets/hit.wav",
      startFrame: 12,
      trimStart: 0,
      volume: 1,
    });
  });

  it("keeps explicit trim and volume values", () => {
    expect(
      normalizeAudioClip(
        {
          src: "assets/voice.wav",
          startFrame: 0,
          trimStart: 0.25,
          trimDuration: 2,
          volume: 0.5,
        },
        0,
      ),
    ).toEqual({
      src: "assets/voice.wav",
      startFrame: 0,
      trimStart: 0.25,
      trimDuration: 2,
      volume: 0.5,
    });
  });

  it.each([
    [{ src: "https://example.com/a.wav", startFrame: 0 }, /local/],
    [{ src: "../outside.wav", startFrame: 0 }, /local/],
    [{ src: "./a.wav", startFrame: -1 }, /startFrame/],
    [{ src: "./a.wav", startFrame: 1.5 }, /startFrame/],
    [{ src: "./a.wav", startFrame: 0, volume: 1.2 }, /volume/],
    [{ src: "./a.wav", startFrame: 0, trimStart: -1 }, /trimStart/],
    [{ src: "./a.wav", startFrame: 0, trimDuration: 0 }, /trimDuration/],
  ])("rejects invalid clip %o", (clip, message) => {
    expect(() => normalizeAudioClip(clip, 0)).toThrow(message);
  });
});

describe("transcript requirements", () => {
  it("normalizes declared transcript assets", () => {
    expect(normalizeTranscriptClip({ src: "./assets/voice.json" }, 0)).toEqual({
      src: "./assets/voice.json",
      words: false,
    });
    expect(normalizeTranscriptClip({ src: "assets/words.json", words: true }, 1)).toEqual({
      src: "assets/words.json",
      words: true,
    });
  });

  it.each([
    [{ src: "https://example.com/a.json" }, /local/],
    [{ src: "../voice.json" }, /local/],
    [{ src: "./voice.json", words: "yes" }, /words/],
  ])("rejects invalid transcript requirement %o", (clip, message) => {
    expect(() => normalizeTranscriptClip(clip, 0)).toThrow(message);
  });
});
