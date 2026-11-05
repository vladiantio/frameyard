import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTimelineDocument } from "../src/index.ts";
import { scaffoldFiles, SCAFFOLD_NEXT } from "../src/scaffold.ts";
import { VERSION } from "../src/version.ts";

const BARE_CLI_LINE = /^\s*(?:frameyard(?:\s|$)|node\s+(?:\.\.?\/)?dist\/cli\.js(?:\s|$))/;
const CLI_COMMAND =
  /^(?:npx\s+)?(?:frameyard(?:@[^\s]+)?|node\s+(?:\.\.?\/)?dist\/cli\.js)\s+(?:init|dev|context|lint|check|still|inspect|compare|render|tts|transcribe|add|doctor|help)(?:\s|$)/;
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

const STILL_CAP_DOCS = [
  "README.md",
  "docs/v0.1-design.md",
  "GLOSSARY.md",
  "skills/frameyard/SKILL.md",
  "skills/frameyard/references/json-results.md",
  "skills/frameyard/references/deterministic-authoring.md",
  "skills/frameyard/references/timelines.md",
  "skills/frameyard/references/common-mistakes.md",
  "scaffolds/init/AGENTS.md",
];

const STILL_CAP_PATTERNS = [
  /at most (\d+) (?:unique|inspection) frames/g,
  /up to (\d+) unique frames/g,
  /more than (\d+) unique frames/g,
  /limited to (\d+) unique frames/g,
  /(\d+)-frame (?:inspection )?cap/g,
];

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

    for (const file of ["README.md", ...(await markdownFiles("skills"))]) {
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

  it("lists every test file in the agent guide", async () => {
    const files = (await readdir("test")).filter((name) => name.endsWith(".test.ts"));
    const guide = await readFile("AGENTS.md", "utf8");
    const missing = files.filter((name) => !guide.includes(`test/${name}`));
    expect(missing).toEqual([]);
  });

  it("documents every timeline transform field in the skill reference", async () => {
    const parsed = parseTimelineDocument({
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "clip",
          track: "v1",
          source: { kind: "image", src: "assets/clip.png" },
          start: 0,
          duration: 1,
          transform: {
            fit: "cover",
            width: 80,
            height: 45,
            x: 0,
            y: 0,
            rotation: 0,
            opacity: 1,
          },
        },
      ],
    });

    expect(parsed.diagnostics).toEqual([]);
    const transform = parsed.timeline?.clips[0]?.transform;
    if (transform === undefined) throw new Error("expected a normalized transform");

    const skill = await readFile("skills/frameyard/references/timelines.md", "utf8");
    for (const field of Object.keys(transform)) {
      expect(skill, `skills/frameyard/references/timelines.md must document transform.${field}`).toContain(
        `\`${field}\``,
      );
    }
  });

  it("keeps a published example in the README and skill", async () => {
    for (const file of ["README.md", "skills/frameyard/SKILL.md"]) {
      expect(await readFile(file, "utf8")).toContain("npx frameyard ");
    }
  });

  it("links a scaffolded project to its agent guide and the full contract", () => {
    const files = scaffoldFiles("frameyard-project");
    expect(files["README.md"]).toContain("AGENTS.md");
    const agents = files["AGENTS.md"] ?? "";
    expect(agents).toContain(`npx frameyard@${VERSION}`);
    expect(agents).toContain("npx skills add vladiantio/frameyard");
  });

  it("states the still frame cap and the policy tier caps in every command document", async () => {
    const policy = await readFile("src/policy.ts", "utf8");
    const cap = /MAX_STILL_FRAMES = (\d+);/.exec(policy)?.[1];
    expect(cap, "src/policy.ts must define MAX_STILL_FRAMES").toBeDefined();
    const tierCaps = [...policy.matchAll(/maxStillFrames: (\d+)/g)].map((match) => match[1] as string);
    const allowed = new Set([cap as string, ...tierCaps]);

    const offenders: string[] = [];
    for (const file of STILL_CAP_DOCS) {
      const contents = await readFile(file, "utf8");
      const values = STILL_CAP_PATTERNS.flatMap((pattern) =>
        [...contents.matchAll(pattern)].map((match) => match[1] as string),
      );
      if (values.length === 0) {
        offenders.push(`${file}: does not state the still frame cap`);
        continue;
      }
      if (!values.includes(cap as string)) {
        offenders.push(`${file}: does not state the library cap of ${cap}`);
      }
      for (const value of values) {
        if (!allowed.has(value)) {
          offenders.push(`${file}: states ${value}, which is not a policy cap (${[...allowed].join(", ")})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
