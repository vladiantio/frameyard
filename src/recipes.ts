import { findTemplate, type TemplateKind } from "./templates.js";

export type RecipeKind = "composition" | "timeline" | "bundle";

export interface RecipeFile {
  /** Project-relative path template; `{id}` is replaced with the project id. */
  path: string;
  /** File content for a project id. */
  content: (id: string) => string;
}

export interface RecipeEntry {
  kind: TemplateKind;
  /** Project id template; `{id}` is replaced with the project id. */
  id: string;
  /** Project-relative entry path template; `{id}` is replaced with the project id. */
  entry: string;
}

export interface ProjectRecipe {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  kind: RecipeKind;
  files: readonly RecipeFile[];
  entries: readonly RecipeEntry[];
  prerequisites?: readonly string[];
}

export interface RecipeInstallFile {
  path: string;
  content: string;
}

export interface RecipeInstallEntry {
  kind: TemplateKind;
  id: string;
  entry: string;
}

export interface RecipeInstallPlan {
  files: RecipeInstallFile[];
  entries: RecipeInstallEntry[];
}

function builtInTemplate(name: string): string {
  const template = findTemplate(name);
  if (template === undefined) {
    throw new Error(`Built-in template "${name}" is missing.`);
  }
  return template.content;
}

const lowerThirdProps = `{
  "name": "Ada Lovelace",
  "role": "Computing pioneer",
  "accent": "#ff7a45"
}
`;

function lowerThirdTimeline(id: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [
        {
          id: "lower-third",
          track: "v1",
          source: { kind: "composition", id },
          start: 0,
          duration: 120,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function lowerThirdReadme(id: string): string {
  const timelineId = `${id}-timeline`;
  return [
    `# ${id}`,
    "",
    "Recipe: **Lower third**",
    "",
    "Files:",
    `- \`compositions/${id}.html\``,
    `- \`timelines/${timelineId}.timeline.json\``,
    `- \`props/${id}.json\``,
    "",
    "Register both entries in `fy.config.js`:",
    "",
    "```js",
    "export default {",
    "  format: { width: 1920, height: 1080, fps: 30 },",
    `  compositions: { "${id}": "./compositions/${id}.html" },`,
    `  timelines: { "${timelineId}": "./timelines/${timelineId}.timeline.json" },`,
    "};",
    "```",
    "",
    "Preview and render:",
    "",
    "```sh",
    "npx frameyard dev",
    `npx frameyard check ${timelineId}`,
    `npx frameyard still ${id} --frame 30 --out out/${id}.png`,
    `npx frameyard render ${timelineId}`,
    "```",
    "",
  ].join("\n");
}

export const RECIPES: readonly ProjectRecipe[] = [
  {
    id: "lower-third",
    title: "Lower third",
    description: "A 120-frame name and role lower third, its timeline, props, and README.",
    tags: ["lower-third", "overlay", "title"],
    kind: "bundle",
    files: [
      {
        path: "compositions/{id}.html",
        content: () => builtInTemplate("lower-third"),
      },
      {
        path: "timelines/{id}-timeline.timeline.json",
        content: lowerThirdTimeline,
      },
      {
        path: "props/{id}.json",
        content: () => lowerThirdProps,
      },
      {
        path: "recipes/{id}.md",
        content: lowerThirdReadme,
      },
    ],
    entries: [
      {
        kind: "composition",
        id: "{id}",
        entry: "compositions/{id}.html",
      },
      {
        kind: "timeline",
        id: "{id}-timeline",
        entry: "timelines/{id}-timeline.timeline.json",
      },
    ],
  },
];

export function findRecipe(id: string): ProjectRecipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}

export function listRecipes(): ProjectRecipe[] {
  return [...RECIPES];
}

function hydrate(template: string, id: string): string {
  return template.replaceAll("{id}", id);
}

export function recipeInstallPlan(recipe: ProjectRecipe, id: string): RecipeInstallPlan {
  return {
    files: recipe.files.map((file) => ({
      path: hydrate(file.path, id),
      content: file.content(id),
    })),
    entries: recipe.entries.map((entry) => ({
      kind: entry.kind,
      id: hydrate(entry.id, id),
      entry: hydrate(entry.entry, id),
    })),
  };
}

export function recipeRegistration(
  recipe: ProjectRecipe,
  id: string,
): Record<"compositions" | "timelines", Record<string, string> | undefined> {
  const compositions: Record<string, string> = {};
  const timelines: Record<string, string> = {};

  for (const entry of recipeInstallPlan(recipe, id).entries) {
    const target = `./${entry.entry}`;
    if (entry.kind === "composition") {
      compositions[entry.id] = target;
    } else {
      timelines[entry.id] = target;
    }
  }

  return {
    compositions: Object.keys(compositions).length > 0 ? compositions : undefined,
    timelines: Object.keys(timelines).length > 0 ? timelines : undefined,
  };
}
