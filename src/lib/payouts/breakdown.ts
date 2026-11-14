import { capturedPayout, courierFeeCents } from "@/lib/order/platform-fee";
import { csvDollars, toCsv } from "@/lib/analytics/csv";
import type { PayoutTransaction } from "@/lib/stripe/types";

export type PayoutOrder = {
  id: string;
  number: number;
  paymentIntentId: string | null;
  fulfillment: string;
  capturedAmountCents: number | null;
  platformFeeCents: number | null;
  serviceFeeCents: number;
  tipCents: number;
  deliveryFeeCents: number;
};

export type PayoutOrderRow = {
  orderId: string;
  number: number;
  /** False when only a refund on this order landed in this payout. */
  paidInPayout: boolean;
  goodsCents: number;
  tipCents: number;
  taxCents: number;
  cardFeeCents: number;
  refundsCents: number;
  netCents: number;
};

export type PayoutBreakdown = {
  rows: PayoutOrderRow[];
  /** Payout activity that is not one of the store's orders (disputes, untraced adjustments). */
  otherCents: number;
  totalCents: number;
};

/** The store's orders in one payout, each from its captured split, plus refunds (net of fee refunds) Stripe took in it. */
export function payoutBreakdown(
  payoutAmountCents: number,
  transactions: PayoutTransaction[],
  orders: PayoutOrder[],
): PayoutBreakdown {
  const byIntent = new Map(orders.filter((o) => o.paymentIntentId).map((o) => [o.paymentIntentId!, o]));
  const rows = new Map<string, PayoutOrderRow>();
  for (const txn of transactions) {
    const order = txn.paymentIntentId ? byIntent.get(txn.paymentIntentId) : undefined;
    if (!order) continue;
    const row = rows.get(order.id) ?? {
      orderId: order.id, number: order.number, paidInPayout: false,
      goodsCents: 0, tipCents: 0, taxCents: 0, cardFeeCents: 0, refundsCents: 0, netCents: 0,
    };
    if (txn.type === "payment" && !row.paidInPayout) {
      // A destination charge lands at its full captured amount, so it stands in when capture was never recorded.
      const captured = order.capturedAmountCents ?? txn.amountCents;
      const split = capturedPayout({ ...order, capturedAmountCents: captured });
      // Orders carry no sales tax until Stripe Tax is on (ADR-0008); goods keep a store delivery fee.
      row.paidInPayout = true;
      row.goodsCents = captured - order.serviceFeeCents - order.tipCents - courierFeeCents(order);
      row.tipCents = order.tipCents;
      row.cardFeeCents = split.storeCardFeeCents;
      row.netCents += split.storeReceivesCents;
    } else if (txn.type === "payment_refund" || txn.type === "refund" || txn.type === "adjustment") {
      // An adjustment on the order's charge is the platform fee Stripe credits back with a refund.
      row.refundsCents -= txn.netCents;
      row.netCents += txn.netCents;
    } else {
      continue;
    }
    rows.set(order.id, row);
  }
  const sorted = [...rows.values()].sort((a, b) => a.number - b.number);
  const ordersNet = sorted.reduce((sum, row) => sum + row.netCents, 0);
  return { rows: sorted, otherCents: payoutAmountCents - ordersNet, totalCents: payoutAmountCents };
}

export function payoutCsv(breakdown: PayoutBreakdown): string {
  return toCsv([
    ["Order", "Goods", "Tip", "Tax", "Card fee", "Refunds", "Net to store"],
    ...breakdown.rows.map((r) => [
      `#${r.number}`,
      csvDollars(r.goodsCents),
      csvDollars(r.tipCents),
      csvDollars(r.taxCents),
      csvDollars(r.cardFeeCents),
      csvDollars(r.refundsCents),
      csvDollars(r.netCents),
    ]),
    ["Other Stripe activity", null, null, null, null, null, csvDollars(breakdown.otherCents)],
    ["Payout total", null, null, null, null, null, csvDollars(breakdown.totalCents)],
  ]);
}
