/**
 * The store's phone as couriers take it, E.164 (Uber Direct needs a pickup phone to book, #527). Empty clears it;
 * anything but a 10-digit US number, with or without a leading 1, is refused.
 */
export function storePhone(raw: string | null | undefined): { ok: true; phone: string | null } | { ok: false } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { ok: true, phone: null };
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return { ok: true, phone: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) return { ok: true, phone: `+${digits}` };
  return { ok: false };
}
