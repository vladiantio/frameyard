import type {
  CompositionDiagnostic,
  ControllerDeclaration,
  Props,
  PropsSchema,
  ResolvedAudioClip,
  ResolvedCompositionMetadata,
} from "./contracts.js";
import { validateHtmlComposition } from "./html/validate.js";
import { policyDetails, type LoadedResourcePolicy, type PolicyDescription } from "./policy.js";
import type { Project } from "./project.js";
import { summarizeFont, type FontSummary } from "./fonts/summary.js";
import { fontStatuses, verifyFontManifest } from "./fonts/verify.js";
import { resolveProjectTimeline, type ResolvedTimeline, type ResolvedTimelineSource } from "./timeline/resolve.js";

const MAX_CONTEXT_CLIPS = 80;
const MAX_CONTEXT_ASSETS = 50;
const MAX_CONTEXT_FONTS = 20;
const MAX_CONTEXT_PROPS = 40;
const MAX_CONTEXT_CODES = 12;

export interface ContextProp {
  path: string;
  type: string;
}

export interface ContextDiagnosticSummary {
  errors: number;
  warnings: number;
  codes: string[];
}

export interface ContextController {
  kind: "inline" | "external";
  src?: string;
}

export interface ContextComposition {
  id: string;
  entry: string;
  kind: "static" | "animated" | "invalid";
  metadata?: ResolvedCompositionMetadata;
  controller: ContextController | null;
  props: ContextProp[];
  propsSchema?: PropsSchema;
  diagnostics: ContextDiagnosticSummary;
}

export interface ContextTimelineClip {
  id: string;
  track: string;
  kind: "composition" | "timeline" | "video" | "image" | "audio";
  source: string;
  start: number;
  duration: number;
  end: number;
}

export interface ContextTimeline {
  id: string;
  entry: string;
  durationInFrames?: number;
  durationSeconds?: number;
  tracks?: number;
  clips?: ContextTimelineClip[];
  transitions?: number;
  audio?: number;
  transcripts?: number;
  diagnostics: ContextDiagnosticSummary;
}

export interface ContextAsset {
  path: string;
  kind: "video" | "image" | "audio" | "transcript";
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface ProjectContext {
  root: string;
  format?: { width: number; height: number; fps: number };
  policy: PolicyDescription;
  compositions: ContextComposition[];
  timelines: ContextTimeline[];
  assets: ContextAsset[];
  fonts: FontSummary[];
  next: string[];
  truncated: {
    clips: boolean;
    assets: boolean;
    fonts: boolean;
    props: boolean;
  };
  elapsedMs: number;
}

function propType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function describeProps(props: Readonly<Props>): ContextProp[] {
  return Object.entries(props)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_CONTEXT_PROPS)
    .map(([path, value]) => ({ path, type: propType(value) }));
}

function publicController(controller: ControllerDeclaration | null): ContextController | null {
  if (controller === null) {
    return null;
  }
  return {
    kind: controller.kind,
    ...(controller.src !== undefined ? { src: controller.src } : {}),
  };
}

function summarizeDiagnostics(diagnostics: readonly CompositionDiagnostic[]): ContextDiagnosticSummary {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const codes = [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].slice(0, MAX_CONTEXT_CODES);
  return { errors, warnings, codes };
}

function diagnosticsWithFormat(
  diagnostics: readonly CompositionDiagnostic[],
  formatUnresolved: boolean,
): ContextDiagnosticSummary {
  const summary = summarizeDiagnostics(diagnostics);
  if (!formatUnresolved) {
    return summary;
  }
  return {
    errors: summary.errors + 1,
    warnings: summary.warnings,
    codes: [...new Set([...summary.codes, "COMPOSITION_FORMAT_UNRESOLVED"])].slice(0, MAX_CONTEXT_CODES),
  };
}

function clipSourceLabel(source: ResolvedTimelineSource): { kind: ContextTimelineClip["kind"]; value: string } {
  switch (source.kind) {
    case "composition":
      return { kind: "composition", value: source.id };
    case "timeline":
      return { kind: "timeline", value: source.id };
    case "video":
    case "image":
    case "audio":
      return { kind: source.kind, value: source.src };
  }
}

function addAsset(assets: Map<string, ContextAsset>, asset: ContextAsset): void {
  if (assets.size >= MAX_CONTEXT_ASSETS && !assets.has(asset.path)) {
    return;
  }
  const existing = assets.get(asset.path);
  if (existing === undefined) {
    assets.set(asset.path, asset);
    return;
  }
  if (existing.durationSeconds === undefined && asset.durationSeconds !== undefined) {
    existing.durationSeconds = asset.durationSeconds;
  }
  if (existing.width === undefined && asset.width !== undefined) {
    existing.width = asset.width;
  }
  if (existing.height === undefined && asset.height !== undefined) {
    existing.height = asset.height;
  }
}

function addAudioAssets(assets: Map<string, ContextAsset>, clips: readonly ResolvedAudioClip[]): void {
  for (const clip of clips) {
    addAsset(assets, { path: clip.src, kind: "audio" });
  }
}

function collectTimelineAssets(timeline: ResolvedTimeline, assets: Map<string, ContextAsset>): void {
  const fps = timeline.format.fps;
  for (const clip of timeline.clips) {
    const source = clip.source;
    if (source.kind === "video" || source.kind === "image" || source.kind === "audio") {
      addAsset(assets, {
        path: source.src,
        kind: source.kind,
        ...(source.durationInFrames !== undefined ? { durationSeconds: source.durationInFrames / fps } : {}),
        ...(source.width !== undefined ? { width: source.width } : {}),
        ...(source.height !== undefined ? { height: source.height } : {}),
      });
    } else if (source.kind === "composition") {
      addAudioAssets(assets, source.audioClips);
      for (const transcript of source.transcriptClips) {
        addAsset(assets, { path: transcript.src, kind: "transcript" });
      }
    } else if (source.kind === "timeline") {
      collectTimelineAssets(source.timeline, assets);
    }
  }
}

function countAudio(timeline: ResolvedTimeline): number {
  let count = 0;
  for (const clip of timeline.clips) {
    if (clip.source.kind === "audio") {
      count += 1;
    } else if (clip.source.kind === "composition") {
      count += clip.source.audioClips.length;
    }
  }
  return count;
}

function countTranscripts(timeline: ResolvedTimeline): number {
  let count = 0;
  for (const clip of timeline.clips) {
    if (clip.source.kind === "composition") {
      count += clip.source.transcriptClips.length;
    }
  }
  return count;
}

function timelineClips(timeline: ResolvedTimeline): { clips: ContextTimelineClip[]; truncated: boolean } {
  const clips = timeline.clips.slice(0, MAX_CONTEXT_CLIPS).map((clip) => {
    const source = clipSourceLabel(clip.source);
    return {
      id: clip.id,
      track: clip.track,
      kind: source.kind,
      source: source.value,
      start: clip.start,
      duration: clip.duration,
      end: clip.end,
    };
  });
  return { clips, truncated: timeline.clips.length > MAX_CONTEXT_CLIPS };
}

function nextCommands(context: Pick<ProjectContext, "compositions" | "timelines" | "policy">): string[] {
  const target =
    context.timelines.find((timeline) => timeline.durationInFrames !== undefined)?.id ?? context.compositions[0]?.id;
  if (target === undefined) {
    return ["npx frameyard init <directory>"];
  }

  const hasErrors =
    context.compositions.some((composition) => composition.diagnostics.errors > 0) ||
    context.timelines.some((timeline) => timeline.diagnostics.errors > 0);
  if (hasErrors) {
    return [`npx frameyard lint ${target} --json`];
  }

  const commands = [`npx frameyard lint ${target} --json`];
  if (context.policy.policy !== "light") {
    commands.push(`npx frameyard check ${target} --json`);
  }
  commands.push(`npx frameyard still ${target} --frame 0 --json`);
  commands.push(
    context.policy.policy === "full"
      ? `npx frameyard render ${target} --json`
      : `npx frameyard render ${target} --dry-run --json`,
  );
  return commands.slice(0, 4);
}

/** Builds a compact, read-only digest of a project for agents and humans. */
export async function buildProjectContext(options: {
  project: Project;
  policy: LoadedResourcePolicy;
  signal?: AbortSignal;
}): Promise<ProjectContext> {
  const startedAt = performance.now();
  const assets = new Map<string, ContextAsset>();
  const truncated = { clips: false, assets: false, fonts: false, props: false };

  const compositions: ContextComposition[] = [];
  for (const composition of [...options.project.compositions.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const validation = await validateHtmlComposition({
      projectRoot: options.project.root,
      entry: composition.entry,
      ...(options.project.format ? { format: options.project.format } : {}),
    });
    const info = validation.info;
    if (info) {
      addAudioAssets(assets, info.audioClips);
      for (const transcript of info.transcriptClips) {
        addAsset(assets, { path: transcript.src, kind: "transcript" });
      }
    }
    if (info !== null && info.defaultProps !== undefined) {
      if (Object.keys(info.defaultProps).length > MAX_CONTEXT_PROPS) {
        truncated.props = true;
      }
    }
    compositions.push({
      id: composition.id,
      entry: composition.entry,
      kind:
        validation.formatUnresolved || info === null
          ? "invalid"
          : info.metadata.static === true
            ? "static"
            : "animated",
      ...(info !== null ? { metadata: info.metadata } : {}),
      controller: publicController(info?.controller ?? null),
      props: info !== null ? describeProps(info.defaultProps) : [],
      ...(info?.propsSchema !== undefined ? { propsSchema: info.propsSchema } : {}),
      diagnostics: diagnosticsWithFormat(validation.diagnostics, validation.formatUnresolved),
    });
  }

  const timelines: ContextTimeline[] = [];
  for (const projectTimeline of [...options.project.timelines.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const resolved = await resolveProjectTimeline({
      project: options.project,
      timeline: projectTimeline,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const diagnostics = summarizeDiagnostics(resolved.diagnostics);
    if (resolved.timeline === null) {
      timelines.push({
        id: projectTimeline.id,
        entry: projectTimeline.entry,
        diagnostics,
      });
      continue;
    }

    collectTimelineAssets(resolved.timeline, assets);
    const summarized = timelineClips(resolved.timeline);
    if (summarized.truncated) {
      truncated.clips = true;
    }
    timelines.push({
      id: projectTimeline.id,
      entry: projectTimeline.entry,
      durationInFrames: resolved.timeline.durationInFrames,
      durationSeconds: resolved.timeline.durationInFrames / resolved.timeline.format.fps,
      tracks: resolved.timeline.tracks.length,
      clips: summarized.clips,
      transitions: resolved.timeline.transitions.length,
      audio: countAudio(resolved.timeline),
      transcripts: countTranscripts(resolved.timeline),
      diagnostics,
    });
  }

  if (assets.size >= MAX_CONTEXT_ASSETS) {
    truncated.assets = true;
  }

  const fontVerification =
    options.project.fonts === undefined
      ? undefined
      : await verifyFontManifest({
          projectRoot: options.project.root,
          manifest: options.project.fonts,
          hashes: false,
          licenses: false,
          orphans: false,
        });
  const statuses = fontVerification === undefined ? new Map() : fontStatuses(fontVerification);
  const fonts = (options.project.fonts?.fonts ?? [])
    .slice()
    .sort((left, right) => left.family.localeCompare(right.family))
    .map((font) => summarizeFont(font, statuses.get(font.id) ?? "ok"));
  if (fonts.length > MAX_CONTEXT_FONTS) {
    truncated.fonts = true;
  }

  const context: ProjectContext = {
    root: options.project.root,
    ...(options.project.format ? { format: options.project.format } : {}),
    policy: policyDetails(options.policy),
    compositions,
    timelines,
    assets: [...assets.values()]
      .slice(0, MAX_CONTEXT_ASSETS)
      .sort((left, right) => left.path.localeCompare(right.path)),
    fonts: fonts.slice(0, MAX_CONTEXT_FONTS),
    next: [],
    truncated,
    elapsedMs: performance.now() - startedAt,
  };
  context.next = nextCommands(context);
  return context;
}
