import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface DecodedFrame {
  width: number;
  height: number;
  pixels: Buffer;
}

// Sampling several points from the same artifact is common; decode once and
// reuse the RGBA frame instead of spawning FFmpeg per pixel. The cache key
// includes the file size and mtime so an overwritten output is re-read.
const frames = new Map<string, Promise<DecodedFrame>>();

async function decodeFrame(file: string): Promise<DecodedFrame> {
  const info = await stat(file);
  const key = `${file}\0${info.size}\0${info.mtimeMs}`;
  const cached = frames.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async () => {
    const { stdout: probeOutput } = await exec("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      file,
    ]);
    const probe = JSON.parse(probeOutput) as { streams?: Array<{ width?: number; height?: number }> };
    const stream = probe.streams?.[0];
    const width = stream?.width;
    const height = stream?.height;
    if (width === undefined || height === undefined) {
      throw new Error(`FFprobe did not report video dimensions for ${file}.`);
    }

    const { stdout } = await exec(
      "ffmpeg",
      ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
      { encoding: "buffer", maxBuffer: width * height * 4 + 1024 },
    );
    const pixels = stdout as unknown as Buffer;
    if (pixels.length < width * height * 4) {
      throw new Error(`FFmpeg returned a short frame for ${file}: ${pixels.length} bytes.`);
    }
    return { width, height, pixels };
  })();

  frames.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    frames.delete(key);
    throw error;
  }
}

/** Reads one decoded RGB pixel from a PNG or video frame through FFmpeg. */
export async function mediaPixel(file: string, x = 10, y = 10): Promise<[number, number, number]> {
  const [red, green, blue] = await mediaPixelRgba(file, x, y);
  return [red, green, blue];
}

/** Reads one decoded RGBA pixel; alpha is preserved for blend assertions. */
export async function mediaPixelRgba(file: string, x = 10, y = 10): Promise<[number, number, number, number]> {
  const frame = await decodeFrame(file);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new RangeError(`Pixel (${x}, ${y}) is outside the ${frame.width}x${frame.height} frame of ${file}.`);
  }
  const offset = (y * frame.width + x) * 4;
  return [
    frame.pixels[offset] ?? 0,
    frame.pixels[offset + 1] ?? 0,
    frame.pixels[offset + 2] ?? 0,
    frame.pixels[offset + 3] ?? 0,
  ];
}
