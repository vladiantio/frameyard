import { describe, expect, it } from "vitest";
import { planTimelineRender } from "../src/timeline/plan.ts";
import type { ResolvedTimeline, ResolvedTimelineClip } from "../src/timeline/resolve.ts";

const format = { width: 1920, height: 1080, fps: 30 };

function compositionSource(id: string, durationInFrames: number) {
  return {
    kind: "composition" as const,
    id,
    entry: `compositions/${id}.html`,
    metadata: { width: 1920, height: 1080, fps: 30, durationInFrames },
    controller: null,
    durationInFrames,
    audioClips: [],
    embeddedAudioClips: [],
    transcriptClips: [],
  };
}

function clip(options: {
  id: string;
  track: string;
  start: number;
  duration: number;
  source?: ResolvedTimelineClip["source"];
}): ResolvedTimelineClip {
  return {
    id: options.id,
    track: options.track,
    source: options.source ?? compositionSource("intro", 1000),
    start: options.start,
    duration: options.duration,
    end: options.start + options.duration,
    sourceIn: 0,
    transform: { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  };
}

function timeline(clips: ResolvedTimelineClip[], durationInFrames = 100): ResolvedTimeline {
  return {
    id: "main",
    entry: "timelines/main.json",
    format,
    durationInFrames,
    tracks: [
      { id: "v1", kind: "video" },
      { id: "v2", kind: "video" },
      { id: "a1", kind: "audio", gain: 1, muted: false },
    ],
    clips,
    transitions: [],
  };
}

describe("timeline render planning", () => {
  it("splits at clip boundaries and respects the maximum segment length", () => {
    const plan = planTimelineRender(
      timeline(
        [
          clip({ id: "a", track: "v1", start: 0, duration: 10 }),
          clip({ id: "b", track: "v1", start: 10, duration: 10 }),
        ],
        20,
      ),
      { maxSegmentFrames: 5 },
    );

    expect(
      plan.segments.map((segment) => [segment.start, segment.end, segment.layers.map((layer) => layer.clip.id)]),
    ).toEqual([
      [0, 5, ["a"]],
      [5, 10, ["a"]],
      [10, 15, ["b"]],
      [15, 20, ["b"]],
    ]);
  });

  it("orders layers by video track from bottom to top", () => {
    const plan = planTimelineRender(
      timeline(
        [
          clip({ id: "top", track: "v2", start: 0, duration: 10 }),
          clip({ id: "base", track: "v1", start: 0, duration: 10 }),
        ],
        10,
      ),
      { maxSegmentFrames: 10 },
    );

    expect(plan.segments[0]?.layers.map((layer) => layer.clip.id)).toEqual(["base", "top"]);
  });

  it("excludes audio clips and preserves gaps with no layers", () => {
    const audio = clip({
      id: "music",
      track: "a1",
      start: 0,
      duration: 10,
      source: {
        kind: "audio",
        src: "assets/music.wav",
        absolutePath: "/project/assets/music.wav",
        durationInFrames: 300,
        hasVideo: false,
        hasAudio: true,
      },
    });
    const plan = planTimelineRender(timeline([audio, clip({ id: "video", track: "v1", start: 5, duration: 5 })], 15), {
      maxSegmentFrames: 50,
    });

    expect(
      plan.segments.map((segment) => [segment.start, segment.end, segment.layers.map((layer) => layer.clip.id)]),
    ).toEqual([
      [0, 5, []],
      [5, 10, ["video"]],
      [10, 15, []],
    ]);
  });

  it("plans a range of a nested timeline", () => {
    const plan = planTimelineRender(
      timeline(
        [
          clip({ id: "before", track: "v1", start: 0, duration: 20 }),
          clip({ id: "middle", track: "v1", start: 20, duration: 20 }),
          clip({ id: "after", track: "v1", start: 40, duration: 20 }),
        ],
        60,
      ),
      { startFrame: 25, endFrame: 35, maxSegmentFrames: 5 },
    );

    expect(
      plan.segments.map((segment) => [segment.start, segment.end, segment.layers.map((layer) => layer.clip.id)]),
    ).toEqual([
      [25, 30, ["middle"]],
      [30, 35, ["middle"]],
    ]);
  });

  it("rejects an invalid maximum segment length", () => {
    expect(() => planTimelineRender(timeline([]), { maxSegmentFrames: 0 })).toThrow(/positive integer/);
    expect(() => planTimelineRender(timeline([]), { maxSegmentFrames: 1.5 })).toThrow(/positive integer/);
    expect(() => planTimelineRender(timeline([]), { startFrame: 10, endFrame: 10 })).toThrow(/Invalid timeline range/);
  });
});
