import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldFiles, SCAFFOLD_NEXT } from "../src/scaffold.ts";
import { VERSION } from "../src/version.ts";

const BARE_CLI_LINE = /^\s*(?:frameyard(?:\s|$)|node\s+(?:\.\.?\/)?dist\/cli\.js(?:\s|$))/;
const CLI_COMMAND =
  /^(?:npx\s+)?(?:frameyard(?:@[^\s]+)?|node\s+(?:\.\.?\/)?dist\/cli\.js)\s+(?:init|dev|check|still|render|tts|transcribe|doctor|help)(?:\s|$)/;
const PUBLISHED_CLI = /^npx\s+frameyard(?:@[^\s]+)?\s/;
const PACKAGE_SCRIPT_COMMAND = /^(?:npm run|pnpm run|pnpm)\s+([^\s]+)(?:\s|$)/;
const PNPM_BUILTINS = new Set([
  "add",
  "bin",
  "config",
  "deploy",
  "dlx",
  "env",
  "exec",
  "import",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "setup",
  "store",
  "unlink",
  "up",
  "update",
  "why",
]);

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(fullPath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function shellBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let block: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (block === null) {
      if (/^\s*```(?:sh|bash)\s*$/.test(line)) block = [];
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      blocks.push(block);
      block = null;
    } else {
      block.push(line);
    }
  }
  return blocks;
}

function beforeDevelopment(markdown: string): string {
  const heading = markdown.search(/^## Development\s*$/m);
  return heading === -1 ? markdown : markdown.slice(0, heading);
}

function fencedOffenders(markdown: string, label: string): string[] {
  const offenders: string[] = [];
  for (const block of shellBlocks(markdown)) {
    for (const line of block) {
      if (BARE_CLI_LINE.test(line)) {
        offenders.push(`${label}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

function inlineOffenders(markdown: string, label: string): string[] {
  const offenders: string[] = [];
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const command = (match[1] ?? "").trim();
    if (CLI_COMMAND.test(command) && !PUBLISHED_CLI.test(command)) {
      offenders.push(`${label}: ${command}`);
    }
  }
  return offenders;
}

function packageScriptOffenders(markdown: string, label: string, scripts: Set<string>): string[] {
  const offenders: string[] = [];
  const commands = [
    ...shellBlocks(markdown).flat(),
    ...[...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => (match[1] ?? "").trim()),
  ];
  for (const command of commands) {
    const match = PACKAGE_SCRIPT_COMMAND.exec(command);
    if (match === null) continue;
    const script = match[1] ?? "";
    if (command.startsWith("pnpm ") && PNPM_BUILTINS.has(script)) continue;
    if (!scripts.has(script)) {
      offenders.push(`${label}: unknown package script: ${command}`);
    }
  }
  return offenders;
}

describe("documentation command examples", () => {
  it("uses the published CLI in user-facing examples", async () => {
    const offenders: string[] = [];

    for (const file of ["README.md", ...(await markdownFiles("skill"))]) {
      const source = await readFile(file, "utf8");
      const markdown = file === "README.md" ? beforeDevelopment(source) : source;
      offenders.push(...fencedOffenders(markdown, file));
    }

    for (const [file, contents] of Object.entries(scaffoldFiles("frameyard-project"))) {
      if (!file.endsWith(".md")) continue;
      const label = `scaffold/${file}`;
      offenders.push(...fencedOffenders(contents, label));
      offenders.push(...inlineOffenders(contents, label));
    }

    for (const command of SCAFFOLD_NEXT) {
      expect(command).toMatch(PUBLISHED_CLI);
    }

    expect(offenders).toEqual([]);
  });

  it("uses real package scripts in scaffold docs", () => {
    const files = scaffoldFiles("frameyard-project");
    const manifest = JSON.parse(files["package.json"] ?? "{}") as {
      scripts?: Record<string, string>;
    };
    const scripts = new Set(Object.keys(manifest.scripts ?? {}));
    const offenders: string[] = [];

    for (const [file, contents] of Object.entries(files)) {
      if (!file.endsWith(".md")) continue;
      offenders.push(...packageScriptOffenders(contents, `scaffold/${file}`, scripts));
    }

    expect(offenders).toEqual([]);
  });

  it("keeps a published example in the README and skill", async () => {
    for (const file of ["README.md", "skill/SKILL.md"]) {
      expect(await readFile(file, "utf8")).toContain("npx frameyard ");
    }
  });

  it("links a scaffolded project to its agent guide and the full contract", () => {
    const files = scaffoldFiles("frameyard-project");
    expect(files["README.md"]).toContain("AGENTS.md");
    const agents = files["AGENTS.md"] ?? "";
    expect(agents).toContain(`npx frameyard@${VERSION}`);
    expect(agents).toContain("https://github.com/vladiantio/frameyard/tree/main/skill");
  });
});
