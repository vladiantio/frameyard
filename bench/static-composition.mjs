#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const frames = Number(process.env.FRAMEYARD_STATIC_BENCH_FRAMES ?? 300);

const visual = `<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #123456; }
  .card { position: absolute; inset: 0; display: grid; place-items: center; color: #b8f36b; font: 48px monospace; }
</style>
<fy-composition%METADATA%>
  <div class="card">Static</div>
</fy-composition>
`;

async function run(args, cwd) {
  const started = performance.now();
  const { stdout } = await exec(process.execPath, [cli, ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { elapsedMs: performance.now() - started, stdout };
}

function formatMs(value) {
  return `${(value / 1000).toFixed(2)} s`;
}

const root = await mkdtemp(path.join(tmpdir(), "frameyard-static-bench-"));
try {
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(
    path.join(root, "fy.config.js"),
    `export default {
      format: { width: 1280, height: 720, fps: 30 },
      compositions: {
        animated: "./compositions/animated.html",
        static: "./compositions/static.html",
      },
    };\n`,
  );
  await writeFile(
    path.join(root, "compositions", "animated.html"),
    visual.replace("%METADATA%", ` duration-in-frames="${frames}"`),
  );
  await writeFile(path.join(root, "compositions", "static.html"), visual.replace("%METADATA%", ""));

  const animated = await run(["render", "animated", "--project", root, "--encoder", "software", "--json"], root);
  const staticResult = await run(["render", "static", "--project", root, "--json"], root);
  const animatedBytes = (await stat(path.join(root, "out", "animated.mp4"))).size;
  const staticBytes = (await stat(path.join(root, "out", "static.png"))).size;

  console.log(`Frameyard static composition benchmark (${frames} frames, 1280x720)`);
  console.log(
    `  animated  ${formatMs(animated.elapsedMs).padStart(9)}  ${String(animatedBytes).padStart(9)} bytes  ${(frames / (animated.elapsedMs / 1000)).toFixed(1)} fps`,
  );
  console.log(
    `  static    ${formatMs(staticResult.elapsedMs).padStart(9)}  ${String(staticBytes).padStart(9)} bytes  1 capture`,
  );
  console.log(
    `  ratio     ${(animated.elapsedMs / staticResult.elapsedMs).toFixed(1)}x faster for the static composition`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
