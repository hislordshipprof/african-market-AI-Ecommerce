const HONOLULU = "Pacific/Honolulu";

/** A card is expired when its month is before the current month in Pacific/Honolulu. */
export function isCardExpired(expMonth: number, expYear: number, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HONOLULU,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isInteger(expMonth) || !Number.isInteger(expYear)) return true;
  if (expYear < year) return true;
  if (expYear > year) return false;
  return expMonth < month;
}
