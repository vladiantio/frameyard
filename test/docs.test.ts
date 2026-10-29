import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("documentation command examples", () => {
  it("uses the published CLI in user-facing examples", async () => {
    const files = ["README.md", ...(await markdownFiles("skill"))];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const markdown = file === "README.md" ? beforeDevelopment(source) : source;
      for (const block of shellBlocks(markdown)) {
        for (const line of block) {
          if (/^\s*(?:frameyard(?:\s|$)|node\s+(?:\.\.?\/)?dist\/cli\.js(?:\s|$))/.test(line)) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps a published example in the README and skill", async () => {
    for (const file of ["README.md", "skill/SKILL.md"]) {
      expect(await readFile(file, "utf8")).toContain("npx frameyard ");
    }
  });
});
