import { describe, expect, it } from "vitest";
import { createSemaphore } from "../src/renderer/concurrency.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("render semaphore", () => {
  it("rejects invalid limits", () => {
    expect(() => createSemaphore(0)).toThrow("positive integer");
    expect(() => createSemaphore(1.5)).toThrow("positive integer");
  });

  it("limits active holders and wakes waiters in order", async () => {
    const semaphore = createSemaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    let thirdAcquired = false;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    first();
    const thirdRelease = await third;
    expect(thirdAcquired).toBe(true);

    second();
    thirdRelease();
  });

  it("transfers a released slot to the next waiter", async () => {
    const semaphore = createSemaphore(1);
    const held = await semaphore.acquire();
    const gate = deferred();
    let entered = false;
    const next = semaphore.acquire().then(async (release) => {
      entered = true;
      await gate.promise;
      release();
    });

    await Promise.resolve();
    expect(entered).toBe(false);
    held();
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(true);
    gate.resolve();
    await next;
  });
});
