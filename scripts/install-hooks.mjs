import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

try {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  const hooksDir = path.join(root, ".githooks");

  if (!existsSync(hooksDir)) {
    process.exit(0);
  }

  const current = (() => {
    try {
      return git(["config", "--get", "core.hooksPath"], root);
    } catch {
      return "";
    }
  })();

  if (current && current !== ".githooks" && path.resolve(root, current) !== hooksDir) {
    console.warn(`frameyard: core.hooksPath is already set to "${current}"; leaving it unchanged.`);
    process.exit(0);
  }

  if (!current) {
    git(["config", "core.hooksPath", ".githooks"], root);
    console.log("frameyard: installed git hooks from .githooks");
  }
} catch {
  // Installation is best-effort; package installs outside a git worktree are fine.
}
