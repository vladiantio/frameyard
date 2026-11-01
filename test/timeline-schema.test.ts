import { describe, expect, it } from "vitest";
import { parseTimelineDocument } from "../src/index.ts";

function validTimeline(): Record<string, unknown> {
  return {
    version: 1,
    name: "Main",
    background: "#000000",
    durationInFrames: 240,
    tracks: [
      { id: "v1", kind: "video" },
      { id: "a1", kind: "audio", gain: 0.5, muted: false },
    ],
    clips: [
      {
        id: "intro",
        track: "v1",
        source: { kind: "composition", id: "intro" },
        start: 0,
        duration: 120,
        props: { title: "Hello" },
      },
      {
        id: "broll",
        track: "v1",
        source: { kind: "video", src: "assets/broll.mp4" },
        start: 120,
        duration: 60,
        sourceIn: 30,
      },
      {
        id: "logo",
        track: "v1",
        source: { kind: "image", src: "assets/logo.png" },
        start: 180,
        duration: 30,
        transform: { fit: "cover", x: 10, y: -20, scale: 0.5, rotation: 5, opacity: 0.8 },
      },
      {
        id: "music",
        track: "a1",
        source: { kind: "audio", src: "assets/music.wav" },
        start: 0,
        duration: 210,
        audio: { gain: 0.4 },
      },
    ],
  };
}

function codes(value: unknown): string[] {
  return parseTimelineDocument(value).diagnostics.map((diagnostic) => diagnostic.code);
}

describe("timeline schema", () => {
  it("normalizes a valid timeline and applies defaults", () => {
    const parsed = parseTimelineDocument(validTimeline());

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.tracks).toEqual([
      { id: "v1", kind: "video" },
      { id: "a1", kind: "audio", gain: 0.5, muted: false },
    ]);
    expect(parsed.timeline?.clips[0]).toMatchObject({
      id: "intro",
      track: "v1",
      sourceIn: 0,
      transform: { fit: "contain", x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      audio: { muted: false, gain: 1 },
      props: { title: "Hello" },
    });
    expect(parsed.timeline?.clips[1]).toMatchObject({
      id: "broll",
      sourceIn: 30,
      transform: { fit: "contain" },
      audio: { muted: false, gain: 1 },
    });
    expect(parsed.timeline?.clips[2]).toMatchObject({
      id: "logo",
      transform: { fit: "cover", x: 10, y: -20, scale: 0.5, rotation: 5, opacity: 0.8 },
    });
    expect(parsed.timeline?.clips[3]).toMatchObject({
      id: "music",
      sourceIn: 0,
      audio: { muted: false, gain: 0.4 },
    });
  });

  it("accepts nested timeline clips", () => {
    const value = validTimeline();
    (value.clips as unknown[]).push({
      id: "nested",
      track: "v1",
      source: { kind: "timeline", id: "lower-third" },
      start: 210,
      duration: 30,
    });

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.clips.at(-1)?.source).toEqual({ kind: "timeline", id: "lower-third" });
  });

  it("rejects unknown root, track, clip, source, transform, and audio fields", () => {
    const root = validTimeline();
    root.extra = true;
    expect(codes(root)).toContain("TIMELINE_INVALID");

    const track = validTimeline();
    (track.tracks as Record<string, unknown>[])[0]!.hidden = true;
    expect(codes(track)).toContain("TIMELINE_TRACK_INVALID");

    const clip = validTimeline();
    (clip.clips as Record<string, unknown>[])[0]!.label = "Intro";
    expect(codes(clip)).toContain("TIMELINE_CLIP_INVALID");

    const source = validTimeline();
    ((source.clips as Record<string, unknown>[])[0]!.source as Record<string, unknown>).path = "intro.html";
    expect(codes(source)).toContain("TIMELINE_CLIP_INVALID");

    const transform = validTimeline();
    ((transform.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>).blur = 4;
    expect(codes(transform)).toContain("TIMELINE_CLIP_INVALID");

    const audio = validTimeline();
    ((audio.clips as Record<string, unknown>[])[3]!.audio as Record<string, unknown>).pan = 0.5;
    expect(codes(audio)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects invalid versions, empty tracks, and empty clips", () => {
    expect(codes({ ...validTimeline(), version: 2 })).toContain("TIMELINE_INVALID");
    expect(codes({ ...validTimeline(), tracks: [] })).toContain("TIMELINE_INVALID");
    expect(codes({ ...validTimeline(), clips: [] })).toContain("TIMELINE_INVALID");
  });

  it("rejects duplicate track and clip IDs", () => {
    const duplicateTrack = validTimeline();
    (duplicateTrack.tracks as unknown[]).push({ id: "v1", kind: "video" });
    expect(codes(duplicateTrack)).toContain("TIMELINE_TRACK_INVALID");

    const duplicateClip = validTimeline();
    (duplicateClip.clips as unknown[]).push({ ...((duplicateClip.clips as unknown[])[0] as object) });
    expect(codes(duplicateClip)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects missing tracks and mismatched track kinds", () => {
    const missing = validTimeline();
    (missing.clips as Record<string, unknown>[])[0]!.track = "missing";
    expect(codes(missing)).toContain("TIMELINE_CLIP_INVALID");

    const mismatch = validTimeline();
    (mismatch.clips as Record<string, unknown>[])[3]!.track = "v1";
    expect(codes(mismatch)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects overlapping clips on the same track but allows touching clips", () => {
    const overlap = validTimeline();
    (overlap.clips as Record<string, unknown>[])[1]!.start = 100;
    const diagnostics = parseTimelineDocument(overlap).diagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "TIMELINE_CLIP_OVERLAP")).toBe(true);

    const touching = validTimeline();
    (touching.clips as Record<string, unknown>[])[1]!.start = 120;
    expect(parseTimelineDocument(touching).diagnostics).toEqual([]);
  });

  it("requires image durations and sourceIn zero", () => {
    const missingDuration = validTimeline();
    delete (missingDuration.clips as Record<string, unknown>[])[2]!.duration;
    expect(codes(missingDuration)).toContain("TIMELINE_CLIP_INVALID");

    const nonzeroSourceIn = validTimeline();
    (nonzeroSourceIn.clips as Record<string, unknown>[])[2]!.sourceIn = 1;
    expect(codes(nonzeroSourceIn)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects presentation fields on the wrong source kinds", () => {
    const props = validTimeline();
    (props.clips as Record<string, unknown>[])[1]!.props = { title: "nope" };
    expect(codes(props)).toContain("TIMELINE_CLIP_INVALID");

    const transform = validTimeline();
    (transform.clips as Record<string, unknown>[])[3]!.transform = { fit: "contain" };
    expect(codes(transform)).toContain("TIMELINE_CLIP_INVALID");

    const audio = validTimeline();
    (audio.clips as Record<string, unknown>[])[2]!.audio = { gain: 0.5 };
    expect(codes(audio)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects remote and escaping media paths", () => {
    for (const src of ["https://example.com/a.mp4", "/absolute/a.mp4", "../outside/a.mp4"]) {
      const value = validTimeline();
      ((value.clips as Record<string, unknown>[])[1]!.source as Record<string, unknown>).src = src;
      expect(codes(value)).toContain("TIMELINE_CLIP_INVALID");
    }
  });

  it("accepts an explicit transform box", () => {
    const value = validTimeline();
    ((value.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>) = {
      fit: "cover",
      width: 80,
      height: 45,
      x: 10,
      y: -20,
      rotation: 5,
      opacity: 0.8,
    };

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.clips[2]?.transform).toEqual({
      fit: "cover",
      x: 10,
      y: -20,
      width: 80,
      height: 45,
      scale: 1,
      rotation: 5,
      opacity: 0.8,
    });
  });

  it("rejects incomplete, invalid, or ambiguous transform boxes", () => {
    for (const transform of [
      { width: 80 },
      { height: 45 },
      { width: 0, height: 45 },
      { width: 80, height: 45.5 },
      { width: 80, height: 45, scale: 0.5 },
    ]) {
      const value = validTimeline();
      ((value.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>) = transform;
      expect(codes(value), JSON.stringify(transform)).toContain("TIMELINE_CLIP_INVALID");
    }
  });

  it("rejects invalid transform and audio values", () => {
    const transform = validTimeline();
    ((transform.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>).opacity = 1.5;
    expect(codes(transform)).toContain("TIMELINE_CLIP_INVALID");

    const scale = validTimeline();
    ((scale.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>).scale = -1;
    expect(codes(scale)).toContain("TIMELINE_CLIP_INVALID");

    const gain = validTimeline();
    ((gain.clips as Record<string, unknown>[])[3]!.audio as Record<string, unknown>).gain = 2;
    expect(codes(gain)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects a duration override shorter than an explicit clip end", () => {
    const value = validTimeline();
    value.durationInFrames = 100;

    expect(codes(value)).toContain("TIMELINE_DURATION_INVALID");
  });

  it("rejects invalid track audio properties", () => {
    const videoGain = validTimeline();
    (videoGain.tracks as Record<string, unknown>[])[0]!.gain = 0.5;
    expect(codes(videoGain)).toContain("TIMELINE_TRACK_INVALID");

    const audioMuted = validTimeline();
    (audioMuted.tracks as Record<string, unknown>[])[1]!.muted = "yes";
    expect(codes(audioMuted)).toContain("TIMELINE_TRACK_INVALID");
  });

  it("includes clip, track, and JSON path context in diagnostics", () => {
    const value = validTimeline();
    (value.clips as Record<string, unknown>[])[1]!.start = 100;

    const diagnostic = parseTimelineDocument(value).diagnostics.find((item) => item.code === "TIMELINE_CLIP_OVERLAP");

    expect(diagnostic?.details).toMatchObject({
      track: "v1",
      clip: "broll",
      jsonPath: expect.stringContaining("$.clips"),
    });
  });
});
