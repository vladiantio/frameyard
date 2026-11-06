import { readFile } from "node:fs/promises";
import path from "node:path";
import { COMPOSITION_FORMAT_UNRESOLVED_MESSAGE } from "./composition/index.js";
import type { CompositionDiagnostic, ControllerDeclaration, ResolvedCompositionMetadata } from "./contracts.js";
import { FrameyardError, errorMessage, isFrameyardError } from "./errors.js";
import { validateHtmlComposition } from "./html/validate.js";
import type { Project } from "./project.js";
import { evaluateKeyframeTrack } from "./timeline/keyframes.js";
import { planTimelineRender } from "./timeline/plan.js";
import { resolveProjectTimeline, type ResolvedCompositionSource, type ResolvedTimeline } from "./timeline/resolve.js";
import { projectSceneAtFrame } from "./timeline/scene.js";
import { KEYFRAME_CHANNELS } from "./timeline/schema.js";

export interface LintCompositionResult {
  kind: "composition";
  composition: string;
  entry: string;
  controller: { kind: "inline" } | { kind: "external"; src?: string } | null;
  metadata: ResolvedCompositionMetadata;
  /** Compositions have no scene projection; frame evaluation requires `check`. */
  framesProjected: 0;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export interface LintTimelineResult {
  kind: "timeline";
  timeline: string;
  entry: string;
  format: { width: number; height: number; fps: number };
  durationInFrames: number;
  framesProjected: number;
  tracks: number;
  clips: number;
  transitions: number;
  segments: number;
  diagnostics: CompositionDiagnostic[];
  elapsedMs: number;
}

export type LintResult = LintCompositionResult | LintTimelineResult;

const DETERMINISM_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bMath\.random\s*\(/, label: "Math.random()" },
  { pattern: /\bDate\.now\s*\(/, label: "Date.now()" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, label: "new Date()" },
  { pattern: /\bperformance\.now\s*\(/, label: "performance.now()" },
  { pattern: /\bsetTimeout\s*\(/, label: "setTimeout()" },
  { pattern: /\bsetInterval\s*\(/, label: "setInterval()" },
  { pattern: /\brequestAnimationFrame\s*\(/, label: "requestAnimationFrame()" },
];

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FrameyardError("CANCELLED", "Operation cancelled.");
  }
}

function diagnosticKey(diagnostic: CompositionDiagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.details ?? null]);
}

function addDiagnostic(diagnostics: CompositionDiagnostic[], diagnostic: CompositionDiagnostic): void {
  const key = diagnosticKey(diagnostic);
  if (!diagnostics.some((existing) => diagnosticKey(existing) === key)) {
    diagnostics.push(diagnostic);
  }
}

function lineColumnAt(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

function publicController(controller: ControllerDeclaration | null): LintCompositionResult["controller"] {
  if (controller === null) {
    return null;
  }
  if (controller.kind === "external") {
    return {
      kind: "external",
      ...(controller.src !== undefined ? { src: controller.src } : {}),
    };
  }
  return { kind: "inline" };
}

async function scanController(
  controller: ControllerDeclaration | null,
  entry: string,
  projectRoot: string,
): Promise<CompositionDiagnostic[]> {
  if (controller === null) {
    return [];
  }

  let source: string | undefined;
  let sourcePath: string | undefined;
  if (controller.kind === "inline") {
    source = controller.source;
    sourcePath = entry;
  } else if (controller.src !== undefined) {
    sourcePath = controller.src;
    try {
      source = await readFile(path.resolve(projectRoot, controller.src), "utf8");
    } catch {
      return [];
    }
  }

  if (source === undefined) {
    return [];
  }

  const diagnostics: CompositionDiagnostic[] = [];
  for (const { pattern, label } of DETERMINISM_PATTERNS) {
    const index = source.search(pattern);
    if (index === -1) {
      continue;
    }
    const position = lineColumnAt(source, index);
    const line = controller.kind === "inline" ? (controller.line ?? 1) + position.line - 1 : position.line;
    const column =
      controller.kind === "inline" && position.line === 1
        ? (controller.column ?? 1) + position.column - 1
        : position.column;
    diagnostics.push({
      severity: "warning",
      code: "DETERMINISM_WARNING",
      message: `Controller source uses ${label}; derive animation from frame and props instead.`,
      details: {
        ...(sourcePath !== undefined ? { path: sourcePath } : {}),
        line,
        column,
        controller: { kind: controller.kind },
        suggestion: 'Use frame/props or random("stable:key") from frameyard/runtime.',
      },
    });
  }
  return diagnostics;
}

function collectCompositionSources(timeline: ResolvedTimeline, sources: ResolvedCompositionSource[]): void {
  for (const clip of timeline.clips) {
    if (clip.source.kind === "composition") {
      sources.push(clip.source);
    } else if (clip.source.kind === "timeline") {
      collectCompositionSources(clip.source.timeline, sources);
    }
  }
}

function controllerKey(source: ResolvedCompositionSource): string {
  const controller = source.controller;
  return [source.entry, controller?.kind ?? "none", controller?.src ?? "", controller?.source ?? ""].join("\u0000");
}

/**
 * Validates a resolved timeline and projects every frame without launching
 * Chromium. This catches scene and keyframe channel errors before `check`.
 */
export async function lintResolvedTimeline(options: {
  timeline: ResolvedTimeline;
  projectRoot: string;
  diagnostics: readonly CompositionDiagnostic[];
  signal?: AbortSignal;
}): Promise<LintTimelineResult> {
  const startedAt = performance.now();
  const { timeline } = options;
  const diagnostics: CompositionDiagnostic[] = [...options.diagnostics];

  const sources: ResolvedCompositionSource[] = [];
  collectCompositionSources(timeline, sources);
  const scanned = new Set<string>();
  for (const source of sources) {
    const key = controllerKey(source);
    if (scanned.has(key)) {
      continue;
    }
    scanned.add(key);
    for (const diagnostic of await scanController(source.controller, source.entry, options.projectRoot)) {
      addDiagnostic(diagnostics, diagnostic);
    }
  }

  for (let frame = 0; frame < timeline.durationInFrames; frame += 1) {
    throwIfAborted(options.signal);
    let scene;
    try {
      scene = projectSceneAtFrame(timeline, frame);
    } catch (error) {
      addDiagnostic(diagnostics, {
        severity: "error",
        code: isFrameyardError(error) ? error.code : "TIMELINE_CLIP_INVALID",
        message: `Timeline frame ${frame}: ${errorMessage(error)}`,
        details: { timeline: timeline.id, timelineFrame: frame },
      });
      continue;
    }

    for (const layer of scene.layers) {
      if (layer.keyframes === undefined) {
        continue;
      }
      const localFrame = frame - layer.clip.start;
      for (const channel of KEYFRAME_CHANNELS) {
        const track = layer.keyframes[channel];
        if (track === undefined) {
          continue;
        }
        try {
          evaluateKeyframeTrack(track, localFrame);
        } catch (error) {
          addDiagnostic(diagnostics, {
            severity: "error",
            code: isFrameyardError(error) ? error.code : "TIMELINE_CLIP_INVALID",
            message: `Timeline frame ${frame}, clip "${layer.clip.id}" channel ${channel}: ${errorMessage(error)}`,
            details: {
              timeline: timeline.id,
              clip: layer.clip.id,
              channel,
              timelineFrame: frame,
              frame: localFrame,
            },
          });
        }
      }
    }
  }

  const plan = planTimelineRender(timeline);

  return {
    kind: "timeline",
    timeline: timeline.id,
    entry: timeline.entry,
    format: timeline.format,
    durationInFrames: timeline.durationInFrames,
    framesProjected: timeline.durationInFrames,
    tracks: timeline.tracks.length,
    clips: timeline.clips.length,
    transitions: timeline.transitions.length,
    segments: plan.segments.length,
    diagnostics,
    elapsedMs: performance.now() - startedAt,
  };
}

/** Validates one composition document and its controller source without Chromium. */
export async function lintComposition(options: {
  project: Project;
  compositionId: string;
  props?: unknown;
  signal?: AbortSignal;
}): Promise<LintCompositionResult> {
  throwIfAborted(options.signal);
  const startedAt = performance.now();
  const composition = options.project.compositions.get(options.compositionId);
  if (!composition) {
    const available = [...options.project.compositions.keys()].join(", ") || "(none)";
    throw new FrameyardError(
      "COMPOSITION_NOT_FOUND",
      `Composition "${options.compositionId}" is not listed in fy.config.js. Available: ${available}.`,
    );
  }

  const validation = await validateHtmlComposition({
    projectRoot: options.project.root,
    entry: composition.entry,
    props: options.props,
    ...(options.project.format ? { format: options.project.format } : {}),
  });
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!validation.info || errors.length > 0) {
    const first = errors[0];
    if (!first && validation.formatUnresolved) {
      throw new FrameyardError(
        "COMPOSITION_FORMAT_UNRESOLVED",
        `Composition "${options.compositionId}": ${COMPOSITION_FORMAT_UNRESOLVED_MESSAGE}`,
        { diagnostics: validation.diagnostics },
      );
    }
    throw new FrameyardError(
      first?.code ?? "COMPOSITION_INVALID",
      `Composition "${options.compositionId}": ${first?.message ?? "static validation failed."}`,
      { diagnostics: validation.diagnostics },
    );
  }

  const diagnostics = [...validation.diagnostics];
  for (const diagnostic of await scanController(validation.info.controller, composition.entry, options.project.root)) {
    addDiagnostic(diagnostics, diagnostic);
  }

  return {
    kind: "composition",
    composition: options.compositionId,
    entry: composition.entry,
    controller: publicController(validation.info.controller),
    metadata: validation.info.metadata,
    framesProjected: 0,
    diagnostics,
    elapsedMs: performance.now() - startedAt,
  };
}

/** Validates a project timeline without capturing frames or launching Chromium. */
export async function lintTimeline(options: {
  project: Project;
  timelineId: string;
  propsOverrides?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<LintTimelineResult> {
  throwIfAborted(options.signal);
  const projectTimeline = options.project.timelines.get(options.timelineId);
  if (!projectTimeline) {
    throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${options.timelineId}" is not listed in fy.config.js.`);
  }

  const resolved = await resolveProjectTimeline({
    project: options.project,
    timeline: projectTimeline,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.propsOverrides ? { propsOverrides: options.propsOverrides } : {}),
  });
  const firstError = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (!resolved.timeline || firstError) {
    throw new FrameyardError(
      firstError?.code ?? "TIMELINE_INVALID",
      firstError?.message ?? "Timeline resolution failed.",
      { diagnostics: resolved.diagnostics },
    );
  }

  const result = await lintResolvedTimeline({
    timeline: resolved.timeline,
    projectRoot: options.project.root,
    diagnostics: resolved.diagnostics,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const lintError = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (lintError) {
    throw new FrameyardError(lintError.code, lintError.message, { diagnostics: result.diagnostics });
  }
  return result;
}
