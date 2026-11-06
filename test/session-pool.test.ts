import { describe, expect, it } from "vitest";
import type { CompositionSession } from "../src/renderer/browser.ts";
import { CompositionSessionPool } from "../src/renderer/session-pool.ts";

function fakeSession() {
  let closes = 0;
  const session = {
    entry: "compositions/base.html",
    controller: null,
    metadata: {
      width: 320,
      height: 180,
      fps: 10,
      durationInFrames: 10,
      static: false,
    },
    props: {},
    audioClips: [],
    embeddedAudioClips: [],
    transcriptClips: [],
    seek: async () => undefined,
    capture: async () => Buffer.alloc(0),
    readDiagnostics: async () => [],
    assertHealthy: () => undefined,
    close: async () => {
      closes += 1;
    },
  } as unknown as CompositionSession;
  return { session, closes: () => closes };
}

describe("capture session pool", () => {
  it("reuses an idle session for the same key", async () => {
    const pool = new CompositionSessionPool({ maxIdle: 4 });
    const fake = fakeSession();
    let opened = 0;
    const first = await pool.acquire("base", async () => {
      opened += 1;
      return fake.session;
    });
    expect(first.reused).toBe(false);
    await first.release();

    const second = await pool.acquire("base", async () => {
      opened += 1;
      return fake.session;
    });
    expect(second.reused).toBe(true);
    expect(opened).toBe(1);
    await second.release();
    await pool.close();
    expect(fake.closes()).toBe(1);
  });

  it("does not reuse a discarded session", async () => {
    const pool = new CompositionSessionPool({ maxIdle: 4 });
    const firstFake = fakeSession();
    const first = await pool.acquire("base", async () => firstFake.session);
    await first.discard();

    const secondFake = fakeSession();
    let opened = 0;
    const second = await pool.acquire("base", async () => {
      opened += 1;
      return secondFake.session;
    });
    expect(second.reused).toBe(false);
    expect(opened).toBe(1);
    await second.release();
    await pool.close();
    expect(firstFake.closes()).toBe(1);
    expect(secondFake.closes()).toBe(1);
  });

  it("closes the oldest idle session when the idle budget is exceeded", async () => {
    const pool = new CompositionSessionPool({ maxIdle: 1 });
    const firstFake = fakeSession();
    const secondFake = fakeSession();
    const first = await pool.acquire("a", async () => firstFake.session);
    await first.release();
    const second = await pool.acquire("b", async () => secondFake.session);
    await second.release();

    expect(firstFake.closes()).toBe(1);
    expect(secondFake.closes()).toBe(0);
    await pool.close();
    expect(secondFake.closes()).toBe(1);
  });

  it("closes every session when the pool closes", async () => {
    const pool = new CompositionSessionPool({ maxIdle: 4 });
    const fake = fakeSession();
    const lease = await pool.acquire("base", async () => fake.session);
    await lease.release();

    await pool.close();
    expect(fake.closes()).toBe(1);
    await expect(pool.acquire("base", async () => fake.session)).rejects.toThrow("closed");
  });
});
