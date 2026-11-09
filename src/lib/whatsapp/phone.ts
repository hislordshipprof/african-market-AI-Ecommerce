export const PHONE_FORMAT_ERROR = "Enter the number with its country code";

export type PhoneResult = { ok: true; e164: string } | { ok: false; error: string };

/**
 * Owner's WhatsApp number to E.164. Spaces, dashes, dots and brackets are
 * dropped. `+` and 8–15 digits is kept as typed (any country). Ten digits, or
 * eleven starting with 1, are read as a US or Canada number.
 */
export function normalizeOwnerPhone(raw: string): PhoneResult {
  const stripped = raw.trim().replace(/[\s\-.()]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(stripped)) return { ok: true, e164: stripped };
  if (/^[2-9]\d{9}$/.test(stripped)) return { ok: true, e164: `+1${stripped}` };
  if (/^1[2-9]\d{9}$/.test(stripped)) return { ok: true, e164: `+${stripped}` };
  return { ok: false, error: PHONE_FORMAT_ERROR };
}

/** E.164 without the plus: the form Meta uses for wa_id and `to`. */
export function e164Digits(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** The only part of a number that may appear in a log line. */
export function lastFour(value: string): string {
  return value.replace(/\D/g, "").slice(-4);
}
