import { describe, expect, it } from "vitest";
import { frameToMilliseconds, frameToSeconds } from "../src/runtime/clock.ts";
import { random } from "../src/runtime/random.ts";

describe("frame clock", () => {
  it("derives time only from the frame and frame rate", () => {
    expect(frameToMilliseconds(0, 30)).toBe(0);
    expect(frameToMilliseconds(15, 30)).toBe(500);
    expect(frameToMilliseconds(30, 30)).toBe(1000);
    expect(frameToSeconds(45, 30)).toBe(1.5);
  });

  it("supports non-integer frame rates", () => {
    expect(frameToMilliseconds(1, 2.5)).toBe(400);
  });
});

describe("deterministic randomness", () => {
  it("returns the same value for the same key regardless of call order", () => {
    const forward = ["star:17", "star:18", "particle:2"].map((key) => random(key));
    const backward = ["particle:2", "star:18", "star:17"].map((key) => random(key)).reverse();

    expect(backward).toEqual(forward);
  });

  it("returns values in the half-open unit interval", () => {
    for (let index = 0; index < 500; index += 1) {
      const value = random(`value:${index}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("does not collapse nearby keys to the same value", () => {
    const values = new Set(Array.from({ length: 500 }, (_, index) => random(`star:${index}`)));
    expect(values.size).toBeGreaterThan(490);
  });

  it("has a roughly uniform mean", () => {
    const values = Array.from({ length: 2_000 }, (_, index) => random(`sample:${index}`));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });

  it("treats keys as exact strings", () => {
    expect(random("a")).not.toBe(random("a "));
    expect(random("")).toBeGreaterThanOrEqual(0);
  });
});
