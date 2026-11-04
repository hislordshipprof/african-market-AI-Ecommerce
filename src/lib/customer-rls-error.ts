/**
 * A Customer write is an RLS rejection only when PostgreSQL names the
 * customers policy. SQLSTATE 42501 also means a plain privilege failure,
 * so a code alone is not enough. When the driver exposes 42501, require it
 * alongside the policy text.
 */
export function customerRlsErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      message?: unknown;
      code?: unknown;
      meta?: { code?: unknown };
      cause?: unknown;
    };
    if (typeof record.message === "string") parts.push(record.message);
    if (typeof record.code === "string" || typeof record.code === "number") {
      parts.push(String(record.code));
    }
    if (typeof record.meta?.code === "string" || typeof record.meta?.code === "number") {
      parts.push(String(record.meta.code));
    }
    current = record.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join("\n");
}

export function isCustomerRlsRejection(error: unknown): boolean {
  const text = customerRlsErrorText(error);
  if (!/row-level security policy for table "customers"/i.test(text)) return false;
  return /\b42501\b/.test(text);
}
