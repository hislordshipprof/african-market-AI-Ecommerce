import { spawnSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { appRateLimitCleanup, authPrisma } from "../db";
import { waitForLockWaiters } from "../listing/import-lock-test-helpers";
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

  it("logs one rate_limited event per window, naming the scope but not the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const key = `directory-near:ip:${ip}-${Date.now()}`;
    const now = Date.now();
    for (let i = 0; i < 5; i++) await takeRateLimit(key, 2, 60_000, now + i);
    const events = warn.mock.calls.map((call) => JSON.parse(String(call[0]))).filter((e) => e.event === "rate_limited");
    expect(events).toEqual([{ event: "rate_limited", source: "app", scope: "directory-near", key: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ip);
    warn.mockRestore();
    await authPrisma.appRateLimit.delete({ where: { key } });
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
    const now = BigInt(Date.now());
    // Park the row just inside the 24h cutoff that ordinary takeRateLimit cleanups use, so only this
    // test's explicit cutoff reaches it. Other rows (here 101 slightly older windows, like the ones
    // other test files leave behind) must not push it out of the bounded cleanup, so the call below
    // is given a limit above every row that can match.
    const windowStart = now - BigInt(24 * 60 * 60 * 1000) + BigInt(5 * 60 * 1000);
    const cutoff = windowStart + BigInt(1);
    const crowdPrefix = `crowd-${key}-`;
    const crowdWindow = now - BigInt(24 * 60 * 60 * 1000) + BigInt(2 * 60 * 1000);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await authPrisma.appRateLimit.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({ key: `${crowdPrefix}${i}`, windowStart: crowdWindow, count: 1 })),
      });
      await authPrisma.appRateLimit.create({ data: { key, windowStart, count: 4 } });
      await client.query("BEGIN");
      await client.query("SELECT key FROM app_rate_limits WHERE key = $1 FOR UPDATE", [key]);
      await client.query("UPDATE app_rate_limits SET window_start = $2, count = 1 WHERE key = $1", [key, now.toString()]);
      const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const cleanup = appRateLimitCleanup(cutoff, 2_000_000_000);
      await waitForLockWaiters(pid, 1, { label: "cleanup waits on the refreshed window", timeoutMs: 10_000 });
      await client.query("COMMIT");
      await cleanup;
      const row = await authPrisma.appRateLimit.findUnique({ where: { key } });
      expect(row?.count).toBe(1);
      const next = await takeRateLimit(key, 1, 60_000, Number(now) + 1);
      expect(next).toMatchObject({ ok: false, count: 2 });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
      await authPrisma.appRateLimit.delete({ where: { key } }).catch(() => undefined);
      await authPrisma.appRateLimit.deleteMany({ where: { key: { startsWith: crowdPrefix } } }).catch(() => undefined);
    }
  }, 30_000);
});
