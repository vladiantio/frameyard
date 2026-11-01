#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = ["scripts", "bench"];

const scripts = [];
for (const directory of directories) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      scripts.push(path.join(directory, entry.name));
    }
  }
}
scripts.sort();

if (scripts.length === 0) {
  console.error("frameyard: no scripts/*.mjs or bench/*.mjs files to check");
  process.exit(1);
}

const failures = scripts.filter((script) => {
  const result = spawnSync(process.execPath, ["--check", script], {
    cwd: root,
    stdio: "inherit",
  });
  return result.status !== 0;
});

if (failures.length > 0) {
  console.error(`frameyard: syntax check failed for ${failures.join(", ")}`);
  process.exit(1);
}

console.log(`frameyard: syntax checked ${scripts.length} scripts/*.mjs and bench/*.mjs files`);
