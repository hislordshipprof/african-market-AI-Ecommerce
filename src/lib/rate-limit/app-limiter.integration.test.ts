import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authPrisma } from "../db";
import { takeRateLimit } from "./app-limiter";

const hasDb = !!process.env.DATABASE_URL;
const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

describe.skipIf(!hasDb || process.env.TZ_CHILD === "1")("app rate limit", () => {
  it("per-key window", async () => {
    const key = `win-${Date.now()}-${Math.random()}`;
    const now = Date.now();
    expect((await takeRateLimit(key, 2, 1_000, now)).count).toBe(1);
    expect((await takeRateLimit(key, 2, 1_000, now + 10)).ok).toBe(true);
    const blocked = await takeRateLimit(key, 2, 1_000, now + 20);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(0);
    const reset = await takeRateLimit(key, 2, 1_000, now + 1_001);
    expect(reset).toMatchObject({ ok: true, count: 1 });
    await authPrisma.appRateLimit.delete({ where: { key } });
  });

  it("other key unaffected", async () => {
    const now = Date.now();
    const blockedKey = `block-${now}`;
    const otherKey = `other-${now}`;
    await takeRateLimit(blockedKey, 1, 60_000, now);
    expect((await takeRateLimit(blockedKey, 1, 60_000, now + 1)).ok).toBe(false);
    expect((await takeRateLimit(otherKey, 1, 60_000, now + 1)).ok).toBe(true);
    await authPrisma.appRateLimit.deleteMany({ where: { key: { in: [blockedKey, otherKey] } } });
  });

  it("exactly max of 20 concurrent", async () => {
    const key = `conc-${Date.now()}-${Math.random()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => takeRateLimit(key, 10, 60_000)));
    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(results.filter((result) => !result.ok)).toHaveLength(10);
    await authPrisma.appRateLimit.delete({ where: { key } });
  });

  it("epoch windows ignore TZ", () => {
    const counts: string[] = [];
    for (const tz of ["UTC", "Pacific/Honolulu"]) {
      const child = spawnSync(process.execPath, [
        vitestEntry, "run", "src/lib/rate-limit/app-limiter.integration.test.ts", "-t", "tz child count",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: tz, TZ_CHILD: "1" },
        encoding: "utf8",
        timeout: 120_000,
      });
      const match = `${child.stdout}\n${child.stderr}`.match(/TZ_COUNT (\d+ \d+)/);
      expect(child.status, `${tz}\n${child.stdout}\n${child.stderr}`).toBe(0);
      counts.push(match?.[1] ?? "");
    }
    expect(counts).toEqual(["1 2", "1 2"]);
  }, 150_000);
});

describe.skipIf(process.env.TZ_CHILD !== "1")("tz child", () => {
  it("tz child count", async () => {
    const now = Date.now();
    const key = `tz-${process.env.TZ}-${now}`;
    const first = await takeRateLimit(key, 2, 60_000, now);
    const second = await takeRateLimit(key, 2, 60_000, now + 1_000);
    console.log(`TZ_COUNT ${first.count} ${second.count}`);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    await authPrisma.appRateLimit.delete({ where: { key } });
  });
});
