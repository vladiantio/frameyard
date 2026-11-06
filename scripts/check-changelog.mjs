#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const USER_FACING = /^(?:feat|fix|perf)(?:\([^)]+\))?!?:/;
const RELEASE = /^chore\(release\):/;
const SKIP = /^Changelog:\s*skip\s*$/im;
const EXAMPLE = /^examples\//;

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`frameyard: ${message}`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const to = option("--to") ?? "HEAD";
let previous = option("--previous");

if (!previous) {
  try {
    previous = git("describe", "--tags", "--abbrev=0", to);
  } catch {
    console.log("frameyard: no previous tag; skipping changelog coverage");
    process.exit(0);
  }
}

if (!previous) {
  console.log("frameyard: no previous tag; skipping changelog coverage");
  process.exit(0);
}

let log;
try {
  log = git("log", "--no-merges", "--format=%H%x00%s%x00%b%x00", `${previous}..${to}`);
} catch {
  fail(`cannot read commits in ${previous}..${to}`);
}

const fields = log.split("\x00");
const commits = [];
for (let index = 0; index + 2 < fields.length; index += 3) {
  const sha = fields[index].trim();
  if (sha === "") continue;
  commits.push({ sha, subject: fields[index + 1].trim(), body: fields[index + 2] });
}

const missing = [];
for (const commit of commits) {
  if (!USER_FACING.test(commit.subject) || RELEASE.test(commit.subject)) continue;
  if (SKIP.test(commit.body)) continue;

  let files;
  try {
    files = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit.sha).split(/\r?\n/).filter(Boolean);
  } catch {
    fail(`cannot read the files changed by ${commit.sha.slice(0, 12)}`);
  }
  if (files.includes("CHANGELOG.md")) continue;
  if (files.length > 0 && files.every((file) => EXAMPLE.test(file))) continue;
  missing.push(commit);
}

if (missing.length > 0) {
  console.error(`frameyard: ${missing.length} user-facing commit(s) since ${previous} do not update CHANGELOG.md:`);
  for (const commit of missing) {
    console.error(`  ${commit.sha.slice(0, 12)} ${commit.subject}`);
  }
  console.error(
    "Add an entry under ## [Unreleased], include 'Changelog: skip' in the commit body, or keep the commit under examples/.",
  );
  process.exit(1);
}

console.log(`frameyard: every user-facing commit since ${previous} has changelog coverage`);
