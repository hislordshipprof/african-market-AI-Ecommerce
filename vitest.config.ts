import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/lib/test-setup.ts"],
    testTimeout: 15_000,
    // This machine has 24 cores. One worker per core starves the Vitest parent
    // until "Timeout calling onTaskUpdate" fails the run after every test passed.
    // Four workers still did that on a full run where all 2130 tests passed.
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
