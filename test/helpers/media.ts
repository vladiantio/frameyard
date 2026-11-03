import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Reads one decoded RGB pixel from a PNG or video frame through FFmpeg. */
export async function mediaPixel(file: string, x = 10, y = 10): Promise<[number, number, number]> {
  const [red, green, blue] = await mediaPixelRgba(file, x, y);
  return [red, green, blue];
}

/** Reads one decoded RGBA pixel; alpha is preserved for blend assertions. */
export async function mediaPixelRgba(file: string, x = 10, y = 10): Promise<[number, number, number, number]> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `format=rgba,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  return [buffer[0] ?? 0, buffer[1] ?? 0, buffer[2] ?? 0, buffer[3] ?? 0];
}
