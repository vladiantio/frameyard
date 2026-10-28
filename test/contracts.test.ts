import { describe, expect, it } from "vitest";
import {
  assertJsonSerializable,
  defineComposition,
  normalizeComposition,
  resolveAudioClips,
  resolveProps,
} from "../src/index.ts";

const base = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 90,
  mount() {},
  update() {},
};

describe("composition metadata", () => {
  it("keeps valid fixed metadata", () => {
    const composition = normalizeComposition(base);

    expect(composition.width).toBe(1920);
    expect(composition.height).toBe(1080);
    expect(composition.fps).toBe(30);
    expect(composition.durationInFrames).toBe(90);
  });

  it.each([
    [{ width: 0 }, /width/],
    [{ width: 1920.5 }, /width/],
    [{ height: -1 }, /height/],
    [{ fps: 0 }, /fps/],
    [{ durationInFrames: 1.5 }, /durationInFrames/],
  ])("rejects invalid metadata %o", (patch, message) => {
    expect(() => normalizeComposition({ ...base, ...patch })).toThrow(message);
  });

  it("requires mount and update functions", () => {
    expect(() => normalizeComposition({ ...base, mount: undefined } as never)).toThrow(/mount/);
    expect(() => normalizeComposition({ ...base, update: undefined } as never)).toThrow(/update/);
  });

  it("rejects a composition whose update is declared async", () => {
    const update = async () => {};
    expect(() => normalizeComposition({ ...base, update })).toThrow(/synchronous/);
  });

  it("rejects non-JSON default props with a composition error", () => {
    try {
      normalizeComposition({ ...base, defaultProps: { bad: undefined } });
      expect.unreachable("expected normalization to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "COMPOSITION_INVALID" });
      expect(String((error as Error).message)).toContain("defaultProps must be JSON-serializable");
    }
  });

  it("defineComposition normalizes and preserves the definition", () => {
    const definition = defineComposition({
      ...base,
      defaultProps: { title: "Hello" },
    });

    expect(definition.width).toBe(1920);
    expect(definition.defaultProps).toEqual({ title: "Hello" });
    expect(typeof definition.mount).toBe("function");
  });
});

describe("props", () => {
  it("merges overrides over shallow defaults and freezes the result", () => {
    const composition = normalizeComposition({
      ...base,
      defaultProps: { title: "Default", palette: { accent: "blue" } },
    });

    const props = resolveProps(composition, { title: "Custom" });

    expect(props).toEqual({ title: "Custom", palette: { accent: "blue" } });
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props.palette)).toBe(true);
  });

  it("rejects non-JSON prop values", () => {
    const composition = normalizeComposition({
      ...base,
      defaultProps: { title: "Default" },
    });

    expect(() => resolveProps(composition, { title: undefined })).toThrow(/JSON/);
    expect(() => resolveProps(composition, { count: Number.NaN })).toThrow(/JSON/);
    expect(() => resolveProps(composition, { render: () => {} })).toThrow(/JSON/);
  });

  it("reports domain validation errors before frame production", () => {
    const composition = normalizeComposition({
      ...base,
      validateProps(props) {
        return typeof props.title === "string" ? [] : ["title must be a string"];
      },
    });

    expect(() => resolveProps(composition, { title: 42 })).toThrow(/title must be a string/);
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

describe("audio timeline", () => {
  it("normalizes clip defaults", () => {
    const composition = normalizeComposition({
      ...base,
      audio: [{ src: "./assets/hit.wav", startFrame: 12 }],
    });

    expect(resolveAudioClips(composition, {})).toEqual([
      { src: "./assets/hit.wav", startFrame: 12, trimStart: 0, volume: 1 },
    ]);
  });

  it("resolves audio from props", () => {
    const composition = normalizeComposition({
      ...base,
      audio: ({ props }) => [
        {
          src: props.voice as string,
          startFrame: 0,
          trimStart: 0.25,
          trimDuration: 2,
          volume: 0.5,
        },
      ],
    });

    expect(resolveAudioClips(composition, { voice: "./voice.wav" })).toEqual([
      {
        src: "./voice.wav",
        startFrame: 0,
        trimStart: 0.25,
        trimDuration: 2,
        volume: 0.5,
      },
    ]);
  });

  it.each([
    [{ src: "https://example.com/a.wav", startFrame: 0 }, /local/],
    [{ src: "./a.wav", startFrame: -1 }, /startFrame/],
    [{ src: "./a.wav", startFrame: 1.5 }, /startFrame/],
    [{ src: "./a.wav", startFrame: 0, volume: 1.2 }, /volume/],
    [{ src: "./a.wav", startFrame: 0, trimStart: -1 }, /trimStart/],
    [{ src: "./a.wav", startFrame: 0, trimDuration: 0 }, /trimDuration/],
  ])("rejects invalid clip %o", (clip, message) => {
    const composition = normalizeComposition({ ...base, audio: [clip] });

    expect(() => resolveAudioClips(composition, {})).toThrow(message);
  });
});
