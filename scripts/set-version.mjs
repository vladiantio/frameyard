#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJsonPath = path.join(root, "package.json");
const versionTsPath = path.join(root, "src/version.ts");
const skillPath = path.join(root, "skills/frameyard/SKILL.md");

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_TS = /^export const VERSION = "([^"]+)";$/m;
const SKILL_VERSION = /^frameyard-api-version: (\S+)$/m;

function fail(message) {
  console.error(`frameyard: ${message}`);
  process.exit(1);
}

function relative(file) {
  return path.relative(root, file);
}

const [packageText, versionTsText, skillText] = await Promise.all([
  readFile(packageJsonPath, "utf8"),
  readFile(versionTsPath, "utf8"),
  readFile(skillPath, "utf8"),
]);

let packageJson;
try {
  packageJson = JSON.parse(packageText);
} catch {
  fail("package.json is not valid JSON");
}

if (typeof packageJson.version !== "string" || !SEMVER.test(packageJson.version)) {
  fail(`package.json has an invalid version: ${JSON.stringify(packageJson.version)}`);
}

const versionTsMatch = versionTsText.match(VERSION_TS);
const skillMatch = skillText.match(SKILL_VERSION);

if (!versionTsMatch) {
  fail("src/version.ts does not contain a VERSION declaration");
}
if (!skillMatch) {
  fail("skills/frameyard/SKILL.md does not contain a frameyard-api-version line");
}

if (process.argv[2] === "--check") {
  const expected = packageJson.version;
  const mismatches = [];

  if (versionTsMatch[1] !== expected) {
    mismatches.push(`src/version.ts has ${versionTsMatch[1]}`);
  }
  if (skillMatch[1] !== expected) {
    mismatches.push(`skills/frameyard/SKILL.md has ${skillMatch[1]}`);
  }

  if (mismatches.length > 0) {
    console.error(`frameyard: version ${expected} is inconsistent:`);
    for (const mismatch of mismatches) {
      console.error(`  ${mismatch}`);
    }
    process.exit(1);
  }

  console.log(
    `frameyard: version ${expected} is consistent across package.json, src/version.ts, and skills/frameyard/SKILL.md`,
  );
  process.exit(0);
}

const next = process.argv[2];

if (!next || !SEMVER.test(next)) {
  console.error("Usage:");
  console.error("  node scripts/set-version.mjs <version>   Set an explicit semver version");
  console.error("  node scripts/set-version.mjs --check     Verify all version locations agree");
  process.exit(1);
}

const updatedPackage = `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`;
const updatedVersionTs = versionTsText.replace(VERSION_TS, `export const VERSION = "${next}";`);
const updatedSkill = skillText.replace(SKILL_VERSION, `frameyard-api-version: ${next}`);

await Promise.all([
  writeFile(packageJsonPath, updatedPackage),
  writeFile(versionTsPath, updatedVersionTs),
  writeFile(skillPath, updatedSkill),
]);

console.log(`frameyard: version ${packageJson.version} -> ${next}`);
for (const file of [packageJsonPath, versionTsPath, skillPath]) {
  console.log(`  ${relative(file)}`);
}
console.log(`\nNext: update CHANGELOG.md, run the full test suite, commit, and tag v${next}.`);
