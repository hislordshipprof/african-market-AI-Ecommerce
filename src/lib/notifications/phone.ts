export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: "no_phone" | "invalid_phone" | "sms_non_us_number" };

/**
 * US numbers only (ADR-0001). 10 digits, or 11 starting with 1, become +1.
 * A leading + is US only when it is 11 digits starting with 1. Any other
 * country code is skipped. 555-01xx is fictional.
 */
export function normalizeUsPhone(raw: string | null | undefined): PhoneResult {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { ok: false, reason: "no_phone" };
  const digits = trimmed.replace(/\D/g, "");
  const explicitPlus = trimmed.startsWith("+");
  let national = "";
  if (explicitPlus) {
    if (!(digits.length === 11 && digits.startsWith("1"))) {
      return { ok: false, reason: "sms_non_us_number" };
    }
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    national = digits.slice(1);
  } else {
    return { ok: false, reason: "invalid_phone" };
  }
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  const line = national.slice(6);
  if (area.startsWith("0") || area.startsWith("1") || exchange.startsWith("0") || exchange.startsWith("1")) {
    return { ok: false, reason: "invalid_phone" };
  }
  if (exchange === "555" && line.startsWith("01")) {
    return { ok: false, reason: "invalid_phone" };
  }
  return { ok: true, e164: `+1${national}` };
}
