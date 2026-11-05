import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INIT_TEMPLATES = path.join(PACKAGE_ROOT, "scaffolds", "init");
const LOCAL_MODELS_TEMPLATES = path.join(PACKAGE_ROOT, "scaffolds", "local-models");

function readTemplates(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files[path.relative(directory, fullPath).split(path.sep).join("/")] = readFileSync(fullPath, "utf8");
      }
    }
  };
  visit(directory);
  return files;
}

// Keep the generated package name valid for npm and pnpm.
function packageName(projectName: string): string {
  const normalized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 214)
    .replace(/[._-]+$/g, "");
  return normalized === "" ? "frameyard-project" : normalized;
}

function renderTemplates(templates: Record<string, string>, projectName: string): Record<string, string> {
  const name = packageName(projectName);
  return Object.fromEntries(
    Object.entries(templates).map(([file, content]) => [
      file === "gitignore.template" ? ".gitignore" : file,
      content.replaceAll("{{PROJECT_NAME}}", name).replaceAll("{{VERSION}}", VERSION),
    ]),
  );
}

/** Reads the project scaffold templates from `scaffolds/init/`. */
export function scaffoldFiles(projectName: string): Record<string, string> {
  return renderTemplates(readTemplates(INIT_TEMPLATES), projectName);
}

/** Reads the optional local-model host scaffold from `scaffolds/local-models/`. */
export function localModelScaffoldFiles(): Record<string, string> {
  const templates = readTemplates(LOCAL_MODELS_TEMPLATES);
  const files: Record<string, string> = {};
  for (const [file, content] of Object.entries(templates)) {
    if (file.startsWith("opencode/")) {
      files[`.opencode/${file.slice("opencode/".length)}`] = content;
    } else if (file.startsWith("pi/")) {
      files[`.pi/${file.slice("pi/".length)}`] = content;
    } else {
      files[file] = content;
    }
  }
  return files;
}

export const SCAFFOLD_NEXT = [
  "npx frameyard doctor",
  "npx frameyard dev",
  "npx frameyard check main",
  "npx frameyard render main",
];
