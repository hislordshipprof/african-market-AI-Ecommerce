import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const LINK_CODE_PATTERN = /^\d{6}$/;
export const LINK_CODE_TTL_MINUTES = 10;
export const MAX_LINK_CODE_ATTEMPTS = 5;

export function generateLinkCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Stored instead of the code. Bound to the membership, so a hash cannot be replayed on another row. */
export function hashLinkCode(storeId: string, userId: string, code: string): string {
  return createHash("sha256").update(`${storeId}:${userId}:${code}`).digest("hex");
}

export function linkCodeMatches(
  row: { storeId: string; userId: string; codeHash: string | null },
  code: string,
): boolean {
  if (!row.codeHash) return false;
  const expected = Buffer.from(hashLinkCode(row.storeId, row.userId, code), "hex");
  const stored = Buffer.from(row.codeHash, "hex");
  if (stored.length !== expected.length) return false;
  return timingSafeEqual(stored, expected);
}

/** Rate-limit and log key for a number: never the number itself. */
export function phoneKey(value: string): string {
  return createHash("sha256").update(value.replace(/\D/g, "")).digest("hex").slice(0, 32);
}
