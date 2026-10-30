import { describe, expect, it } from "vitest";
import { assertJsonSerializable, mergeProps, normalizeAudioClip, normalizeTranscriptClip } from "../src/index.ts";

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
