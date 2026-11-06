const PHONE_RE = /^\+?[\d\s().-]{10,20}$/;

/** The checkout contact rule. Whitespace-only is not a phone number. */
export function validPhone(phone: string): boolean {
  return PHONE_RE.test(phone) && phone.replace(/\D/g, "").length >= 10;
}
