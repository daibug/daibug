import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/phase2/e2e-*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./e2e-setup.ts"],
    // Run test files sequentially — each file launches its own browser context
    // and Hub on different ports. Parallel execution causes extensions to
    // connect to the wrong Hub via multi-port discovery.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "bun:test": "vitest",
      playwright: path.resolve(__dirname, "playwright-shim.ts"),
    },
  },
});
