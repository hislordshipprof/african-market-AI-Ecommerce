import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER_SHAPE = /^sha256=([0-9a-f]{64})$/;

/**
 * Meta's `X-Hub-Signature-256`: `sha256=` and the hex HMAC-SHA256 of the raw
 * request body, keyed by the app secret. Verify the bytes as received; Meta
 * escapes non-ASCII before signing, so a re-serialised body would not match.
 */
export function verifyWhatsAppSignature(
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const match = HEADER_SHAPE.exec(header.trim().toLowerCase());
  if (!match) return false;
  const received = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/** Header value for a body, for tests and local tooling. */
export function signWhatsAppBody(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}
