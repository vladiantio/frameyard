import type { Project } from "../project.js";
import { FrameyardError } from "../errors.js";
import { resolveProjectTimeline, type ResolvedTimelineSource } from "../timeline/resolve.js";
import { resolveTimelineAudio } from "../renderer/timeline.js";
import type {
  TimelinePreviewAudioClip,
  TimelinePreviewClip,
  TimelinePreviewData,
  TimelinePreviewSource,
} from "../preview/timeline-data.js";

function projectUrl(relative: string): string {
  return `/${relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function previewSource(source: ResolvedTimelineSource): TimelinePreviewSource {
  if (source.kind === "composition") {
    return {
      kind: "composition",
      id: source.id,
      metadata: source.metadata,
      url: `${projectUrl(source.entry)}?__fy-manual=1`,
    };
  }
  if (source.kind === "timeline") {
    return {
      kind: "timeline",
      id: source.id,
      durationInFrames: source.durationInFrames,
      timeline: {
        format: source.timeline.format,
        durationInFrames: source.timeline.durationInFrames,
        ...(source.timeline.background !== undefined ? { background: source.timeline.background } : {}),
      },
      url: `/__frameyard/timeline/${encodeURIComponent(source.id)}?__fy-embed=1`,
    };
  }
  return {
    kind: source.kind,
    src: source.src,
    url: projectUrl(source.src),
    ...(source.width !== undefined ? { width: source.width } : {}),
    ...(source.height !== undefined ? { height: source.height } : {}),
    ...(source.durationInFrames !== undefined ? { durationInFrames: source.durationInFrames } : {}),
    ...(source.kind === "image" ? {} : { hasAudio: source.hasAudio }),
  };
}

export async function buildTimelinePreviewData(
  project: Project,
  timelineId: string,
  signal?: AbortSignal,
): Promise<TimelinePreviewData> {
  const projectTimeline = project.timelines.get(timelineId);
  if (!projectTimeline) {
    throw new FrameyardError("TIMELINE_NOT_FOUND", `Timeline "${timelineId}" is not listed in video.config.js.`);
  }

  const resolved = await resolveProjectTimeline({
    project,
    timeline: projectTimeline,
    ...(signal ? { signal } : {}),
  });
  if (!resolved.timeline) {
    const first = resolved.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new FrameyardError(first?.code ?? "TIMELINE_INVALID", first?.message ?? "Timeline resolution failed.", {
      diagnostics: resolved.diagnostics,
    });
  }

  const timeline = resolved.timeline;
  const audio = resolveTimelineAudio(timeline);
  const clips: TimelinePreviewClip[] = timeline.clips.map((clip) => ({
    ...clip,
    source: previewSource(clip.source),
  }));

  const audioClips: TimelinePreviewAudioClip[] = audio.clips.map((clip) => ({
    src: clip.src,
    url: projectUrl(clip.src),
    startFrame: clip.startFrame,
    trimStart: clip.trimStart,
    ...(clip.trimDuration !== undefined ? { trimDuration: clip.trimDuration } : {}),
    volume: clip.volume,
    ...(clip.envelopes !== undefined ? { envelopes: clip.envelopes } : {}),
  }));

  return {
    timeline: timeline.id,
    entry: timeline.entry,
    format: { ...timeline.format },
    durationInFrames: timeline.durationInFrames,
    ...(timeline.background !== undefined ? { background: timeline.background } : {}),
    tracks: timeline.tracks,
    clips,
    transitions: timeline.transitions,
    audioClips,
    diagnostics: resolved.diagnostics,
  };
}
