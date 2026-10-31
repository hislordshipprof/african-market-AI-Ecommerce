export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars}${remainder > 0 ? `.${String(remainder).padStart(2, "0")}` : ""}`;
}

export function formatWeight(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
  return `${grams} g`;
}
