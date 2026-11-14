/** A provider refused because our account ran out of sends (429 quota or rate limit), not because of our code. */
export function isProviderQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b429\b/.test(error.message) && /quota|rate_limit/i.test(error.message);
}
