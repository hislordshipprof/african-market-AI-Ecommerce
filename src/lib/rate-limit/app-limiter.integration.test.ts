import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it } from "vitest";
import { appRateLimitCleanup, authPrisma } from "../db";
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

describe.skipIf(!hasDb || process.env.TZ_CHILD === "1")("app rate limit cleanup race", () => {
  it("a window refreshed while cleanup waits is kept", async () => {
    const key = `fresh-${Date.now()}-${Math.random()}`;
    const day = BigInt(24 * 60 * 60 * 1000);
    const cutoff = BigInt(Date.now()) - day;
    await authPrisma.$executeRaw`
      DELETE FROM app_rate_limits WHERE window_start < ${cutoff} AND key <> ${key}
    `;
    await authPrisma.appRateLimit.create({
      data: { key, windowStart: cutoff - BigInt(60_000), count: 9 },
    });
    const writer = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await writer.$connect();
    const now = BigInt(Date.now());
    const boundary = now - BigInt(60_000);
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writing = writer.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO app_rate_limits (key, window_start, count)
        VALUES (${key}, ${now}, 1)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE
            WHEN app_rate_limits.window_start < ${boundary}
            THEN 1
            ELSE app_rate_limits.count + 1
          END,
          window_start = CASE
            WHEN app_rate_limits.window_start < ${boundary}
            THEN ${now}
            ELSE app_rate_limits.window_start
          END
      `;
      markReady();
      await released;
    }, { timeout: 20_000 });
    try {
      await ready;
      const deleting = appRateLimitCleanup(cutoff, 100);
      const deadline = Date.now() + 3_000;
      let locked = false;
      while (Date.now() < deadline) {
        const rows = await authPrisma.$queryRaw<Array<{ wait_event_type: string | null }>>`
          SELECT wait_event_type FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%app_rate_limits%'
        `;
        if (rows.length > 0) {
          locked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(locked).toBe(true);
      release();
      await writing;
      await deleting;
      const row = await authPrisma.appRateLimit.findUnique({ where: { key } });
      expect(row?.count).toBe(1);
      const next = await takeRateLimit(key, 1, 60_000, Number(now) + 1);
      expect(next).toMatchObject({ ok: false, count: 2 });
    } finally {
      release();
      await writing.catch(() => {});
      await authPrisma.appRateLimit.delete({ where: { key } }).catch(() => {});
      await writer.$disconnect();
    }
  }, 30_000);
});
