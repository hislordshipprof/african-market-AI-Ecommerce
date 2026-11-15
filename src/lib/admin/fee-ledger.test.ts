import { describe, expect, it } from "vitest";
import { buildFeeLedger, feeLedgerCsv, ledgerMonth, ledgerPage, parseLedgerMonth, shiftMonth, type CaptureFacts, type RefundFacts } from "./fee-ledger";

const NOW = new Date("2026-11-14T03:00:00Z");

describe("ledger month", () => {
  it("takes only a strict YYYY-MM and otherwise falls back to the current UTC month", () => {
    expect(parseLedgerMonth("2026-02", NOW)).toBe("2026-02");
    for (const bad of [undefined, "", "2026-13", "2026-2", "2026-02-01", " 2026-02", "2026-02'--", "x2026-02"]) {
      expect(parseLedgerMonth(bad, NOW)).toBe("2026-11");
    }
    // 23:30 on 30 Nov in New York is already December in UTC.
    expect(parseLedgerMonth(undefined, new Date("2026-12-01T04:30:00Z"))).toBe("2026-12");
  });

  it("runs from the first of the month to the first of the next, in UTC, across a year end", () => {
    expect(ledgerMonth("2026-12")).toEqual({
      key: "2026-12",
      label: "December 2026",
      startsAt: new Date("2026-12-01T00:00:00Z"),
      endsAt: new Date("2027-01-01T00:00:00Z"),
    });
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("ledger page", () => {
  it("shows 100 rows a page and keeps a bad or out-of-range page inside the ledger", () => {
    expect(ledgerPage(250, undefined)).toEqual({ number: 1, count: 3, from: 0, to: 100 });
    expect(ledgerPage(250, "3")).toEqual({ number: 3, count: 3, from: 200, to: 250 });
    for (const bad of ["0", "-1", "1.5", "2x", "9"]) expect(ledgerPage(250, bad).number).toBe(bad === "9" ? 3 : 1);
    expect(ledgerPage(0, "2")).toEqual({ number: 1, count: 1, from: 0, to: 0 });
  });
});

describe("fee ledger CSV", () => {
  const order = {
    storeId: "s1", storeName: "=Mama Africa, Inc", orderNumber: 7, fulfillment: "courier",
    capturedAmountCents: 7079, platformFeeCents: 384, serviceFeeCents: 180, deliveryFeeCents: 899,
  };
  const capture: CaptureFacts = { ...order, orderId: "o1", at: new Date("2026-11-03T15:00:00Z"), refundFailed: false };
  const cancel: RefundFacts = {
    ...order, orderId: "o1", refundId: "r1", amountCents: 7079, refundApplicationFee: true, serviceFeeShareCents: 0,
    feeShareReturned: false, createdAt: new Date("2026-11-04T10:00:00Z"), succeededAt: new Date("2026-11-04T10:00:00Z"),
  };

  it("has one line per screen row, then each store's total and the month's, in dollars", () => {
    const csv = feeLedgerCsv(buildFeeLedger(ledgerMonth("2026-11"), [capture], [cancel], []));
    expect(csv.split("\r\n")).toEqual([
      "Month (UTC),Date (UTC),Store,Order,Row,Captured,Service fee,Courier fee passed through,Card fee share (platform),Application fee,Fee refunded,Platform net",
      `2026-11,2026-11-03,"'=Mama Africa, Inc",#7,Order,70.79,1.80,8.99,0.31,12.83,0.00,1.49`,
      `2026-11,2026-11-04,"'=Mama Africa, Inc",#7,Refund,-70.79,0.00,-8.99,0.00,0.00,-12.83,-3.84`,
      `2026-11,,"'=Mama Africa, Inc",,Store total (1 order),0.00,1.80,0.00,0.31,12.83,-12.83,-2.35`,
      "2026-11,,All stores,,Month total (1 order),0.00,1.80,0.00,0.31,12.83,-12.83,-2.35",
      "",
    ]);
  });
});
