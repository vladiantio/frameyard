import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Reads one decoded pixel from a PNG or video frame through FFmpeg. */
export async function mediaPixel(file: string, x = 10, y = 10): Promise<[number, number, number]> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  return [buffer[0] ?? 0, buffer[1] ?? 0, buffer[2] ?? 0];
}
