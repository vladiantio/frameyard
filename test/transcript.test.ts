import { describe, expect, it } from "vitest";
import { parseTranscript, transcriptToSrt, transcriptToVtt } from "../src/index.ts";

const sha256 = "a".repeat(64);

const transcript = {
  schemaVersion: 1,
  text: "Hello world. Goodbye now.",
  language: "en",
  source: {
    path: "assets/voice.wav",
    sha256,
    bytes: 1234,
  },
  segments: [
    { startMs: 0, endMs: 1200, text: "Hello world." },
    { startMs: 1200, endMs: 2400, text: "Goodbye now." },
  ],
  words: [
    { startMs: 0, endMs: 500, text: "Hello" },
    { startMs: 520, endMs: 1100, text: "world." },
    { startMs: 1200, endMs: 1700, text: "Goodbye" },
    { startMs: 1720, endMs: 2300, text: "now." },
  ],
};

describe("canonical transcript", () => {
  it("validates and normalizes a versioned transcript", () => {
    const parsed = parseTranscript(transcript);

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      text: transcript.text,
      language: "en",
      source: transcript.source,
    });
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.words).toHaveLength(4);
  });

  it("omits word timings when they are not present", () => {
    const { words: _words, ...withoutWords } = transcript;
    const parsed = parseTranscript(withoutWords);

    expect(parsed.words).toBeUndefined();
  });

  it("requires actual word timings for karaoke validation", () => {
    const { words: _words, ...withoutWords } = transcript;

    expect(() => parseTranscript(withoutWords, { requireWords: true })).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_WORDS_UNAVAILABLE" }),
    );
    expect(() => parseTranscript({ ...withoutWords, words: [] }, { requireWords: true })).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_WORDS_UNAVAILABLE" }),
    );
  });

  it.each([
    [{ schemaVersion: 2 }, /schemaVersion/i],
    [{ text: undefined }, /text/i],
    [{ language: 42 }, /language/i],
    [{ source: { path: "", sha256, bytes: 1 } }, /source\.path/i],
    [{ source: { path: "a.wav", sha256: "nope", bytes: 1 } }, /sha256/i],
    [{ source: { path: "a.wav", sha256, bytes: -1 } }, /bytes/i],
    [{ segments: [{ startMs: -1, endMs: 1, text: "a" }] }, /startMs/i],
    [{ segments: [{ startMs: 2, endMs: 1, text: "a" }] }, /endMs|startMs/i],
    [{ segments: [{ startMs: 0, endMs: 1, text: "" }] }, /text/i],
    [
      {
        segments: [
          { startMs: 1, endMs: 2, text: "a" },
          { startMs: 0, endMs: 1, text: "b" },
        ],
      },
      /ordered/i,
    ],
    [{ words: [{ startMs: 0, endMs: 1, text: "" }] }, /word/i],
  ])("rejects invalid transcript values %o", (patch, message) => {
    expect(() => parseTranscript({ ...transcript, ...patch })).toThrow(message);
  });

  it("rejects non-integer millisecond timestamps", () => {
    expect(() =>
      parseTranscript({
        ...transcript,
        segments: [{ startMs: 0.5, endMs: 1, text: "a" }],
      }),
    ).toThrow(/integer milliseconds/i);
  });
});

describe("subtitle exports", () => {
  it("writes SRT from segment timings", () => {
    expect(transcriptToSrt(parseTranscript(transcript))).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:01,200",
        "Hello world.",
        "",
        "2",
        "00:00:01,200 --> 00:00:02,400",
        "Goodbye now.",
        "",
      ].join("\n"),
    );
  });

  it("writes WebVTT from segment timings", () => {
    expect(transcriptToVtt(parseTranscript(transcript))).toBe(
      [
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:01.200",
        "Hello world.",
        "",
        "00:00:01.200 --> 00:00:02.400",
        "Goodbye now.",
        "",
      ].join("\n"),
    );
  });

  it("supports timestamps beyond one hour", () => {
    const long = parseTranscript({
      ...transcript,
      segments: [{ startMs: 3_723_004, endMs: 3_723_999, text: "Late line" }],
      words: undefined,
    });

    expect(transcriptToSrt(long)).toContain("01:02:03,004 --> 01:02:03,999");
    expect(transcriptToVtt(long)).toContain("01:02:03.004 --> 01:02:03.999");
  });
});
