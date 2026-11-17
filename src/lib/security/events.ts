import { createHmac, randomBytes } from "node:crypto";
import { clientIp } from "@/lib/assistant/client-ip";

// Without a key, a hashed IPv4 address is reversed by hashing all 2^32 addresses (#712).
const fallbackKey = randomBytes(32);

/** A short keyed one-way tag, so repeated events from one source can be grouped without storing it. */
export function hashTag(value: string): string {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET || fallbackKey).update(value).digest("hex").slice(0, 16);
}

/** One structured security event on stderr. Callers pass hashes and names only, never secrets or PII. */
export function logSecurityEvent(event: string, fields: Record<string, string | number | null> = {}): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/** A webhook whose signature or shared secret did not match. The header value is never logged. */
export function logInvalidWebhookSignature(provider: string, headers: Headers): void {
  logSecurityEvent("webhook_signature_invalid", { provider, ip: hashTag(clientIp(headers)) });
}
