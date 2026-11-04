/** Stripe sends no code for this. The message is pinned by the sandbox contract. */
export class OverRefundError extends Error {
  readonly type = "StripeInvalidRequestError";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "OverRefundError";
  }
}

export function overRefundError(err: unknown): OverRefundError | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { code?: string; message?: string; type?: string };
  if (!candidate.message || !/greater than (?:unrefunded amount on charge|charge amount)/i.test(candidate.message)) {
    return null;
  }
  return new OverRefundError(candidate.message);
}

/** A missing refund status is pending, not succeeded. */
export function mapRefundStatus(status: string | null | undefined): string {
  return status ?? "pending";
}

export class WebhookSecretMissingError extends Error {
  constructor() {
    super("STRIPE_WEBHOOK_SECRET is not set");
    this.name = "WebhookSecretMissingError";
  }
}

/** A 409 idempotency_key_in_use is another request still in flight. It is not stored. */
export function isIdempotencyKeyInUse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: number; code?: string };
  return candidate.statusCode === 409 && candidate.code === "idempotency_key_in_use";
}

/** Stripe 5xx and connection failures. Same-key retries replay a stored 5xx for ~24h. */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: number; type?: string };
  if (typeof candidate.statusCode === "number" && candidate.statusCode >= 500) return true;
  return candidate.type === "StripeConnectionError" || candidate.type === "StripeAPIError";
}
