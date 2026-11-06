import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.FRAMEYARD_TIMINGS;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("stage timings", () => {
  it("is a no-op unless FRAMEYARD_TIMINGS is enabled", async () => {
    delete process.env.FRAMEYARD_TIMINGS;
    vi.resetModules();
    const { startTiming } = await import("../src/renderer/timings.js");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startTiming("capture").finish();

    expect(write).not.toHaveBeenCalled();
  });

  it("writes one JSON line with stage details when enabled", async () => {
    process.env.FRAMEYARD_TIMINGS = "1";
    vi.resetModules();
    const { startTiming } = await import("../src/renderer/timings.js");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startTiming("capture", { segment: 3 }).finish({ frames: 300 });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    const event = JSON.parse(line);
    expect(event).toMatchObject({ type: "fy-timing", event: "capture", segment: 3, frames: 300 });
    expect(event.ms).toBeTypeOf("number");
  });
});
