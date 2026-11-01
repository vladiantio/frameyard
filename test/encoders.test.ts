import { describe, expect, it } from "vitest";
import {
  assertContainerCodec,
  audioEncoderArgs,
  CONTAINER_EXTENSION,
  ENCODER_SESSION_LIMIT,
  encoderNameFor,
  resolveVideoEncoder,
  videoCodecTagArgs,
  videoEncoderArgs,
  type VideoEncoderName,
} from "../src/renderer/ffmpeg.ts";

describe("encoder selection", () => {
  it("maps a codec and vendor choice to an encoder", () => {
    expect(encoderNameFor("h264", "software")).toBe("libx264");
    expect(encoderNameFor("hevc", "software")).toBe("libx265");
    expect(encoderNameFor("vp9", "software")).toBe("libvpx-vp9");
    expect(encoderNameFor("h264", "nvenc")).toBe("h264_nvenc");
    expect(encoderNameFor("hevc", "nvenc")).toBe("hevc_nvenc");
    expect(encoderNameFor("h264", "qsv")).toBe("h264_qsv");
    expect(encoderNameFor("hevc", "qsv")).toBe("hevc_qsv");
  });

  it("rejects a vendor that has no encoder for the codec", async () => {
    expect(() => encoderNameFor("vp9", "nvenc")).toThrow(/has no nvenc encoder/);
    expect(() => encoderNameFor("vp9", "qsv")).toThrow(/has no qsv encoder/);
    await expect(resolveVideoEncoder("vp9", "nvenc")).rejects.toMatchObject({ code: "USAGE" });
  });

  it("constrains codecs to containers that can hold them", () => {
    expect(() => assertContainerCodec("mp4", "h264")).not.toThrow();
    expect(() => assertContainerCodec("mov", "hevc")).not.toThrow();
    expect(() => assertContainerCodec("mkv", "vp9")).not.toThrow();
    expect(() => assertContainerCodec("webm", "vp9")).not.toThrow();

    expect(() => assertContainerCodec("webm", "h264")).toThrow(/cannot hold H\.264/);
    expect(() => assertContainerCodec("webm", "hevc")).toThrow(/cannot hold HEVC/);
    expect(() => assertContainerCodec("mp4", "vp9")).toThrow(/cannot hold VP9/);
    expect(() => assertContainerCodec("mov", "vp9")).toThrow(/cannot hold VP9/);

    expect(CONTAINER_EXTENSION).toEqual({ mp4: "mp4", mov: "mov", mkv: "mkv", webm: "webm" });
  });

  it("tags HEVC only in MP4 and MOV, and pairs VP9 with Opus", () => {
    expect(videoCodecTagArgs("hevc", "mp4")).toEqual(["-tag:v", "hvc1"]);
    expect(videoCodecTagArgs("hevc", "mov")).toEqual(["-tag:v", "hvc1"]);
    expect(videoCodecTagArgs("hevc", "mkv")).toEqual([]);
    expect(videoCodecTagArgs("hevc", "webm")).toEqual([]);
    expect(videoCodecTagArgs("h264", "mp4")).toEqual([]);

    expect(audioEncoderArgs("h264")).toEqual(expect.arrayContaining(["aac"]));
    expect(audioEncoderArgs("hevc")).toEqual(expect.arrayContaining(["aac"]));
    expect(audioEncoderArgs("vp9")).toEqual(expect.arrayContaining(["libopus"]));
  });

  it("emits HEVC encoder arguments without container tags", () => {
    const hevc: VideoEncoderName[] = ["libx265", "hevc_nvenc", "hevc_qsv"];
    for (const encoder of hevc) {
      const args = videoEncoderArgs(encoder);
      expect(args).toContain("-c:v");
      expect(args).toContain(encoder);
      expect(args).not.toContain("hvc1");
    }

    expect(videoEncoderArgs("libvpx-vp9")).toEqual(expect.arrayContaining(["-c:v", "libvpx-vp9", "-crf", "32"]));
  });

  it("caps NVENC sessions for both codecs", () => {
    expect(ENCODER_SESSION_LIMIT.h264_nvenc).toBe(8);
    expect(ENCODER_SESSION_LIMIT.hevc_nvenc).toBe(8);
    expect(ENCODER_SESSION_LIMIT.libx264).toBe(Number.POSITIVE_INFINITY);
    expect(ENCODER_SESSION_LIMIT.libx265).toBe(Number.POSITIVE_INFINITY);
  });
});
