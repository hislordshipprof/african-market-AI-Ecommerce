import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["src/lib/test-setup.ts"],
    testTimeout: 15_000,
    // One worker per core (24 here) starves the Vitest parent until "Timeout calling
    // onTaskUpdate" fails the run after every test passed. That happened when several
    // lanes ran the full suite at once; scripts/ci-local.sh now runs one full suite at a
    // time machine-wide, and 4 workers pass there. VITEST_MAX_WORKERS overrides it.
    // maxWorkers stays at the root: Vitest rejects it on a project.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 4,
    // include lives on the projects. With extends: true a project include is added to
    // the root include, so a root include would run the suite twice.
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          include: ["src/**/*.test.ts", "e2e/**/*.unit.ts"],
          exclude: ["src/lib/catalog-prune.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "scripts",
          include: ["src/lib/catalog-prune.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
