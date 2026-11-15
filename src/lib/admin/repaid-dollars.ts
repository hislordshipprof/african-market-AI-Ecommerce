/** Dollars as typed, to cents. "10.5" is 1050. Anything that is not a dollar amount is rejected. */
export function parseRepaidDollars(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
