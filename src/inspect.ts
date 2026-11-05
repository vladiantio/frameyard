import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { FrameyardError, errorMessage } from "./errors.js";

const exec = promisify(execFile);

export interface ImageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageColor {
  hex: string;
  share: number;
}

export interface ImageStats {
  width: number;
  height: number;
  alpha: {
    min: number;
    max: number;
    coverage: number;
  };
  blank: boolean;
  background: ImageColor;
  content: {
    bbox: ImageBounds | null;
    pixels: number;
    share: number;
  };
  colors: ImageColor[];
  luminanceGrid: number[][];
  edgeDensity: number;
}

export interface CompareRegion {
  row: number;
  column: number;
  changed: number;
  percent: number;
}

export interface CompareStats {
  width: number;
  height: number;
  identical: boolean;
  differingPixels: number;
  totalPixels: number;
  percent: number;
  maxChannelDelta: number;
  meanChannelDelta: number;
  bbox: ImageBounds | null;
  regions: CompareRegion[];
}

function hex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(red: number, green: number, blue: number, alpha: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) * (alpha / 255);
}

function requirePixels(data: Buffer, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new FrameyardError(
      "IMAGE_INVALID",
      `Image dimensions must be positive integers; received ${width}x${height}.`,
    );
  }
  if (data.length !== width * height * 4) {
    throw new FrameyardError(
      "IMAGE_INVALID",
      `Decoded RGBA buffer has ${data.length} bytes; expected ${width * height * 4} for ${width}x${height}.`,
    );
  }
}

/** Summarizes one decoded RGBA image for text-only inspection. */
export function analyzeRgba(data: Buffer, width: number, height: number): ImageStats {
  requirePixels(data, width, height);
  const total = width * height;
  const counts = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  let alphaMin = 255;
  let alphaMax = 0;
  let transparent = 0;
  let opaque = 0;

  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const red = data[offset] as number;
    const green = data[offset + 1] as number;
    const blue = data[offset + 2] as number;
    const alpha = data[offset + 3] as number;
    alphaMin = Math.min(alphaMin, alpha);
    alphaMax = Math.max(alphaMax, alpha);
    if (alpha === 0) {
      transparent += 1;
      continue;
    }
    opaque += 1;
    const bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    counts[bucket] = (counts[bucket] as number) + 1;
    sums[bucket * 3] = (sums[bucket * 3] as number) + red;
    sums[bucket * 3 + 1] = (sums[bucket * 3 + 1] as number) + green;
    sums[bucket * 3 + 2] = (sums[bucket * 3 + 2] as number) + blue;
  }

  let dominantBucket = -1;
  let dominantCount = 0;
  for (let bucket = 0; bucket < counts.length; bucket += 1) {
    if ((counts[bucket] as number) > dominantCount) {
      dominantCount = counts[bucket] as number;
      dominantBucket = bucket;
    }
  }
  const background: ImageColor =
    dominantBucket === -1 || dominantCount === 0
      ? { hex: "#000000", share: 0 }
      : {
          hex: hex(
            (sums[dominantBucket * 3] as number) / dominantCount,
            (sums[dominantBucket * 3 + 1] as number) / dominantCount,
            (sums[dominantBucket * 3 + 2] as number) / dominantCount,
          ),
          share: dominantCount / total,
        };
  const backgroundRgb =
    dominantBucket === -1 || dominantCount === 0
      ? [0, 0, 0]
      : [
          (sums[dominantBucket * 3] as number) / dominantCount,
          (sums[dominantBucket * 3 + 1] as number) / dominantCount,
          (sums[dominantBucket * 3 + 2] as number) / dominantCount,
        ];

  const colors: ImageColor[] = [];
  for (let bucket = 0; bucket < counts.length; bucket += 1) {
    const count = counts[bucket] as number;
    if (count === 0) {
      continue;
    }
    colors.push({
      hex: hex(
        (sums[bucket * 3] as number) / count,
        (sums[bucket * 3 + 1] as number) / count,
        (sums[bucket * 3 + 2] as number) / count,
      ),
      share: count / total,
    });
  }
  colors.sort((left, right) => right.share - left.share);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let contentPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] as number;
      let isContent: boolean;
      if (transparent > 0) {
        isContent = alpha > 0;
      } else {
        const red = data[offset] as number;
        const green = data[offset + 1] as number;
        const blue = data[offset + 2] as number;
        isContent =
          Math.max(
            Math.abs(red - (backgroundRgb[0] as number)),
            Math.abs(green - (backgroundRgb[1] as number)),
            Math.abs(blue - (backgroundRgb[2] as number)),
          ) > 16;
      }
      if (!isContent) {
        continue;
      }
      contentPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const columns = Math.min(12, width);
  const rows = Math.min(7, height);
  const luminanceGrid: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const values: number[] = [];
    const startY = Math.floor((row * height) / rows);
    const endY = Math.floor(((row + 1) * height) / rows);
    for (let column = 0; column < columns; column += 1) {
      const startX = Math.floor((column * width) / columns);
      const endX = Math.floor(((column + 1) * width) / columns);
      let sum = 0;
      let count = 0;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * width + x) * 4;
          sum += luminance(
            data[offset] as number,
            data[offset + 1] as number,
            data[offset + 2] as number,
            data[offset + 3] as number,
          );
          count += 1;
        }
      }
      values.push(count === 0 ? 0 : Math.round(sum / count));
    }
    luminanceGrid.push(values);
  }

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const current = luminance(
        data[offset] as number,
        data[offset + 1] as number,
        data[offset + 2] as number,
        data[offset + 3] as number,
      );
      if (x + 1 < width) {
        const rightOffset = offset + 4;
        edgeSum += Math.abs(
          current -
            luminance(
              data[rightOffset] as number,
              data[rightOffset + 1] as number,
              data[rightOffset + 2] as number,
              data[rightOffset + 3] as number,
            ),
        );
        edgeCount += 1;
      }
      if (y + 1 < height) {
        const downOffset = offset + width * 4;
        edgeSum += Math.abs(
          current -
            luminance(
              data[downOffset] as number,
              data[downOffset + 1] as number,
              data[downOffset + 2] as number,
              data[downOffset + 3] as number,
            ),
        );
        edgeCount += 1;
      }
    }
  }

  return {
    width,
    height,
    alpha: {
      min: alphaMin,
      max: alphaMax,
      coverage: opaque / total,
    },
    blank: opaque === 0 || background.share >= 0.995,
    background,
    content: {
      bbox:
        contentPixels === 0
          ? null
          : {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
      pixels: contentPixels,
      share: contentPixels / total,
    },
    colors: colors.slice(0, 8),
    luminanceGrid,
    edgeDensity: edgeCount === 0 ? 0 : Number((edgeSum / edgeCount / 255).toFixed(4)),
  };
}

/** Compares two decoded RGBA images pixel by pixel and by 3×3 region. */
export function compareRgba(first: Buffer, second: Buffer, width: number, height: number): CompareStats {
  requirePixels(first, width, height);
  requirePixels(second, width, height);
  const total = width * height;
  let differing = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const delta = Math.max(
        Math.abs((first[offset] as number) - (second[offset] as number)),
        Math.abs((first[offset + 1] as number) - (second[offset + 1] as number)),
        Math.abs((first[offset + 2] as number) - (second[offset + 2] as number)),
        Math.abs((first[offset + 3] as number) - (second[offset + 3] as number)),
      );
      sumDelta += delta;
      maxDelta = Math.max(maxDelta, delta);
      if (delta === 0) {
        continue;
      }
      differing += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const regionColumns = Math.min(3, width);
  const regionRows = Math.min(3, height);
  const regions: CompareRegion[] = [];
  for (let row = 0; row < regionRows; row += 1) {
    const startY = Math.floor((row * height) / regionRows);
    const endY = Math.floor(((row + 1) * height) / regionRows);
    for (let column = 0; column < regionColumns; column += 1) {
      const startX = Math.floor((column * width) / regionColumns);
      const endX = Math.floor(((column + 1) * width) / regionColumns);
      let changed = 0;
      let pixels = 0;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * width + x) * 4;
          pixels += 1;
          if (
            Math.max(
              Math.abs((first[offset] as number) - (second[offset] as number)),
              Math.abs((first[offset + 1] as number) - (second[offset + 1] as number)),
              Math.abs((first[offset + 2] as number) - (second[offset + 2] as number)),
              Math.abs((first[offset + 3] as number) - (second[offset + 3] as number)),
            ) > 0
          ) {
            changed += 1;
          }
        }
      }
      regions.push({
        row,
        column,
        changed,
        percent: pixels === 0 ? 0 : Number(((changed / pixels) * 100).toFixed(3)),
      });
    }
  }

  return {
    width,
    height,
    identical: differing === 0,
    differingPixels: differing,
    totalPixels: total,
    percent: Number(((differing / total) * 100).toFixed(3)),
    maxChannelDelta: maxDelta,
    meanChannelDelta: Number((sumDelta / total).toFixed(4)),
    bbox:
      differing === 0
        ? null
        : {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          },
    regions,
  };
}

export interface ProbedImage {
  width: number;
  height: number;
  bytes: number;
}

/** Probes image dimensions through FFprobe. */
export async function probeImage(filePath: string): Promise<ProbedImage> {
  let stdout: string;
  try {
    const result = await exec("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ]);
    stdout = result.stdout;
  } catch (error) {
    throw new FrameyardError("IMAGE_INVALID", `Could not probe image ${filePath}: ${errorMessage(error)}`, {
      cause: error,
      details: { path: filePath },
    });
  }

  let parsed: { streams?: Array<{ width?: number; height?: number }> };
  try {
    parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
  } catch (error) {
    throw new FrameyardError("IMAGE_INVALID", `FFprobe returned invalid JSON for ${filePath}.`, {
      cause: error,
      details: { path: filePath },
    });
  }
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) {
    throw new FrameyardError("IMAGE_INVALID", `Could not read image dimensions from ${filePath}.`, {
      details: { path: filePath },
    });
  }
  const info = await stat(filePath).catch(() => undefined);
  return {
    width: stream.width,
    height: stream.height,
    bytes: info?.size ?? 0,
  };
}

/** Decodes the first frame to RGBA through FFmpeg. */
export async function decodeRgba(filePath: string, width: number, height: number): Promise<Buffer> {
  const maxBuffer = width * height * 4 + 1024;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-v", "error", "-i", filePath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        { encoding: "buffer", maxBuffer },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });
  } catch (error) {
    throw new FrameyardError("IMAGE_INVALID", `Could not decode image ${filePath}: ${errorMessage(error)}`, {
      cause: error,
      details: { path: filePath },
    });
  }
}
