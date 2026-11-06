import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auth } from "../auth";
import { authPrisma } from "../db";

const child = process.env.RATE_LIMIT_PRUNE_CHILD === "1";
const hasDb = !!process.env.DATABASE_URL;
const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

describe.skipIf(!hasDb || child)("app counters and Better Auth", () => {
  it("Better Auth window reset in a production child leaves app counters intact", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      RATE_LIMIT_PRUNE_CHILD: "1",
    };
    delete env.AUTH_RATE_LIMIT_RELAXED;
    delete env.VERCEL;
    delete env.VERCEL_ENV;
    const result = spawnSync(process.execPath, [
      vitestEntry,
      "run",
      "src/lib/rate-limit/app-limiter-better-auth.integration.test.ts",
      "-t",
      "production child prune",
    ], { cwd: process.cwd(), env, encoding: "utf8", timeout: 180_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("APP_COUNTERS_INTACT");
  }, 200_000);
});

describe.skipIf(!child)("production child prune", () => {
  it("production child prune", async () => {
    const run = `${Date.now()}`;
    const ip = `203.0.113.${Number(run.slice(-2)) % 200 + 20}`;
    const old = BigInt(Date.now() - 120_000);
    const appKeys = [`assistant:ip:${run}`, `invite:${run}`, `search:ip:${run}`];
    for (const key of appKeys) {
      await authPrisma.appRateLimit.upsert({
        where: { key },
        create: { key, windowStart: BigInt(Date.now() - 90_000), count: 4 },
        update: { windowStart: BigInt(Date.now() - 90_000), count: 4 },
      });
    }
    await authPrisma.rateLimit.create({
      data: { key: `${ip}|/sign-in/email`, count: 1, lastRequest: old },
    });
    await authPrisma.rateLimit.create({
      data: { key: `sacrificial-${run}`, count: 1, lastRequest: old },
    });

    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email: `nobody-${run}@test.example`, password: "not-a-real-password" }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);

    const sacrificial = await authPrisma.rateLimit.findUnique({ where: { key: `sacrificial-${run}` } });
    expect(sacrificial).toBeNull();
    for (const key of appKeys) {
      const row = await authPrisma.appRateLimit.findUnique({ where: { key } });
      expect(row?.count).toBe(4);
    }
    console.log("APP_COUNTERS_INTACT");
    await authPrisma.appRateLimit.deleteMany({ where: { key: { in: appKeys } } });
    await authPrisma.rateLimit.deleteMany({ where: { key: { in: [`${ip}|/sign-in/email`, `no-trusted-ip|/sign-in/email`] } } });
  });
});
