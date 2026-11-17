import { createHash } from "node:crypto";

/** A short one-way tag, so repeated events from one source can be grouped without storing it. */
export function hashTag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** One structured security event on stderr. Callers pass hashes and names only, never secrets or PII. */
export function logSecurityEvent(event: string, fields: Record<string, string | number | null> = {}): void {
  console.warn(JSON.stringify({ event, ...fields }));
}
