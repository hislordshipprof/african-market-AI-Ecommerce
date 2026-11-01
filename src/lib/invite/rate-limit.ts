import { authPrisma } from "../db";

export const INVITE_RATE_LIMIT_MAX = 20;
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function checkInviteRateLimit(
  storeId: string,
): Promise<{ allowed: boolean; count: number }> {
  const key = `invite:${storeId}`;
  const now = BigInt(Date.now());
  const windowStart = now - BigInt(INVITE_RATE_LIMIT_WINDOW_MS);

  const rows = await authPrisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid()::text, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request < ${windowStart}
        THEN 1
        ELSE rate_limits.count + 1
      END,
      last_request = ${now}
    RETURNING count
  `;

  const count = Number(rows[0].count);
  return { allowed: count <= INVITE_RATE_LIMIT_MAX, count };
}
