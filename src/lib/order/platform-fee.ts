/**
 * Application fee at capture (platform-spec §10).
 *
 * The per-order platform price is still open (spec §14), so that component is $0.
 * Destination charges debit Stripe's card fee from the platform, so the store's
 * payout is reduced by the published US online rate (2.9% + 30¢), capped at the
 * captured amount. Courier recovery is the delivery fee and is added on top,
 * still capped at the captured amount.
 */
export const PLATFORM_PER_ORDER_FEE_CENTS = 0;
export const CARD_FEE_BPS = 290;
export const CARD_FEE_FIXED_CENTS = 30;

export function cardProcessingFeeCents(capturedCents: number): number {
  if (capturedCents <= 0) return 0;
  return Math.round((capturedCents * CARD_FEE_BPS) / 10_000) + CARD_FEE_FIXED_CENTS;
}

/** Platform fee stored on the order: per-order fee + card recovery, excluding courier recovery. */
export function platformFeeCentsForCapture(capturedCents: number): number {
  if (capturedCents <= 0) return 0;
  return Math.min(
    PLATFORM_PER_ORDER_FEE_CENTS + cardProcessingFeeCents(capturedCents),
    capturedCents,
  );
}

/** Value sent as Stripe `application_fee_amount`. Store delivery keeps its fee. */
export function applicationFeeForCapture(
  capturedCents: number,
  options: { fulfillment: string; deliveryFeeCents: number },
): number {
  if (capturedCents <= 0) return 0;
  const courierRecovery = options.fulfillment === "courier" ? Math.max(0, options.deliveryFeeCents) : 0;
  const raw = platformFeeCentsForCapture(capturedCents) + courierRecovery;
  return Math.min(raw, capturedCents);
}
