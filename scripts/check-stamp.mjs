#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const STAMP = "frameyard-check.json";

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function stampPath() {
  return path.join(git("rev-parse", "--absolute-git-dir"), STAMP);
}

function record() {
  const status = git("status", "--porcelain", "--untracked-files=normal");
  if (status.split(/\r?\n/).some((line) => line.startsWith("?? "))) {
    console.error("frameyard: not recording the check because untracked files could change the result");
    process.exit(0);
  }

  let tree;
  if (status === "") {
    tree = git("rev-parse", "HEAD^{tree}");
  } else {
    const stash = git("stash", "create");
    if (!stash) {
      console.error("frameyard: not recording the check because the working tree could not be fingerprinted");
      process.exit(0);
    }
    tree = git("rev-parse", `${stash}^{tree}`);
  }

  writeFileSync(stampPath(), `${JSON.stringify({ tree, node: process.version })}\n`);
  console.log(`frameyard: recorded a passing check for tree ${tree.slice(0, 12)}`);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function verify() {
  const refs = (await readStdin())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));
  const head = git("rev-parse", "HEAD");
  const commits = refs.map(([, localSha]) => {
    try {
      return git("rev-parse", `${localSha}^{commit}`);
    } catch {
      return localSha;
    }
  });

  if (refs.length === 0 || commits.some((sha) => sha !== head)) {
    process.exit(1);
  }
  if (git("status", "--porcelain", "--untracked-files=normal") !== "") {
    process.exit(1);
  }

  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath(), "utf8"));
  } catch {
    process.exit(1);
  }

  if (stamp.tree !== git("rev-parse", "HEAD^{tree}") || stamp.node !== process.version) {
    process.exit(1);
  }
  process.exit(0);
}

const command = process.argv[2];
if (command === "record") {
  record();
} else if (command === "verify") {
  await verify();
} else {
  console.error("Usage: node scripts/check-stamp.mjs <record|verify>");
  process.exit(1);
}
