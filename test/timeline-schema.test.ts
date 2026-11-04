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
      blend: "normal",
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

  it("parses transitions across clip overlaps", () => {
    const value = validTimeline();
    value.transitions = [{ from: "intro", to: "broll", kind: "dissolve", easing: "ease-in-out" }];

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.transitions).toEqual([
      { from: "intro", to: "broll", kind: "dissolve", easing: "ease-in-out" },
    ]);
  });

  it("parses audio crossfade transitions", () => {
    const value = validTimeline();
    value.transitions = [{ from: "intro", to: "broll", kind: "crossfade" }];

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.transitions).toEqual([{ from: "intro", to: "broll", kind: "crossfade" }]);
  });

  it("rejects transition shape errors, unsupported kinds, and duplicates", () => {
    const unknownField = validTimeline();
    unknownField.transitions = [{ from: "intro", to: "broll", kind: "dissolve", duration: 10 }];
    expect(codes(unknownField)).toContain("TIMELINE_TRANSITION_INVALID");

    const unknownKind = validTimeline();
    unknownKind.transitions = [{ from: "intro", to: "broll", kind: "wipe" }];
    expect(codes(unknownKind)).toContain("TIMELINE_TRANSITION_KIND");

    const badEasing = validTimeline();
    badEasing.transitions = [{ from: "intro", to: "broll", kind: "dissolve", easing: "bounce" }];
    expect(codes(badEasing)).toContain("TIMELINE_TRANSITION_INVALID");

    const repeatedPair = validTimeline();
    repeatedPair.transitions = [
      { from: "intro", to: "broll", kind: "dissolve" },
      { from: "intro", to: "broll", kind: "dissolve" },
    ];
    expect(codes(repeatedPair)).toContain("TIMELINE_TRANSITION_DUPLICATE");

    const repeatedSource = validTimeline();
    repeatedSource.transitions = [
      { from: "intro", to: "broll", kind: "dissolve" },
      { from: "intro", to: "logo", kind: "dissolve" },
    ];
    expect(codes(repeatedSource)).toContain("TIMELINE_TRANSITION_DUPLICATE");
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

  it("accepts every supported blend mode and defaults visual clips to normal", () => {
    for (const blend of [
      "normal",
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "color-dodge",
      "color-burn",
      "hard-light",
      "soft-light",
      "difference",
      "exclusion",
    ]) {
      const value = validTimeline();
      (value.clips as Record<string, unknown>[])[2]!.blend = blend;

      const parsed = parseTimelineDocument(value);

      expect(parsed.diagnostics, blend).toEqual([]);
      expect(parsed.timeline?.clips[2]?.blend, blend).toBe(blend);
    }
  });

  it("rejects unsupported, unknown, mistyped, and audio-clip blend values", () => {
    const unsupported = validTimeline();
    (unsupported.clips as Record<string, unknown>[])[2]!.blend = "hue";
    const unsupportedParsed = parseTimelineDocument(unsupported);
    expect(unsupportedParsed.diagnostics[0]).toMatchObject({
      code: "TIMELINE_CLIP_INVALID",
      details: { jsonPath: "$.clips[2].blend", suggestion: expect.stringContaining("separable") },
    });

    for (const blend of ["Multiply", "blur", 3]) {
      const value = validTimeline();
      (value.clips as Record<string, unknown>[])[2]!.blend = blend;
      expect(codes(value), String(blend)).toContain("TIMELINE_CLIP_INVALID");
    }

    const audio = validTimeline();
    (audio.clips as Record<string, unknown>[])[3]!.blend = "multiply";
    expect(codes(audio)).toContain("TIMELINE_CLIP_INVALID");
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

  it("accepts keyframe tracks and normalizes easing", () => {
    const value = validTimeline();
    (value.clips as Record<string, unknown>[])[0]!.keyframes = {
      opacity: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1, easing: " ease-out " },
      ],
      x: [
        { frame: 0, value: -10 },
        { frame: 20, value: 0 },
      ],
    };

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.clips[0]?.keyframes).toEqual({
      opacity: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1, easing: "ease-out" },
      ],
      x: [
        { frame: 0, value: -10 },
        { frame: 20, value: 0 },
      ],
    });
  });

  it("accepts keyframes on every visual source and alongside an explicit box", () => {
    const value = validTimeline();
    (value.clips as Record<string, unknown>[])[1]!.keyframes = {
      rotation: [
        { frame: 0, value: 0 },
        { frame: 10, value: 90 },
      ],
    };
    (value.clips as Record<string, unknown>[])[0]!.transform = { width: 80, height: 45 };
    (value.clips as Record<string, unknown>[])[0]!.keyframes = {
      x: [
        { frame: 0, value: -10 },
        { frame: 30, value: 0 },
      ],
      opacity: [
        { frame: 0, value: 0 },
        { frame: 30, value: 1 },
      ],
    };
    (value.clips as Record<string, unknown>[]).push({
      id: "nested",
      track: "v1",
      source: { kind: "timeline", id: "lower-third" },
      start: 210,
      duration: 30,
      keyframes: {
        scale: [
          { frame: 0, value: 0.5 },
          { frame: 30, value: 1 },
        ],
      },
    });

    const parsed = parseTimelineDocument(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.timeline?.clips[0]?.keyframes?.opacity).toHaveLength(2);
    expect(parsed.timeline?.clips[1]?.keyframes?.rotation).toHaveLength(2);
    expect(parsed.timeline?.clips[4]?.keyframes?.scale).toHaveLength(2);
  });

  it("rejects malformed keyframe tracks", () => {
    const cases: Array<[string, unknown]> = [
      ["empty object", {}],
      [
        "unknown channel",
        {
          blur: [
            { frame: 0, value: 0 },
            { frame: 1, value: 1 },
          ],
        },
      ],
      ["not an array", { opacity: {} }],
      ["one key", { opacity: [{ frame: 0, value: 0 }] }],
      [
        "negative frame",
        {
          opacity: [
            { frame: -1, value: 0 },
            { frame: 1, value: 1 },
          ],
        },
      ],
      [
        "fractional frame",
        {
          opacity: [
            { frame: 0.5, value: 0 },
            { frame: 1, value: 1 },
          ],
        },
      ],
      [
        "duplicate frame",
        {
          opacity: [
            { frame: 0, value: 0 },
            { frame: 0, value: 1 },
          ],
        },
      ],
      [
        "missing value",
        {
          opacity: [{ frame: 0 }, { frame: 1, value: 1 }],
        },
      ],
      [
        "non-finite value",
        {
          opacity: [
            { frame: 0, value: 0 },
            { frame: 1, value: Number.POSITIVE_INFINITY },
          ],
        },
      ],
      [
        "opacity range",
        {
          opacity: [
            { frame: 0, value: 0 },
            { frame: 1, value: 1.5 },
          ],
        },
      ],
      [
        "negative scale",
        {
          scale: [
            { frame: 0, value: -1 },
            { frame: 1, value: 1 },
          ],
        },
      ],
      [
        "invalid easing",
        {
          opacity: [
            { frame: 0, value: 0, easing: "easeIn" },
            { frame: 1, value: 1 },
          ],
        },
      ],
      [
        "unknown key field",
        {
          opacity: [
            { frame: 0, value: 0, curve: "linear" },
            { frame: 1, value: 1 },
          ],
        },
      ],
      [
        "non-string easing",
        {
          opacity: [
            { frame: 0, value: 0, easing: 3 },
            { frame: 1, value: 1 },
          ],
        },
      ],
    ];

    for (const [name, keyframes] of cases) {
      const value = validTimeline();
      (value.clips as Record<string, unknown>[])[0]!.keyframes = keyframes;
      expect(codes(value), name).toContain("TIMELINE_CLIP_INVALID");
    }
  });

  it("rejects keyframes on audio clips", () => {
    const value = validTimeline();
    (value.clips as Record<string, unknown>[])[3]!.keyframes = {
      opacity: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1 },
      ],
    };

    expect(codes(value)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects keyed channels that are also explicit static transform fields", () => {
    const value = validTimeline();
    (value.clips as Record<string, unknown>[])[2]!.keyframes = {
      x: [
        { frame: 0, value: -10 },
        { frame: 10, value: 0 },
      ],
    };

    expect(codes(value)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("rejects keyed scale with an explicit transform box", () => {
    const value = validTimeline();
    ((value.clips as Record<string, unknown>[])[2]!.transform as Record<string, unknown>) = {
      width: 80,
      height: 45,
    };
    (value.clips as Record<string, unknown>[])[2]!.keyframes = {
      scale: [
        { frame: 0, value: 0.5 },
        { frame: 10, value: 1 },
      ],
    };

    expect(codes(value)).toContain("TIMELINE_CLIP_INVALID");
  });

  it("does not treat default transform values as keyed-channel conflicts", () => {
    const value = validTimeline();
    delete (value.clips as Record<string, unknown>[])[0]!.transform;
    (value.clips as Record<string, unknown>[])[0]!.keyframes = {
      x: [
        { frame: 0, value: 0 },
        { frame: 10, value: 10 },
      ],
      scale: [
        { frame: 0, value: 0.5 },
        { frame: 10, value: 1 },
      ],
      opacity: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1 },
      ],
    };

    expect(parseTimelineDocument(value).diagnostics).toEqual([]);
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
