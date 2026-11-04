import { describe, expect, it } from "vitest";
import { projectScene, projectSceneAtFrame, transitionSpans } from "../src/timeline/scene.ts";
import type {
  ResolvedCompositionSource,
  ResolvedMediaSource,
  ResolvedNestedTimelineSource,
  ResolvedTimeline,
  ResolvedTimelineClip,
} from "../src/timeline/resolve.ts";

const format = { width: 1920, height: 1080, fps: 30 };

function compositionSource(
  id: string,
  options: { static?: boolean; width?: number; height?: number } = {},
): ResolvedCompositionSource {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  if (options.static) {
    return {
      kind: "composition",
      id,
      entry: `compositions/${id}.html`,
      metadata: { width, height, static: true },
      controller: null,
      audioClips: [],
      embeddedAudioClips: [],
      transcriptClips: [],
    };
  }
  return {
    kind: "composition",
    id,
    entry: `compositions/${id}.html`,
    metadata: { width, height, fps: 30, durationInFrames: 1000 },
    controller: null,
    durationInFrames: 1000,
    audioClips: [],
    embeddedAudioClips: [],
    transcriptClips: [],
  };
}

function mediaSource(
  kind: "video" | "image",
  id: string,
  options: { width?: number; height?: number } = {},
): ResolvedMediaSource {
  return {
    kind,
    src: `assets/${id}.${kind === "video" ? "mp4" : "png"}`,
    absolutePath: `/tmp/${id}.${kind === "video" ? "mp4" : "png"}`,
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    hasVideo: kind === "video",
    hasAudio: false,
  };
}

function nestedSource(id: string): ResolvedNestedTimelineSource {
  return {
    kind: "timeline",
    id,
    entry: `timelines/${id}.json`,
    durationInFrames: 90,
    timeline: {
      id,
      entry: `timelines/${id}.json`,
      format: { width: 1280, height: 720, fps: 30 },
      durationInFrames: 90,
      tracks: [{ id: "v1", kind: "video" }],
      clips: [],
      transitions: [],
    },
  };
}

function clip(options: {
  id: string;
  track: string;
  start: number;
  duration: number;
  source?: ResolvedTimelineClip["source"];
  sourceIn?: number;
  transform?: ResolvedTimelineClip["transform"];
  keyframes?: ResolvedTimelineClip["keyframes"];
  blend?: ResolvedTimelineClip["blend"];
}): ResolvedTimelineClip {
  return {
    id: options.id,
    track: options.track,
    source: options.source ?? compositionSource("intro"),
    start: options.start,
    duration: options.duration,
    end: options.start + options.duration,
    sourceIn: options.sourceIn ?? 0,
    ...(options.transform !== undefined ? { transform: options.transform } : {}),
    ...(options.keyframes !== undefined ? { keyframes: options.keyframes } : {}),
    ...(options.blend !== undefined ? { blend: options.blend } : {}),
  };
}

function timeline(
  clips: ResolvedTimelineClip[],
  durationInFrames = 100,
  transitions: ResolvedTimeline["transitions"] = [],
  tracks: ResolvedTimeline["tracks"] = [
    { id: "v1", kind: "video" },
    { id: "v2", kind: "video" },
    { id: "a1", kind: "audio", gain: 1, muted: false },
  ],
): ResolvedTimeline {
  return {
    id: "main",
    entry: "timelines/main.json",
    format,
    durationInFrames,
    tracks,
    clips,
    transitions,
  };
}

describe("timeline scene projection", () => {
  it("projects active visual layers in composite order", () => {
    const a = clip({ id: "a", track: "v1", start: 0, duration: 10, sourceIn: 2 });
    const b = clip({ id: "b", track: "v1", start: 10, duration: 10 });
    const c = clip({
      id: "c",
      track: "v2",
      start: 0,
      duration: 20,
      source: mediaSource("image", "backdrop", { width: 640, height: 360 }),
    });
    const audio = clip({
      id: "chime",
      track: "a1",
      start: 0,
      duration: 20,
      source: {
        kind: "audio",
        src: "assets/chime.wav",
        absolutePath: "/tmp/chime.wav",
        hasVideo: false,
        hasAudio: true,
      },
    });

    const scene = projectScene(timeline([a, b, c, audio], 30), 5, 10);

    expect(scene.start).toBe(5);
    expect(scene.end).toBe(10);
    expect(scene.layers.map((layer) => layer.clip.id)).toEqual(["a", "c"]);
    const first = scene.layers[0];
    expect(first?.sourceStart).toBe(7);
    expect(first?.capture).toBe("frames");
    expect(first?.sourceWidth).toBe(1920);
    expect(first?.sourceHeight).toBe(1080);
    expect(first?.transform).toEqual({ fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
    expect(first?.blend).toBe("normal");
    expect(first?.transition).toBeUndefined();
  });

  it("attaches transition roles and stacks the incoming clip above the outgoing clip", () => {
    const a = clip({ id: "a", track: "v1", start: 0, duration: 10 });
    const b = clip({ id: "b", track: "v1", start: 6, duration: 10 });
    const main = timeline([a, b], 16, [{ from: "a", to: "b", kind: "dissolve", track: "v1", start: 6, end: 10 }]);

    const inWindow = projectSceneAtFrame(main, 7);
    expect(inWindow.layers.map((layer) => [layer.clip.id, layer.transition?.role ?? null])).toEqual([
      ["a", "out"],
      ["b", "in"],
    ]);
    expect(inWindow.layers[1]?.sourceStart).toBe(1);
    expect(inWindow.layers[1]?.transition).toEqual({
      window: { start: 6, end: 10 },
      role: "in",
    });

    const before = projectScene(main, 0, 6);
    expect(before.layers.map((layer) => layer.clip.id)).toEqual(["a"]);
    expect(before.layers[0]?.transition).toBeUndefined();

    const after = projectScene(main, 10, 16);
    expect(after.layers.map((layer) => layer.clip.id)).toEqual(["b"]);
    expect(after.layers[0]?.transition).toBeUndefined();
  });

  it("keeps transition windows independent of the projected range", () => {
    const main = timeline(
      [clip({ id: "a", track: "v1", start: 0, duration: 12 }), clip({ id: "b", track: "v1", start: 8, duration: 12 })],
      20,
      [{ from: "a", to: "b", kind: "dissolve", easing: "ease-in-out", track: "v1", start: 8, end: 12 }],
    );

    for (let start = 0; start < 20; start += 2) {
      const scene = projectScene(main, start, Math.min(start + 2, 20));
      for (const layer of scene.layers) {
        if (layer.transition) {
          expect(layer.transition.window).toEqual({ start: 8, end: 12, easing: "ease-in-out" });
        }
      }
    }
  });

  it("classifies capture modes and reports natural source sizes", () => {
    const main = timeline(
      [
        clip({ id: "animated", track: "v1", start: 0, duration: 20, source: compositionSource("animated") }),
        clip({
          id: "static",
          track: "v2",
          start: 0,
          duration: 20,
          source: compositionSource("static", { static: true, width: 800, height: 600 }),
        }),
        clip({
          id: "video",
          track: "v3",
          start: 0,
          duration: 20,
          source: mediaSource("video", "clip", { width: 640, height: 360 }),
        }),
        clip({
          id: "image",
          track: "v4",
          start: 0,
          duration: 20,
          source: mediaSource("image", "still", { width: 320, height: 240 }),
        }),
        clip({ id: "nested", track: "v5", start: 0, duration: 20, source: nestedSource("inner") }),
      ],
      20,
      [],
      [
        { id: "v1", kind: "video" },
        { id: "v2", kind: "video" },
        { id: "v3", kind: "video" },
        { id: "v4", kind: "video" },
        { id: "v5", kind: "video" },
      ],
    );

    const scene = projectScene(main, 0, 20);
    expect(scene.layers.map((layer) => [layer.clip.id, layer.capture, layer.sourceWidth, layer.sourceHeight])).toEqual([
      ["animated", "frames", 1920, 1080],
      ["static", "still", 800, 600],
      ["video", "video", 640, 360],
      ["image", "image", 320, 240],
      ["nested", "nested", 1280, 720],
    ]);
  });

  it("materializes presentation and keeps declared keyframes and blend", () => {
    const transform = { fit: "cover" as const, x: 12, y: -4, scale: 1.5, rotation: 30, opacity: 0.8 };
    const keyframes = {
      scale: [
        { frame: 0, value: 1 },
        { frame: 10, value: 2 },
      ],
    };
    const main = timeline([
      clip({ id: "keyed", track: "v1", start: 0, duration: 10, transform, keyframes, blend: "screen" }),
    ]);

    const scene = projectSceneAtFrame(main, 4);
    const layer = scene.layers[0];
    expect(layer?.transform).toEqual(transform);
    expect(layer?.keyframes).toEqual(keyframes);
    expect(layer?.blend).toBe("screen");
  });

  it("pairs visual and audio transitions once", () => {
    const main = timeline(
      [
        clip({ id: "a", track: "v1", start: 0, duration: 10 }),
        clip({ id: "b", track: "v1", start: 6, duration: 10 }),
        clip({
          id: "one",
          track: "a1",
          start: 0,
          duration: 10,
          source: {
            kind: "audio",
            src: "assets/one.wav",
            absolutePath: "/tmp/one.wav",
            hasVideo: false,
            hasAudio: true,
          },
        }),
        clip({
          id: "two",
          track: "a1",
          start: 6,
          duration: 10,
          source: {
            kind: "audio",
            src: "assets/two.wav",
            absolutePath: "/tmp/two.wav",
            hasVideo: false,
            hasAudio: true,
          },
        }),
      ],
      16,
      [
        { from: "a", to: "b", kind: "dissolve", track: "v1", start: 6, end: 10 },
        { from: "one", to: "two", kind: "crossfade", track: "a1", start: 6, end: 10 },
      ],
    );

    const spans = transitionSpans(main);
    expect(spans.get("a")).toEqual([{ role: "out", start: 6, end: 10 }]);
    expect(spans.get("b")).toEqual([{ role: "in", start: 6, end: 10 }]);
    expect(spans.get("one")).toEqual([{ role: "out", start: 6, end: 10 }]);
    expect(spans.get("two")).toEqual([{ role: "in", start: 6, end: 10 }]);

    const scene = projectSceneAtFrame(main, 7);
    expect(scene.layers.map((layer) => layer.clip.id)).toEqual(["a", "b"]);
  });

  it("rejects an invalid range and missing media dimensions", () => {
    const main = timeline([clip({ id: "a", track: "v1", start: 0, duration: 10 })], 10);
    expect(() => projectScene(main, 5, 5)).toThrow(/Invalid timeline range/);
    expect(() => projectScene(main, -1, 2)).toThrow(/Invalid timeline range/);
    expect(() => projectScene(main, 0, 11)).toThrow(/Invalid timeline range/);
    expect(() => projectScene(main, 0.5, 1)).toThrow(/Invalid timeline range/);

    const missing = timeline([
      clip({
        id: "broken",
        track: "v1",
        start: 0,
        duration: 10,
        source: mediaSource("image", "broken", { width: undefined, height: undefined }),
      }),
    ]);
    expect(() => projectScene(missing, 0, 5)).toThrow(/missing width\/height metadata for clip "broken"/);
  });
});
