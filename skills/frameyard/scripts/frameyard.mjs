#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "../../..");
const configured = process.env.FRAMEYARD_CLI;

// Only prefer a sibling build inside the frameyard package itself. A copied
// skill sits three levels below its host directory, which may hold an
// unrelated dist/cli.js.
function packageCli() {
  const manifestPath = path.join(packageRoot, "package.json");
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  if (!existsSync(manifestPath) || !existsSync(cliPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest.name === "frameyard" ? cliPath : undefined;
  } catch {
    return undefined;
  }
}

const localCli = packageCli();

let command;
let args;
if (configured) {
  if (!existsSync(configured)) {
    process.stderr.write(`FRAMEYARD_CLI does not exist: ${configured}\n`);
    process.exit(1);
  }
  if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
    command = process.execPath;
    args = [configured, ...process.argv.slice(2)];
  } else {
    command = configured;
    args = process.argv.slice(2);
  }
} else if (localCli) {
  command = process.execPath;
  args = [localCli, ...process.argv.slice(2)];
} else {
  command = "frameyard";
  args = process.argv.slice(2);
}

const child = spawn(command, args, { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  });
}

child.once("error", (error) => {
  if (error.code === "ENOENT") {
    process.stderr.write(
      "The frameyard CLI was not found. Run `npx frameyard`, add frameyard to PATH, or set FRAMEYARD_CLI to an installed CLI path.\n",
    );
  } else {
    process.stderr.write(`Could not start the Frameyard CLI: ${error.message}\n`);
  }
  process.exit(1);
});

child.once("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
