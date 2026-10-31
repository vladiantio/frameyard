#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function usage() {
  console.error("usage: pnpm compare-stills <a.png> <b.png>");
  process.exit(2);
}

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  usage();
}

async function probe(file) {
  const { stdout } = await exec("ffprobe", [
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
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`Could not read image dimensions from ${file}.`);
  }
  return { width: stream.width, height: stream.height };
}

function decode(file, width, height) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: width * height * 3 + 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

try {
  const [firstInfo, secondInfo] = await Promise.all([probe(first), probe(second)]);
  if (firstInfo.width !== secondInfo.width || firstInfo.height !== secondInfo.height) {
    console.error(
      `Images have different dimensions: ${first} is ${firstInfo.width}x${firstInfo.height}, ${second} is ${secondInfo.width}x${secondInfo.height}.`,
    );
    process.exit(1);
  }

  const [firstBytes, secondBytes] = await Promise.all([
    decode(first, firstInfo.width, firstInfo.height),
    decode(second, secondInfo.width, secondInfo.height),
  ]);
  if (firstBytes.length !== secondBytes.length) {
    console.error(
      `Decoded image sizes differ: ${first} produced ${firstBytes.length} bytes, ${second} produced ${secondBytes.length} bytes.`,
    );
    process.exit(1);
  }

  const width = firstInfo.width;
  const height = firstInfo.height;
  let differing = 0;
  let maxDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const red = Math.abs(firstBytes[offset] - secondBytes[offset]);
      const green = Math.abs(firstBytes[offset + 1] - secondBytes[offset + 1]);
      const blue = Math.abs(firstBytes[offset + 2] - secondBytes[offset + 2]);
      const delta = Math.max(red, green, blue);
      if (delta === 0) {
        continue;
      }
      differing += 1;
      maxDelta = Math.max(maxDelta, delta);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (differing === 0) {
    console.log(`${first} and ${second} are pixel-identical (${width}x${height}).`);
    process.exitCode = 0;
  } else {
    const total = width * height;
    console.log(`${first} and ${second} differ:`);
    console.log(`  dimensions: ${width}x${height}`);
    console.log(`  differing pixels: ${differing} / ${total} (${((differing / total) * 100).toFixed(3)}%)`);
    console.log(`  max channel delta: ${maxDelta}`);
    console.log(`  bounding box: x=${minX}..${maxX}, y=${minY}..${maxY}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`compare-stills: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
