import { defineConfig, devices } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7);
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const E2E_PORT = process.env.E2E_PORT || "3000";

// .env files cannot interpolate, so the auth origin follows E2E_PORT here.
// Explicit values (CI job env, shell) still win.
process.env.BETTER_AUTH_URL ??= `http://localhost:${E2E_PORT}`;
process.env.BETTER_AUTH_TRUSTED_ORIGINS ??= `http://localhost:${E2E_PORT}`;

loadEnvFile(resolve(__dirname, ".env.e2e"));
loadEnvFile(resolve(__dirname, ".env.local"));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Locally several build lanes share one machine. Playwright's default (half the CPU cores) runs about 12
  // browsers per lane and starves memory. E2E_WORKERS overrides it; scripts/build-ticket.sh sets it per lane.
  workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS) || 4,
  reporter: "html",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: `pnpm exec next start -p ${E2E_PORT}`,
        url: `http://localhost:${E2E_PORT}/api/health`,
        // Reusing whatever already listens on the lane port served stale builds from deleted
        // worktrees (ChunkLoadError on #110). Fail fast instead; opt in with E2E_REUSE_SERVER=1.
        reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
        timeout: 120_000,
        env: {
          NEXT_PUBLIC_DEMO_FLOWS: "1",
          E2E_STORE_OVERRIDE: "1",
          VERCEL_ENV: "preview",
        },
      },
});
