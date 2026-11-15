import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest rejects unknown flags and its workers never see this process's argv, so the package script ends in `--`
 * and the config hands `--only` and `--limit` to the run as ASSISTANT_EVAL_ONLY / ASSISTANT_EVAL_LIMIT.
 */
export function evalFlagEnv(argv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["only", "limit"]) {
    const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (index < 0) continue;
    const arg = argv[index]!;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
    // A missing value must not fall back to the full paid run.
    if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    env[`ASSISTANT_EVAL_${name.toUpperCase()}`] = value;
  }
  return env;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/assistant/eval/live.entry.ts"],
    setupFiles: ["src/lib/assistant/eval/live-setup.ts"],
    env: evalFlagEnv(process.argv),
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
