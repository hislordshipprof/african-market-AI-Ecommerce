/** Stripe 5xx and connection failures. Same-key retries replay a stored 5xx for ~24h. */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: number; type?: string };
  if (typeof candidate.statusCode === "number" && candidate.statusCode >= 500) return true;
  return candidate.type === "StripeConnectionError" || candidate.type === "StripeAPIError";
}
