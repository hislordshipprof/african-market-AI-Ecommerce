import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/lib/test-setup.ts"],
    testTimeout: 15_000,
    // One worker per core (24 here) starves the Vitest parent until "Timeout calling
    // onTaskUpdate" fails the run after every test passed. That happened when several
    // lanes ran the full suite at once; scripts/ci-local.sh now runs one full suite at a
    // time machine-wide, and 4 workers pass there. VITEST_MAX_WORKERS overrides it.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 4,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
