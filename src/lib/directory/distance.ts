/** A store this close counts as near; beyond it the directory shows the nearest stores anyway (#447). */
export const NEARBY_MILES = 50;

/** Distance on a directory card: tenths under 10 miles (never "0.0"), whole miles beyond. */
export function formatMiles(miles: number): string {
  const tenths = Math.max(0.1, Math.round(miles * 10) / 10);
  if (tenths < 10) return `${tenths.toFixed(1)} mi`;
  return `${Math.round(miles).toLocaleString("en-US")} mi`;
}
