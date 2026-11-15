import { appRateLimitCleanup, appRateLimitUpsert } from "../db";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;

export type RateLimitResult =
  | { ok: true; count: number }
  | { ok: false; count: number; retryAfter: number };

/**
 * Fixed window counted in epoch milliseconds. One upsert, so concurrent
 * callers cannot both pass the same slot. `now` is epoch ms; the server
 * time zone is never read.
 */
export async function takeRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const nowMs = BigInt(now);
  const boundary = nowMs - BigInt(windowMs);
  const row = await appRateLimitUpsert(key, nowMs, boundary);
  await cleanupExpired(BigInt(Date.now()));
  if (row.count <= max) return { ok: true, count: row.count };
  const retryAfter = Math.max(
    1,
    Math.ceil((Number(row.windowStart) + windowMs - now) / 1000),
  );
  return { ok: false, count: row.count, retryAfter };
}

/** Drops rows whose window started more than 24h ago. A live window is kept. */
async function cleanupExpired(nowMs: bigint): Promise<void> {
  const cutoff = nowMs - BigInt(DAY_MS);
  await appRateLimitCleanup(cutoff, CLEANUP_BATCH);
}
