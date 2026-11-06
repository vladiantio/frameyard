/** A small FIFO semaphore for bounding capture sessions and encoders. */
export interface Semaphore {
  acquire(): Promise<() => void>;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Semaphore limit must be a positive integer.");
  }
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      // Transfer the slot directly so a concurrent acquire cannot take it.
      next();
      return;
    }
    active -= 1;
  };

  return {
    async acquire(): Promise<() => void> {
      if (active < limit) {
        active += 1;
        return release;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      return release;
    },
  };
}
