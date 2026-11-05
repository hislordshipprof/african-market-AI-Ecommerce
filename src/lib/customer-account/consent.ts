import { createHash } from "node:crypto";

export const SAVED_CARD_TERMS_VERSION = "2026-11-05";
export const SAVED_CARD_PURPOSE =
  "Save this card on your African Markets account and reuse it at any store while you are signed in.";

export const CARD_NOT_FOUND = "Card not found";
export const SAVED_CARD_UNAVAILABLE = "That card is no longer available";
export const CARDS_UNAVAILABLE = "Saved cards are unavailable right now";
export const CUSTOMER_AMBIGUOUS =
  "We couldn't confirm your saved-card account. Try again.";

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function idempotencyWindowMs(): number {
  return IDEMPOTENCY_WINDOW_MS;
}

/** Opaque key. The raw user id is not part of it. */
export function platformCustomerIdempotencyKey(userId: string, previousCustomerId?: string | null): string {
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  if (previousCustomerId) return `platform-customer-${hash}-after-${previousCustomerId}`;
  return `platform-customer-${hash}`;
}

export function cartPaymentIdempotencyKey(cartId: string, fingerprint: string): string {
  const hash = createHash("sha256").update(`${cartId}:${fingerprint}`).digest("hex").slice(0, 32);
  return `cart-pi-${hash}`;
}
