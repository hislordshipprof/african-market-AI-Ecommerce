import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/assistant/eval/live.entry.ts"],
    setupFiles: ["src/lib/assistant/eval/live-setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 0,
    hookTimeout: 0,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
