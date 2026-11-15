import { takeRateLimit } from "../rate-limit/app-limiter";

export const INVITE_RATE_LIMIT_MAX = 20;
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function checkInviteRateLimit(
  storeId: string,
  nowMs?: number,
): Promise<{ allowed: boolean; count: number }> {
  const result = await takeRateLimit(
    `invite:${storeId}`,
    INVITE_RATE_LIMIT_MAX,
    INVITE_RATE_LIMIT_WINDOW_MS,
    nowMs ?? Date.now(),
  );
  return { allowed: result.ok, count: result.count };
}
