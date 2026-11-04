#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function fail(message) {
  console.error(`frameyard: ${message}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const required = packageJson.files?.map((entry) => entry.replace(/^\.\//, ""));
if (!Array.isArray(required) || required.length === 0) {
  fail("package.json has no files list");
}

const requiredFiles = [
  ...required,
  "LICENSE",
  ...Object.values(packageJson.bin ?? {}).map((entry) => entry.replace(/^\.\//, "")),
];

let output;
try {
  output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch {
  fail("could not inspect the package; run pnpm install and pnpm build first");
}

let parsed;
try {
  parsed = JSON.parse(output);
} catch {
  fail("pnpm pack --dry-run --json did not return JSON");
}

const pack = Array.isArray(parsed) ? parsed[0] : parsed;
const files = new Set((pack?.files ?? []).map((file) => file.path));
const missing = requiredFiles.filter((entry) => {
  if (files.has(entry)) return false;
  const prefix = entry.endsWith("/") ? entry : `${entry}/`;
  return ![...files].some((file) => file.startsWith(prefix));
});

if (missing.length > 0) {
  fail(`package is missing ${missing.join(", ")}`);
}

console.log(`frameyard: package contains ${files.size} files and every required path`);
