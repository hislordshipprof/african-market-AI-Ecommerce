export const SAVED_CARD_TERMS_VERSION = "2026-11-05";
export const SAVED_CARD_PURPOSE =
  "Save this card on your Globe Grocer account and reuse it at any store while you are signed in.";

const SUBSTITUTION_PHONE = "A phone number helps your shopper reach you about substitutions.";

/** The line above checkout's contact fields: it names only the fields the account actually filled (#750); a guest passes null. */
export function contactPrefillNote(filled: { name: string; phone: string; email: string } | null): string {
  if (!filled) return `Guest checkout. ${SUBSTITUTION_PHONE}`;
  const fields = [
    filled.name.trim() && "name",
    filled.phone.trim() && "phone number",
    filled.email.trim() && "email",
  ].filter(Boolean);
  if (!fields.length) return SUBSTITUTION_PHONE;
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}` : fields[0];
  return `We filled your ${list} from your account. Edits apply to this order only.`;
}
