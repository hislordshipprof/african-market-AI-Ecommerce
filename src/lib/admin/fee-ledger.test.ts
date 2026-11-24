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
    capturedAmountCents: 7079, platformFeeCents: 384, serviceFeeCents: 180, deliveryFeeCents: 899, taxCents: 0, taxLiableParty: "platform",
  };
  const capture: CaptureFacts = { ...order, orderId: "o1", at: new Date("2026-11-03T15:00:00Z"), refundFailed: false };
  const cancel: RefundFacts = {
    ...order, orderId: "o1", refundId: "r1", amountCents: 7079, refundApplicationFee: true, serviceFeeShareCents: 0,
    platformTaxShareCents: 0, feeShareReturned: false, createdAt: new Date("2026-11-04T10:00:00Z"), succeededAt: new Date("2026-11-04T10:00:00Z"),
  };

  it("has one line per screen row, then each store's total and the month's, in dollars", () => {
    const csv = feeLedgerCsv(buildFeeLedger(ledgerMonth("2026-11"), [capture], [cancel], []));
    expect(csv.split("\r\n")).toEqual([
      "Month (UTC),Date (UTC),Store,Order,Row,Captured,Service fee,Courier fee or postage passed through,Card fee share (platform),Postage absorbed,Application fee,Fee refunded,Platform net",
      `2026-11,2026-11-03,"'=Mama Africa, Inc",#7,Order,70.79,1.80,8.99,0.31,0.00,12.83,0.00,1.49`,
      `2026-11,2026-11-04,"'=Mama Africa, Inc",#7,Refund,-70.79,0.00,-8.99,0.00,0.00,0.00,-12.83,-3.84`,
      `2026-11,,"'=Mama Africa, Inc",,Store total (1 order),0.00,1.80,0.00,0.31,0.00,12.83,-12.83,-2.35`,
      "2026-11,,All stores,,Month total (1 order),0.00,1.80,0.00,0.31,0.00,12.83,-12.83,-2.35",
      "",
    ]);
  });
});

describe("fee ledger with sales tax (#65)", () => {
  const order = {
    storeId: "s1", storeName: "Ada's Market", orderNumber: 9, fulfillment: "pickup",
    platformFeeCents: null, serviceFeeCents: 299, deliveryFeeCents: 0,
  };
  const at = new Date("2026-11-05T15:00:00Z");

  it("passes the tax the platform collects through, like the courier fee: only its card fee is the platform's cost", () => {
    const untaxed: CaptureFacts = { ...order, orderId: "o1", capturedAmountCents: 10_000, taxCents: 0, taxLiableParty: "platform", at, refundFailed: false };
    const taxed: CaptureFacts = { ...order, orderId: "o2", capturedAmountCents: 10_825, taxCents: 825, taxLiableParty: "platform", at, refundFailed: false };
    const [plain, withTax] = buildFeeLedger(ledgerMonth("2026-11"), [untaxed, taxed], [], []).rows;
    // $97.01 store part: card fee 281 + 30 = 311; fee 299 + 311 = 610; platform card fee 9 on the service fee.
    expect(plain).toMatchObject({ applicationFeeCents: 610, platformNetCents: 290 });
    // The tax's own card fee, 2.9% of 825 = 24, is all it costs the platform.
    expect(withTax).toMatchObject({ applicationFeeCents: 1435, platformCardFeeCents: 33, platformNetCents: 266 });

    const cancel: RefundFacts = {
      ...taxed, refundId: "r1", amountCents: 10_825, refundApplicationFee: true, serviceFeeShareCents: 0,
      platformTaxShareCents: 0, feeShareReturned: false, createdAt: at, succeededAt: at,
    };
    const refund = buildFeeLedger(ledgerMonth("2026-11"), [], [cancel], []).rows[0];
    // The tax goes back with the refund and was never the platform's: only the 610 fee leaves its net.
    expect(refund).toMatchObject({ feeRefundedCents: -1435, platformNetCents: -610 });
  });

  it("a courier refund's returned tax share passes back through: only its service fee share leaves the platform net (B5)", () => {
    // $20 goods + 60¢ fee + $1.65 platform tax + $8.99 courier; all the goods refunded, fee share and tax share returned.
    const courier = { ...order, fulfillment: "courier", deliveryFeeCents: 899, serviceFeeCents: 60, capturedAmountCents: 3124, taxCents: 165, taxLiableParty: "platform" };
    const refund: RefundFacts = {
      ...courier, orderId: "o3", refundId: "r3", amountCents: 2225, refundApplicationFee: false, serviceFeeShareCents: 60,
      platformTaxShareCents: 165, feeShareReturned: true, createdAt: at, succeededAt: at,
    };
    const [row] = buildFeeLedger(ledgerMonth("2026-11"), [], [refund], []).rows;
    expect(row).toMatchObject({ capturedCents: -2225, courierFeeCents: 0, feeRefundedCents: -225, platformNetCents: -60 });
  });
});
