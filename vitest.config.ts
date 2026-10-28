import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Rendering tests share the browser and FFmpeg; keep them sequential.
    fileParallelism: false,
  },
});
