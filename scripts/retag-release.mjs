#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const RULESET_NAME = "Protect release tags";
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`frameyard: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`frameyard: ${message}`);
}

function warn(message) {
  console.warn(`frameyard: warning: ${message}`);
}

function short(commit) {
  return commit.slice(0, 12);
}

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function gitSucceeds(...args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitRun(...args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    const status = error.status === undefined ? "" : ` with exit code ${error.status}`;
    throw new Error(`git ${args.join(" ")} failed${status}`);
  }
}

function ghJson(args) {
  try {
    return JSON.parse(
      execFileSync("gh", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function ghText(args) {
  try {
    return execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function setRuleset(ruleset, repoSlug, enforcement) {
  const body = {
    name: ruleset.name,
    target: ruleset.target,
    enforcement,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
    bypass_actors: ruleset.bypass_actors,
  };

  try {
    execFileSync("gh", ["api", "-X", "PUT", `repos/${repoSlug}/rulesets/${ruleset.id}`, "--input", "-"], {
      cwd: root,
      input: JSON.stringify(body),
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `could not set ruleset ${ruleset.id} to ${enforcement}: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
}

function remoteTagState(tag) {
  // A wildcard keeps the peeled `^{}` line; an exact ref pattern omits it.
  const lines = git("ls-remote", "--tags", "origin", `refs/tags/${tag}*`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const object = lines.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? null;
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ?? null;
  return { object, peeled };
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/retag-release.mjs <version> [--dry-run] [--yes]");
    console.log("");
    console.log("Move an unpublished release tag to HEAD, restoring tag protections.");
    console.log("");
    console.log("  --dry-run  Validate the release state and print the plan without changing tags or rulesets");
    console.log("  --yes      Apply the plan; required for any tag or ruleset change");
    process.exit(0);
  }

  const known = new Set(["--dry-run", "--yes", "--help", "-h"]);
  const unknown = args.filter((arg) => arg.startsWith("-") && !known.has(arg));
  if (unknown.length > 0) {
    fail(`unknown option: ${unknown[0]}`);
  }

  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--yes");
  const positional = args.filter((arg) => !arg.startsWith("-"));

  if (positional.length !== 1) {
    fail("usage: node scripts/retag-release.mjs <version> [--dry-run] [--yes]");
  }

  const requested = positional[0];
  const version = requested.startsWith("v") ? requested.slice(1) : requested;
  if (!SEMVER.test(version)) {
    fail(`invalid version: ${requested}`);
  }
  const tag = `v${version}`;

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    fail("package.json is not valid JSON");
  }

  if (packageJson.version !== version) {
    fail(`package.json is ${packageJson.version}, not ${version}; retagging must match the release version`);
  }
  if (typeof packageJson.name !== "string" || packageJson.name === "") {
    fail("package.json has no package name");
  }

  if (!gitSucceeds("remote", "get-url", "origin")) {
    fail("origin remote is missing");
  }

  const branch = git("branch", "--show-current");
  if (branch !== "main") {
    fail(`releases are cut from main, not ${branch === "" ? "a detached HEAD" : branch}`);
  }

  const status = git("status", "--porcelain");
  if (status !== "") {
    console.error(status);
    fail("working tree is dirty; commit the release changes before retagging");
  }

  info("fetching origin/main");
  gitRun("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");

  const head = git("rev-parse", "HEAD");
  if (!gitSucceeds("merge-base", "--is-ancestor", head, "origin/main")) {
    fail("HEAD is not on origin/main; push the release fix to main before retagging");
  }
  const tagRef = `refs/tags/${tag}`;
  const tagExists = gitSucceeds("rev-parse", "--verify", "--quiet", `${tagRef}^{commit}`);
  const tagType = tagExists ? git("cat-file", "-t", tagRef) : null;
  const tagCommit = tagExists ? git("rev-parse", `${tagRef}^{commit}`) : null;

  if (tagExists && !gitSucceeds("merge-base", "--is-ancestor", tagCommit, head)) {
    fail(
      `local tag ${tag} points at ${short(tagCommit)}, which is not an ancestor of HEAD ${short(head)}; refusing to move it across history`,
    );
  }

  const npm = spawnSync("npm", ["view", `${packageJson.name}@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (npm.error) {
    fail(`could not run npm: ${npm.error.message}`);
  }
  if (npm.status === 0) {
    fail(`${packageJson.name}@${version} is already published on npm; never move a published version`);
  }
  const npmOutput = `${npm.stdout ?? ""}\n${npm.stderr ?? ""}`;
  if (!/E404|404 No match found|No match found for version/.test(npmOutput)) {
    fail(`could not confirm that ${packageJson.name}@${version} is unpublished:\n${npmOutput.trim()}`);
  }

  const auth = spawnSync("gh", ["auth", "status"], { cwd: root, stdio: "ignore" });
  if (auth.error) {
    fail(`could not run gh: ${auth.error.message}`);
  }
  if (auth.status !== 0) {
    fail("gh is not authenticated; run gh auth login");
  }

  const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  const repoSlug = repo.nameWithOwner;
  if (typeof repoSlug !== "string" || !repoSlug.includes("/")) {
    fail("could not resolve the GitHub repository from origin");
  }

  const isAdmin = ghText(["api", `repos/${repoSlug}`, "--jq", ".permissions.admin"]);
  if (isAdmin !== "true") {
    fail(`retagging requires admin permission on ${repoSlug}`);
  }

  const rulesets = ghJson(["api", `repos/${repoSlug}/rulesets`]);
  if (!Array.isArray(rulesets)) {
    fail("could not read repository rulesets");
  }

  const matches = rulesets.filter((entry) => entry.name === RULESET_NAME);
  if (matches.length > 1) {
    fail(`multiple rulesets are named "${RULESET_NAME}"; resolve them in the repository settings`);
  }

  let ruleset = null;
  if (matches.length === 1) {
    ruleset = ghJson(["api", `repos/${repoSlug}/rulesets/${matches[0].id}`]);
    if (ruleset.enforcement !== "active") {
      fail(`ruleset "${RULESET_NAME}" is ${ruleset.enforcement}; restore it to active before retagging`);
    }
  }

  const remote = remoteTagState(tag);
  const remoteCommit = remote.peeled ?? remote.object;
  if (remoteCommit && !gitSucceeds("merge-base", "--is-ancestor", remoteCommit, head)) {
    fail(
      `origin tag ${tag} points at ${short(remoteCommit)}, which is not an ancestor of HEAD ${short(head)}; refusing to move it backwards`,
    );
  }

  const localNeedsMove = !tagExists || tagType !== "tag" || tagCommit !== head;
  const remoteNeedsMove = remote.peeled !== head;

  info(`retag ${tag} for ${repoSlug}`);
  info(`  version ${version} is not published on npm`);
  info(`  main is clean at ${short(head)}`);

  if (localNeedsMove) {
    const from = tagExists
      ? `${tagType === "tag" ? "annotated" : "lightweight"} tag at ${short(tagCommit)}`
      : "no local tag";
    info(`  local ${tag}: ${from}; will move it to ${short(head)}`);
  } else {
    info(`  local ${tag}: annotated tag at ${short(head)}`);
  }

  if (remoteNeedsMove) {
    const from = remote.object
      ? remote.peeled
        ? `annotated tag at ${short(remote.peeled)}`
        : `lightweight tag at ${short(remote.object)}`
      : "no remote tag";
    info(`  origin ${tag}: ${from}; will replace it with the annotated tag at ${short(head)}`);
  } else {
    info(`  origin ${tag}: annotated tag at ${short(head)}`);
  }

  if (remoteNeedsMove) {
    if (ruleset) {
      info(`  ruleset "${RULESET_NAME}" (${ruleset.id}) is active; it will be disabled and restored`);
    } else {
      warn(`no "${RULESET_NAME}" ruleset found; the tag push relies on the repository's current protections`);
    }
  }

  if (!localNeedsMove && !remoteNeedsMove) {
    info(`${tag} already points at ${short(head)} on origin; nothing to do`);
    return;
  }

  const plan = [];
  if (localNeedsMove) {
    plan.push(`create or move the local annotated tag ${tag} to ${short(head)}`);
  }
  if (remoteNeedsMove && ruleset) {
    plan.push(`disable ruleset ${ruleset.id} (${RULESET_NAME})`);
  }
  if (remoteNeedsMove && remote.object) {
    plan.push(`delete origin tag ${tag}`);
  }
  if (remoteNeedsMove) {
    plan.push(`push annotated tag ${tag} to origin`);
  }
  if (remoteNeedsMove && ruleset) {
    plan.push(`restore ruleset ${ruleset.id} to active`);
  }

  console.log("");
  console.log("Plan:");
  for (const [index, step] of plan.entries()) {
    console.log(`  ${index + 1}. ${step}`);
  }
  console.log("");

  if (dryRun) {
    info("dry run: no tags or rulesets changed");
    return;
  }
  if (!confirmed) {
    fail("refusing to change tags without --yes; re-run with --yes to apply");
  }

  if (localNeedsMove) {
    info(`moving local tag ${tag} to ${short(head)}`);
    gitRun("tag", "-f", "-a", tag, head, "-m", `frameyard ${tag}`);
  }

  if (git("cat-file", "-t", tagRef) !== "tag") {
    throw new Error(`local tag ${tag} is not annotated after the update`);
  }
  if (git("rev-parse", `${tagRef}^{commit}`) !== head) {
    throw new Error(`local tag ${tag} does not point at HEAD after the update`);
  }
  const localTagObject = git("rev-parse", tagRef);

  if (remoteNeedsMove) {
    let rulesetDisabled = false;
    try {
      if (ruleset) {
        info(`disabling ruleset ${ruleset.id} (${RULESET_NAME})`);
        setRuleset(ruleset, repoSlug, "disabled");
        rulesetDisabled = true;
      }

      if (remote.object) {
        info(`deleting origin tag ${tag}`);
        gitRun("push", "origin", `:refs/tags/${tag}`);
      }

      info(`pushing annotated tag ${tag} to origin`);
      gitRun("push", "origin", `refs/tags/${tag}`);

      const after = remoteTagState(tag);
      if (after.object !== localTagObject) {
        throw new Error(
          `origin tag ${tag} is ${after.object ? short(after.object) : "missing"}, expected ${short(localTagObject)}`,
        );
      }
      if (after.peeled !== head) {
        throw new Error(
          `origin tag ${tag} peels to ${after.peeled ? short(after.peeled) : "nothing"}, expected HEAD ${short(head)}`,
        );
      }

      info(`${tag} now points at ${short(head)} on origin`);
      info(`  tag object ${short(after.object)}`);
      info(`  peeled commit ${short(after.peeled)}`);
      console.log("");
      info("Next: gh run list --workflow Release --limit 1");
      info("      gh run watch <run-id> --compact --interval 30");
    } finally {
      if (rulesetDisabled) {
        try {
          info(`restoring ruleset ${ruleset.id} to active`);
          setRuleset(ruleset, repoSlug, "active");
          info(`ruleset ${ruleset.id} restored to active`);
        } catch (error) {
          console.error(`frameyard: could not restore ruleset ${ruleset.id}: ${error.message}`);
          console.error(`frameyard: restore "${RULESET_NAME}" to active in the repository settings`);
          process.exitCode = 1;
        }
      }
    }
  } else {
    info(`origin tag ${tag} already points at ${short(head)}`);
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
