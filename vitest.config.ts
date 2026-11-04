import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
// Next resolves this marker to an empty module on the server. Vitest does not,
// and the published package throws from its default entry.
const serverOnlyEmpty = path.join(path.dirname(require.resolve("server-only")), "empty.js");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/lib/test-setup.ts"],
    testTimeout: 15_000,
    // Eight or more workers stall the Vitest parent past its 60s onTaskUpdate
    // timeout after the suite has already passed. Four matches hosted CI.
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
      "server-only": serverOnlyEmpty,
    },
  },
});
