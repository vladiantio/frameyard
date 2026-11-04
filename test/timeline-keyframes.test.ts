import { describe, expect, it } from "vitest";
import { EASING_GRAMMAR, easeProgress, parseEasing } from "../src/timeline/easing.ts";
import {
  evaluateKeyframeTrack,
  evaluatePresentation,
  keyframeChannelsAt,
  keyframeMarkerFrames,
} from "../src/timeline/keyframes.ts";
import {
  approximateEasing,
  keyframeChannelExpression,
  keyframeValueExpression,
} from "../src/renderer/keyframe-expressions.ts";
import type { TimelineKeyframes, TimelineTransform } from "../src/timeline/schema.ts";

const transform: TimelineTransform = {
  fit: "contain",
  x: 10,
  y: 20,
  scale: 1,
  rotation: 0,
  opacity: 1,
};

function track(values: Array<[number, number, string?]>) {
  return values.map(([frame, value, easing]) => ({
    frame,
    value,
    ...(easing !== undefined ? { easing } : {}),
  }));
}

describe("timeline keyframe easing", () => {
  it("parses the supported CSS timing functions", () => {
    expect(parseEasing("linear")).toEqual({ kind: "linear" });
    expect(parseEasing("hold")).toEqual({ kind: "steps", steps: 1, position: "jump-end" });
    expect(parseEasing("step-start")).toEqual({ kind: "steps", steps: 1, position: "jump-start" });
    expect(parseEasing("ease-in-out")).toMatchObject({ kind: "cubic-bezier", x1: 0.42, x2: 0.58 });
    expect(parseEasing("CUBIC-BEZIER(0, 0.5, 1, 1)")).toEqual({
      kind: "cubic-bezier",
      x1: 0,
      y1: 0.5,
      x2: 1,
      y2: 1,
    });
    expect(parseEasing("steps(4, jump-none)")).toEqual({
      kind: "steps",
      steps: 4,
      position: "jump-none",
    });
    expect(parseEasing("steps(4)")).toEqual({ kind: "steps", steps: 4, position: "jump-end" });
  });

  it("rejects invalid or unsupported timing functions", () => {
    for (const value of [
      "",
      "easeIn",
      "cubic-bezier(1.2, 0, 1, 1)",
      "cubic-bezier(0, 0, 1)",
      "steps(0)",
      "steps(1, jump-none)",
      "steps(2, side)",
      "linear(0, 1)",
      "steps(2.5)",
    ]) {
      expect(parseEasing(value), value).toBeNull();
    }
    expect(EASING_GRAMMAR).toContain("hold");
  });

  it("matches CSS boundary semantics for steps and hold", () => {
    const samples: Array<[string, number, number]> = [
      ["steps(4, jump-start)", 0, 0.25],
      ["steps(4, jump-start)", 0.25, 0.5],
      ["steps(4, jump-start)", 0.75, 1],
      ["steps(4, jump-end)", 0, 0],
      ["steps(4, jump-end)", 0.25, 0.25],
      ["steps(4, jump-end)", 0.99, 0.75],
      ["steps(4, jump-end)", 1, 1],
      ["steps(4, jump-none)", 0.25, 1 / 3],
      ["steps(4, jump-none)", 0.75, 1],
      ["steps(4, jump-both)", 0, 0.2],
      ["steps(4, jump-both)", 0.25, 0.4],
      ["steps(4, jump-both)", 0.75, 0.8],
      ["hold", 0.99, 0],
      ["hold", 1, 1],
    ];
    for (const [easing, progress, expected] of samples) {
      const parsed = parseEasing(easing);
      expect(parsed, easing).not.toBeNull();
      expect(easeProgress(parsed as NonNullable<typeof parsed>, progress), `${easing} at ${progress}`).toBeCloseTo(
        expected,
        6,
      );
    }
  });

  it("matches CSS named cubic-bezier symmetry and keeps custom curves monotonic", () => {
    const easeInOut = parseEasing("ease-in-out");
    expect(easeInOut).not.toBeNull();
    if (!easeInOut) {
      return;
    }
    expect(easeProgress(easeInOut, 0.5)).toBeCloseTo(0.5, 6);
    expect(easeProgress(easeInOut, 0.25) + easeProgress(easeInOut, 0.75)).toBeCloseTo(1, 5);

    const custom = parseEasing("cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(custom).not.toBeNull();
    if (custom) {
      let previous = 0;
      for (let frame = 0; frame <= 100; frame += 1) {
        const value = easeProgress(custom, frame / 100);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
    }
  });

  it("keeps the production approximation within the fixed budget", () => {
    const easings = [
      "linear",
      "ease",
      "ease-in",
      "ease-out",
      "ease-in-out",
      "cubic-bezier(0.2, 0.8, 0.2, 1)",
      "cubic-bezier(0.1, -0.4, 0.9, 1.4)",
      "cubic-bezier(0, 1, 1, 0)",
    ];
    for (const value of easings) {
      const easing = parseEasing(value);
      expect(easing, value).not.toBeNull();
      if (!easing) {
        continue;
      }
      let maximumError = 0;
      for (let index = 0; index <= 1000; index += 1) {
        const progress = index / 1000;
        maximumError = Math.max(
          maximumError,
          Math.abs(approximateEasing(easing, progress) - easeProgress(easing, progress)),
        );
      }
      expect(maximumError, value).toBeLessThanOrEqual(1e-4);
    }
  });
});

describe("timeline keyframes", () => {
  const keyframes: TimelineKeyframes = {
    opacity: track([
      [0, 0],
      [10, 1, "linear"],
      [20, 0],
    ]),
    x: track([
      [0, -100, "ease-out"],
      [20, 100],
    ]),
    scale: track([
      [0, 0.5],
      [20, 1.5],
    ]),
  };

  it("holds before the first key and after the last key", () => {
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], -5)).toBe(0);
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 20)).toBe(0);
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 40)).toBe(0);
    expect(evaluateKeyframeTrack(keyframes.x ?? [], -1)).toBe(-100);
    expect(evaluateKeyframeTrack(keyframes.x ?? [], 40)).toBe(100);
  });

  it("returns exact key values and interpolates between them", () => {
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 0)).toBe(0);
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 5)).toBeCloseTo(0.5, 6);
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 10)).toBe(1);
    expect(evaluateKeyframeTrack(keyframes.opacity ?? [], 15)).toBeCloseTo(0.5, 6);
  });

  it("resolves unkeyed channels from the transform and clamps overshoot", () => {
    const values = evaluatePresentation({ ...transform, rotation: 12 }, keyframes, 10);
    expect(values.x).toBeGreaterThan(0);
    expect(values.x).toBeLessThan(100);
    expect(values.y).toBe(20);
    expect(values.rotation).toBe(12);
    expect(values.opacity).toBe(1);
    expect(values.scale).toBeCloseTo(1, 6);

    const easing = "cubic-bezier(0.1, -0.5, 0.9, 1.5)";
    const overshootKeys: TimelineKeyframes = {
      opacity: track([
        [0, 0],
        [10, 1],
      ]),
      scale: track([
        [0, 0],
        [10, 1],
      ]),
      x: track([
        [0, 0],
        [10, 1],
      ]),
    };
    overshootKeys.opacity![0]!.easing = easing;
    overshootKeys.scale![0]!.easing = easing;
    overshootKeys.x![0]!.easing = easing;
    for (let frame = 0; frame <= 10; frame += 1) {
      const value = evaluatePresentation(transform, overshootKeys, frame);
      expect(value.opacity).toBeGreaterThanOrEqual(0);
      expect(value.opacity).toBeLessThanOrEqual(1);
      expect(value.scale).toBeGreaterThanOrEqual(0);
    }
  });

  it("builds marker frames and channel values", () => {
    expect(keyframeMarkerFrames(keyframes)).toEqual([0, 10, 20]);
    expect(keyframeChannelsAt(keyframes, 0)).toEqual([
      { channel: "x", value: -100, easing: "ease-out" },
      { channel: "scale", value: 0.5 },
      { channel: "opacity", value: 0 },
    ]);
    expect(keyframeChannelsAt(keyframes, 10)).toEqual([{ channel: "opacity", value: 1, easing: "linear" }]);
    expect(keyframeMarkerFrames(undefined)).toEqual([]);
  });

  it("generates clamped expressions with absolute frame offsets", () => {
    const options = { frameVariable: "n" as const, frameOffset: 20, clipStart: 5 };
    const opacity = keyframeChannelExpression("opacity", keyframes.opacity ?? [], options);
    expect(opacity.startsWith("min(1,max(0,")).toBe(true);
    expect(opacity).toContain("(n+15)");
    const scale = keyframeChannelExpression("scale", keyframes.scale ?? [], options);
    expect(scale.startsWith("max(0,")).toBe(true);
    const value = keyframeValueExpression(keyframes.x ?? [], options);
    expect(value).toContain("if(lt((n+15),0)");
  });
});
