import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// These files launch Chromium, FFmpeg, or the built CLI. Each one owns its
// browser and temporary project, but they compete for CPU, so bound how many
// run at once. Everything else runs in parallel.
const integrationTests = [
  "test/cli-render.test.ts",
  "test/cli-stills.test.ts",
  "test/timeline-render.test.ts",
  "test/examples.test.ts",
  "test/assets-e2e.test.ts",
  "test/video-determinism.test.ts",
  "test/agent-workflow.test.ts",
  "test/context.test.ts",
  "test/fonts-e2e.test.ts",
  "test/fontsource-e2e.test.ts",
  "test/host-runtime.test.ts",
  "test/inspect.test.ts",
  "test/preview-runtime.test.ts",
  "test/project-server.test.ts",
  "test/real-integrations.test.ts",
  "test/timeline-preview-runtime.test.ts",
];

const isCi = Boolean(process.env.CI);
// Leave room for the renderers inside each file: one file on small hosts,
// two on mid-sized machines, and three on a wide desktop.
const localWorkers = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 3)));

const shared = {
  testTimeout: 120_000,
  hookTimeout: 120_000,
  // Concurrent tests in the example matrix share the host with the rest of
  // the suite; two browser captures at a time is enough to hide startup cost
  // without oversubscribing the machine. CI keeps the smallest runner
  // predictable by running one at a time.
  maxConcurrency: isCi ? 1 : 2,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: integrationTests,
          fileParallelism: true,
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: integrationTests,
          // CI runs the integration project with one worker to keep the
          // smallest runner predictable; local machines scale up with cores.
          fileParallelism: !isCi,
          maxWorkers: localWorkers,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
