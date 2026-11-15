import { describe, expect, it } from "vitest";
import { accountOrderRow, type AccountOrderRecord } from "./order-history-view";

const order = (over: Partial<AccountOrderRecord>): AccountOrderRecord => ({
  id: "order-1",
  number: 1001,
  status: "AUTHORIZED",
  createdAt: new Date("2026-11-01T15:00:00Z"),
  subtotalCents: 2500,
  tipCents: 300,
  deliveryFeeCents: 0,
  serviceFeeCents: 0,
  capturedAmountCents: null,
  refundId: null,
  trackingToken: null,
  itemCount: 1,
  ...over,
});

const amount = (over: Partial<AccountOrderRecord>) =>
  accountOrderRow(order(over), "America/New_York").amountLabel;

describe("account order history amount", () => {
  // The order service writes refundId on a failed refund ("Customer is still charged") and on
  // one still pending, not only on one that settled. Telling that customer "Refunded" is false.
  it("says Refunded only when the refund settled", () => {
    expect(amount({ status: "REFUND_FAILED", refundId: "re_1", capturedAmountCents: 1875 })).toBe("$18.75");
    expect(amount({ status: "REFUND_FAILED", refundId: "re_1", capturedAmountCents: null })).toBe("Refund pending");
    expect(amount({ status: "CANCELLING", refundId: "re_1", capturedAmountCents: 3000 })).toBe("Refund pending");
    expect(amount({ status: "CANCELLING", refundId: "re_1", capturedAmountCents: null })).toBe("Refund pending");
    expect(amount({ status: "CANCELLED", refundId: "re_1", capturedAmountCents: null })).toBe("Refunded");
  });
});

describe("account order history link", () => {
  it("links to the tracking token, and to the id only for an order made before tokens", () => {
    const token = "RCEN5kMdbbYYXWjj4MQ_u-307lZa8eyHU2gizis0C4w";
    expect(accountOrderRow(order({ trackingToken: token }), "America/New_York").href).toBe(`/order/${token}`);
    expect(accountOrderRow(order({ trackingToken: null }), "America/New_York").href).toBe("/order/order-1");
  });
});
