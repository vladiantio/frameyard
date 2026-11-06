import type { CompositionSession } from "./browser.js";

export interface SessionLease {
  session: CompositionSession;
  /** True when the session came from the idle pool. */
  reused: boolean;
  release(): Promise<void>;
  discard(): Promise<void>;
}

/**
 * Reuses loaded composition sessions across timeline segments. A session is
 * only leased to one capture at a time; released sessions stay idle until the
 * pool exceeds its idle budget or the render ends.
 */
export class CompositionSessionPool {
  private readonly idle = new Map<string, CompositionSession[]>();
  private readonly open = new Set<CompositionSession>();
  private readonly maxIdle: number;
  private closed = false;

  constructor(options: { maxIdle?: number } = {}) {
    this.maxIdle = Math.max(1, options.maxIdle ?? 8);
  }

  async acquire(key: string, factory: () => Promise<CompositionSession>): Promise<SessionLease> {
    if (this.closed) {
      throw new Error("Capture session pool is closed.");
    }
    const idle = this.idle.get(key);
    const reused = idle?.pop();
    if (reused) {
      if (idle?.length === 0) {
        this.idle.delete(key);
      }
      return this.lease(key, reused, true);
    }

    const session = await factory();
    this.open.add(session);
    return this.lease(key, session, false);
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...this.open];
    this.open.clear();
    this.idle.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }

  private lease(key: string, session: CompositionSession, reused: boolean): SessionLease {
    let settled = false;
    return {
      session,
      reused,
      release: async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.closed) {
          await this.closeSession(session);
          return;
        }
        const idle = this.idle.get(key) ?? [];
        idle.push(session);
        this.idle.set(key, idle);
        await this.trim();
      },
      discard: async () => {
        if (settled) {
          return;
        }
        settled = true;
        await this.closeSession(session);
      },
    };
  }

  private async trim(): Promise<void> {
    let idleCount = 0;
    for (const sessions of this.idle.values()) {
      idleCount += sessions.length;
    }
    while (idleCount > this.maxIdle) {
      const entry = this.idle.entries().next().value as [string, CompositionSession[]] | undefined;
      if (!entry) {
        return;
      }
      const [key, sessions] = entry;
      const session = sessions.shift();
      if (session) {
        await this.closeSession(session);
        idleCount -= 1;
      }
      if (sessions.length === 0) {
        this.idle.delete(key);
      }
    }
  }

  private async closeSession(session: CompositionSession): Promise<void> {
    this.open.delete(session);
    await session.close().catch(() => undefined);
  }
}
