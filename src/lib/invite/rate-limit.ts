import { rateLimitUpsert } from "../db";

export const INVITE_RATE_LIMIT_MAX = 20;
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function checkInviteRateLimit(
  storeId: string,
): Promise<{ allowed: boolean; count: number }> {
  const key = `invite:${storeId}`;
  const now = BigInt(Date.now());
  const windowStart = now - BigInt(INVITE_RATE_LIMIT_WINDOW_MS);

  const { count } = await rateLimitUpsert(key, now, windowStart);
  return { allowed: count <= INVITE_RATE_LIMIT_MAX, count };
}
