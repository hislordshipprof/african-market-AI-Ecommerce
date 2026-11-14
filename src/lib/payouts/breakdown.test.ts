import { describe, expect, it } from "vitest";
import { defaultFakePayouts, fakePayoutPaymentIntentId, FAKE_PAYOUT_ORDERS } from "@/lib/stripe/fake-payouts";
import { payoutBreakdown, payoutCsv, type PayoutOrder } from "./breakdown";

const ACCOUNT = "acct_breakdown";
const data = defaultFakePayouts(ACCOUNT);
const [second, first] = data.payouts;
const orders: PayoutOrder[] = FAKE_PAYOUT_ORDERS.map((o, i) => ({
  ...o,
  id: `order_${o.key}`,
  number: 101 + i,
  paymentIntentId: fakePayoutPaymentIntentId(o.key, ACCOUNT),
}));

describe("payoutBreakdown", () => {
  it("adds each order's net from capturedPayout up to the payout amount", () => {
    const result = payoutBreakdown(first.amountCents, data.transactions.get(first.id)!, orders);
    expect(result.rows.map((r) => r.number)).toEqual([101, 102]);
    expect(result.rows[0]).toMatchObject({
      goodsCents: 5000 - 150 - 300,
      tipCents: 300,
      taxCents: 0,
      cardFeeCents: 171,
      refundsCents: 1000,
      netCents: 4679 - 1000,
    });
    // Courier order: the courier fee and service fee are the platform's, not goods.
    expect(result.rows[1]).toMatchObject({ goodsCents: 3000 - 99 - 599, cardFeeCents: 97, refundsCents: 0, netCents: 2205 });
    expect(result.otherCents).toBe(0);
    expect(result.rows.reduce((sum, r) => sum + r.netCents, 0)).toBe(first.amountCents);
  });

  it("shows a refund on an order paid in an earlier payout as the refund only, less the fee Stripe credited back", () => {
    const result = payoutBreakdown(second.amountCents, data.transactions.get(second.id)!, orders);
    const b = result.rows.find((r) => r.number === 102)!;
    expect(b).toMatchObject({ paidInPayout: false, goodsCents: 0, tipCents: 0, cardFeeCents: 0, refundsCents: 467, netCents: -467 });
    // Store delivery: the store keeps its delivery fee, so it stays with the goods.
    expect(result.rows.find((r) => r.number === 103)).toMatchObject({ goodsCents: 4200 - 117 - 200, cardFeeCents: 148, netCents: 3935 });
    expect(result.otherCents).toBe(0);
  });

  it("takes the amount from Stripe's payment when the order never recorded its capture", () => {
    const unrecorded = orders.map((o) => (o.number === 101 ? { ...o, capturedAmountCents: null } : o));
    const result = payoutBreakdown(first.amountCents, data.transactions.get(first.id)!, unrecorded);
    expect(result.rows[0]).toMatchObject({ goodsCents: 5000 - 150 - 300, netCents: 4679 - 1000 });
  });

  it("puts activity with no order of this store under other, so the total still matches", () => {
    const txns = [
      ...data.transactions.get(first.id)!,
      { id: "txn_adj", type: "adjustment", amountCents: -250, feeCents: 0, netCents: -250, paymentIntentId: null },
    ];
    const result = payoutBreakdown(first.amountCents - 250, txns, orders.filter((o) => o.number !== 102));
    expect(result.rows.map((r) => r.number)).toEqual([101]);
    expect(result.otherCents).toBe(2205 - 250);
  });
});

describe("payoutCsv", () => {
  it("has one row per order, an other row and a total in dollars", () => {
    const result = payoutBreakdown(first.amountCents, data.transactions.get(first.id)!, orders);
    const csv = payoutCsv(result);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Order,Goods,Tip,Tax,Card fee,Refunds,Net to store");
    expect(lines[1]).toBe("#101,45.50,3.00,0.00,1.71,10.00,36.79");
    expect(lines.at(-2)).toBe("Other Stripe activity,,,,,,0.00");
    expect(lines.at(-1)).toBe("Payout total,,,,,,58.84");
  });
});
