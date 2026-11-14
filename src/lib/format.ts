export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars}${remainder > 0 ? `.${String(remainder).padStart(2, "0")}` : ""}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: number) => usd.format(cents / 100);

export function formatWeight(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
  return `${grams} g`;
}

/** A date in the store's zone. `stores.timezone` is free text in the DB, so an unknown zone falls back to New York instead of throwing. */
export function formatInZone(date: Date | string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const at = new Date(date);
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/New_York" }).format(at);
  }
}
