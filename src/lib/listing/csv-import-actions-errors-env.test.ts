import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authPrisma } from "../db";

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const suite = "src/lib/listing/csv-import-actions-errors.integration.test.ts";
const REQUIRED_KEYS = ["DATABASE_URL", "DIRECT_URL", "APP_RUNTIME_PASSWORD", "BETTER_AUTH_SECRET"] as const;

function scrub(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function runSuite(overrides: Record<string, string | undefined>, extraArgs: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [vitestEntry, "run", suite, "--reporter=verbose", ...extraArgs], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    status: result.status,
    output: scrub(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
  };
}

// Better Auth keeps a 3-per-10-seconds rule for /sign-up and /two-factor/enable.
// AUTH_RATE_LIMIT_RELAXED does not widen those paths. Each production-mode
// process starts from an empty rate-limit table so the two processes, and any
// sibling Vitest file, do not share that bucket.
async function clearAuthRateLimits(): Promise<void> {
  await authPrisma.rateLimit.deleteMany({});
}

async function runProductionMode(overrides: Record<string, string | undefined>, extraArgs: string[]) {
  let result = { status: 1, output: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clearAuthRateLimits();
    result = runSuite(overrides, extraArgs);
    if (result.status === 0) return result;
    if (!result.output.includes("Too many requests")) return result;
  }
  return result;
}

describe("csv commit action error suite env", () => {
  it("required integration invocation fails for each missing required key", () => {
    for (const key of REQUIRED_KEYS) {
      const result = runSuite({ REQUIRE_CSV_COMMIT_ERRORS: "1", [key]: "" });
      expect(result.status, result.output.slice(-2500)).not.toBe(0);
      expect(result.output).toContain(`csv commit error suite requires ${key}`);
      expect(result.output).not.toMatch(/Tests\s+\d+\s+passed/);
      expect(result.output).not.toMatch(/\d+ skipped/);
    }
  }, 180_000);

  it("production error mapping is unchanged with Vercel flags absent and present", async () => {
    const filter = ["-t", "production error mapping is unchanged with Vercel flags absent and present"];
    const absent = await runProductionMode(
      {
        NODE_ENV: "production",
        CI: "true",
        AUTH_RATE_LIMIT_RELAXED: "1",
        CSV_COMMIT_PROD_CHECK: "1",
        VERCEL: undefined,
        VERCEL_ENV: undefined,
        CSV_COMMIT_EXPECT_VERCEL: undefined,
      },
      filter,
    );
    expect(absent.status, absent.output.slice(-2500)).toBe(0);
    expect(absent.output).toContain("production error mapping is unchanged with Vercel flags absent and present");
    expect(absent.output).toMatch(/Tests\s+1 passed/);

    const present = await runProductionMode(
      {
        NODE_ENV: "production",
        CI: "true",
        AUTH_RATE_LIMIT_RELAXED: "1",
        CSV_COMMIT_PROD_CHECK: "1",
        CSV_COMMIT_EXPECT_VERCEL: "1",
        VERCEL: "1",
        VERCEL_ENV: "production",
      },
      filter,
    );
    expect(present.status, present.output.slice(-2500)).toBe(0);
    expect(present.output).toContain("production error mapping is unchanged with Vercel flags absent and present");
    expect(present.output).toMatch(/Tests\s+1 passed/);
  }, 180_000);
});
