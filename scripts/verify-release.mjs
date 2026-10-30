#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ci = process.argv.includes("--ci");

function fail(message) {
  console.error(`frameyard: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitSucceeds(...args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const expectedTag = `v${version}`;
const tag = ci ? (process.env.GITHUB_REF_NAME ?? "") : expectedTag;

if (ci && tag === "") {
  fail("GITHUB_REF_NAME is not set; run this script from the release workflow");
}

if (tag !== expectedTag) {
  fail(`tag ${tag} does not match package.json version ${version}`);
}

const versionCheck = spawnSync(process.execPath, ["scripts/set-version.mjs", "--check"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
if (versionCheck.status !== 0) {
  process.exit(versionCheck.status ?? 1);
}

const tagRef = `refs/tags/${tag}`;
if (!gitSucceeds("rev-parse", "--verify", "--quiet", `${tagRef}^{commit}`)) {
  fail(`tag ${tag} does not exist; create it with: git tag -a ${tag} -m "frameyard ${tag}"`);
}

if (git("cat-file", "-t", tagRef) !== "tag") {
  fail(`tag ${tag} is not annotated; releases use annotated tags (git tag -a)`);
}

const tagCommit = git("rev-parse", `${tagRef}^{commit}`);
const headCommit = git("rev-parse", "HEAD");
if (tagCommit !== headCommit) {
  fail(`tag ${tag} points at ${tagCommit.slice(0, 12)}, not HEAD ${headCommit.slice(0, 12)}`);
}

const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const datedSection = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!datedSection.test(changelog)) {
  fail(`CHANGELOG.md has no dated section for ${version}; expected "## [${version}] - YYYY-MM-DD"`);
}

const comparisonLink = new RegExp(`^\\[${escapedVersion}\\]: \\S+$`, "m");
if (!comparisonLink.test(changelog)) {
  fail(`CHANGELOG.md has no link reference for ${version}; add "[${version}]: <compare URL>"`);
}

if (ci) {
  if (!gitSucceeds("rev-parse", "--verify", "--quiet", "origin/main^{commit}")) {
    fail("origin/main is missing; fetch it before running with --ci");
  }
  if (!gitSucceeds("merge-base", "--is-ancestor", tagCommit, "origin/main")) {
    fail(`tag ${tag} is not reachable from origin/main`);
  }
} else {
  const branch = git("branch", "--show-current");
  if (branch !== "main") {
    fail(`releases are cut from main, not ${branch === "" ? "a detached HEAD" : branch}`);
  }

  const status = git("status", "--porcelain");
  if (status !== "") {
    console.error(status);
    fail("working tree is dirty; commit the release changes before verifying");
  }
}

console.log(`frameyard: release ${tag} verifies`);
console.log(`  version ${version} is consistent across package.json, src/version.ts, and skills/frameyard/SKILL.md`);
console.log(`  tag ${tag} is annotated and at HEAD`);
console.log(`  CHANGELOG.md has a dated ${version} section and comparison link`);
console.log(ci ? "  tag is reachable from origin/main" : "  on main with a clean working tree");
