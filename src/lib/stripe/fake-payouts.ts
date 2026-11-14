import type { Payout, PayoutTransaction } from "./types";

/**
 * The orders behind the fake payouts, as capture stored them. Tests and e2e seed these orders
 * with `fakePayoutPaymentIntentId(key, accountId)`. Stripe's side of each is fixed below, so the
 * page's per-order net (from `capturedPayout`) must add up to the payout on its own.
 */
export const FAKE_PAYOUT_ORDERS = [
  { key: "a", fulfillment: "pickup", capturedAmountCents: 5000, serviceFeeCents: 150, tipCents: 300, deliveryFeeCents: 0, platformFeeCents: 321 },
  { key: "b", fulfillment: "courier", capturedAmountCents: 3000, serviceFeeCents: 99, tipCents: 0, deliveryFeeCents: 599, platformFeeCents: 196 },
  { key: "c", fulfillment: "store_delivery", capturedAmountCents: 4200, serviceFeeCents: 117, tipCents: 200, deliveryFeeCents: 399, platformFeeCents: 265 },
] as const;

export type FakePayoutData = { payouts: Payout[]; transactions: Map<string, PayoutTransaction[]> };

export function fakePayoutPaymentIntentId(key: string, accountId: string): string {
  return `pi_fake_payout_${key}_${accountId}`;
}

/** Two payouts: a paid one with orders a and b and a refund on a, and one in transit with c and a refund on b with its fee refund. */
export function defaultFakePayouts(accountId: string): FakePayoutData {
  const pi = (key: string) => fakePayoutPaymentIntentId(key, accountId);
  const first = `po_fake_${accountId}_1`;
  const second = `po_fake_${accountId}_2`;
  const payment = (id: string, key: string, amount: number, fee: number): PayoutTransaction => ({
    id, type: "payment", amountCents: amount, feeCents: fee, netCents: amount - fee, paymentIntentId: pi(key),
  });
  const refund = (id: string, key: string, amount: number): PayoutTransaction => ({
    id, type: "payment_refund", amountCents: -amount, feeCents: 0, netCents: -amount, paymentIntentId: pi(key),
  });
  // Stripe credits a refunded application fee back to the store as an adjustment on the order's charge.
  const feeRefund = (id: string, key: string, amount: number): PayoutTransaction => ({
    id, type: "adjustment", amountCents: amount, feeCents: 0, netCents: amount, paymentIntentId: pi(key),
  });
  return {
    payouts: [
      { id: second, amountCents: 3468, arrivalDate: Date.UTC(2026, 10, 13) / 1000, status: "in_transit" },
      { id: first, amountCents: 5884, arrivalDate: Date.UTC(2026, 10, 6) / 1000, status: "paid" },
    ],
    transactions: new Map([
      [first, [payment(`txn_${first}_a`, "a", 5000, 321), payment(`txn_${first}_b`, "b", 3000, 795), refund(`txn_${first}_ra`, "a", 1000)]],
      [second, [payment(`txn_${second}_c`, "c", 4200, 265), refund(`txn_${second}_rb`, "b", 500), feeRefund(`txn_${second}_fb`, "b", 33)]],
    ]),
  };
}
