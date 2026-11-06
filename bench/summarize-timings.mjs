#!/usr/bin/env node
/**
 * Summarizes `FRAMEYARD_TIMINGS=1` JSONL output from a timeline render.
 *
 *   FRAMEYARD_TIMINGS=1 node dist/cli.js render main --project ... \
 *     2> timings.jsonl
 *   node bench/summarize-timings.mjs timings.jsonl
 *
 * Use `--segments` to print the per-segment critical path.
 */
import { readFile } from "node:fs/promises";

function usage() {
  process.stderr.write(
    "Usage: node bench/summarize-timings.mjs <timings.jsonl> [--segments] [--json]\n" +
      "       ... | node bench/summarize-timings.mjs - [--segments] [--json]\n",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const segments = args.includes("--segments");
const json = args.includes("--json");
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
  usage();
}

async function readInput() {
  if (file !== "-") {
    return readFile(file, "utf8");
  }
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  return {
    n: sorted.length,
    total: Number(total.toFixed(1)),
    mean: Number((total / sorted.length).toFixed(1)),
    p50: Number((percentile(0.5) ?? 0).toFixed(1)),
    p90: Number((percentile(0.9) ?? 0).toFixed(1)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
  };
}

const events = (await readInput())
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line))
  .filter((event) => event.type === "fy-timing");

if (events.length === 0) {
  process.stderr.write("No fy-timing events found.\n");
  process.exit(1);
}

const groups = new Map();
for (const event of events) {
  const group = groups.get(event.event) ?? [];
  group.push(event);
  groups.set(event.event, group);
}

const summary = [...groups].map(([event, group]) => ({
  event,
  ...summarize(group.map((entry) => entry.ms)),
}));

if (json) {
  process.stdout.write(`${JSON.stringify({ summary, events }, null, 2)}\n`);
  process.exit(0);
}

for (const entry of summary) {
  process.stdout.write(
    `${entry.event.padEnd(34)} n=${String(entry.n).padStart(4)} total=${String(entry.total).padStart(10)}ms ` +
      `mean=${String(entry.mean).padStart(8)} p50=${String(entry.p50).padStart(8)} ` +
      `p90=${String(entry.p90).padStart(8)} max=${String(entry.max).padStart(8)}\n`,
  );
}

if (segments) {
  const segmentEvents = events
    .filter((event) => event.event === "timeline.segment")
    .sort((left, right) => left.segment - right.segment);
  if (segmentEvents.length > 0) {
    process.stdout.write("\nSegments\n");
    for (const event of segmentEvents) {
      const layers = events
        .filter((candidate) => candidate.event === "timeline.layer.composition" && candidate.segment === event.segment)
        .map((candidate) => `${candidate.entry}:${candidate.ms}ms`)
        .join(" ");
      const composite = events.find(
        (candidate) => candidate.event === "timeline.segment.composite" && candidate.segment === event.segment,
      );
      process.stdout.write(
        `segment ${String(event.segment).padStart(4)} ${String(event.ms).padStart(10)}ms ` +
          `frames=${event.frames} layers=${event.layers} composite=${composite?.ms ?? "-"}ms ${layers}\n`,
      );
    }
  }
}
