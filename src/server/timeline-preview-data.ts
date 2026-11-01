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
      url: `${projectUrl(source.entry)}?__fy-manual=1`,
      width: source.metadata.width,
      height: source.metadata.height,
      durationInFrames: source.metadata.durationInFrames,
    };
  }
  if (source.kind === "timeline") {
    return {
      kind: "timeline",
      id: source.id,
      url: `/__frameyard/timeline/${encodeURIComponent(source.id)}?__fy-embed=1`,
      width: source.timeline.format.width,
      height: source.timeline.format.height,
      durationInFrames: source.durationInFrames,
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
    id: clip.id,
    track: clip.track,
    source: previewSource(clip.source),
    start: clip.start,
    duration: clip.duration,
    end: clip.end,
    sourceIn: clip.sourceIn,
    ...(clip.props !== undefined ? { props: clip.props } : {}),
    transform: clip.transform ?? { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    audio: clip.audio ?? { muted: false, gain: 1 },
  }));

  const audioClips: TimelinePreviewAudioClip[] = audio.clips.map((clip) => ({
    src: clip.src,
    url: projectUrl(clip.src),
    startFrame: clip.startFrame,
    trimStart: clip.trimStart,
    ...(clip.trimDuration !== undefined ? { trimDuration: clip.trimDuration } : {}),
    volume: clip.volume,
  }));

  return {
    timeline: timeline.id,
    entry: timeline.entry,
    format: { ...timeline.format },
    durationInFrames: timeline.durationInFrames,
    ...(timeline.background !== undefined ? { background: timeline.background } : {}),
    tracks: timeline.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      ...(track.name !== undefined ? { name: track.name } : {}),
      ...(track.gain !== undefined ? { gain: track.gain } : {}),
      ...(track.muted !== undefined ? { muted: track.muted } : {}),
    })),
    clips,
    audioClips,
    diagnostics: resolved.diagnostics,
  };
}
