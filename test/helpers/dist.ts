import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const BUILT_CLI = path.resolve("dist/cli.js");
const SOURCE_ROOT = "src";

/**
 * CLI tests spawn `dist/cli.js`, so a build that predates `src/` silently tests
 * the previous binary and turns a stale build into a misleading assertion.
 * Fail with the fix instead.
 */
export async function assertFreshDist(): Promise<void> {
  const built = await stat(BUILT_CLI).catch(() => undefined);
  if (built === undefined) {
    throw new Error("dist/cli.js is missing; run `pnpm build` before CLI tests.");
  }

  const newest = await newestMtime(SOURCE_ROOT);
  if (newest !== undefined && newest > built.mtimeMs) {
    throw new Error(
      "dist/cli.js is older than src/; run `pnpm build` before CLI tests, or run one file with `pnpm test <file>`, which builds first.",
    );
  }
}

async function newestMtime(directory: string): Promise<number | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  let newest: number | undefined;

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtime(entryPath);
      if (nested !== undefined && (newest === undefined || nested > newest)) {
        newest = nested;
      }
      continue;
    }
    const info = await stat(entryPath);
    if (newest === undefined || info.mtimeMs > newest) {
      newest = info.mtimeMs;
    }
  }

  return newest;
}
