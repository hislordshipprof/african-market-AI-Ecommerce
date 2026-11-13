import { describe, expect, it } from "vitest";
import { captureSplit, maxGoodsWithin, NO_SERVICE_FEE, serviceFeeCents, serviceFeeRefundCents, serviceFeeShareOfRefund } from "./platform-fee";

const ADR_0021 = { rateBps: 300, minCents: 99, maxCents: 299 };

describe("service fee (ADR-0021)", () => {
  it("is 3% of goods, held to the $0.99 minimum and the $2.99 maximum", () => {
    expect(serviceFeeCents(6000, ADR_0021)).toBe(180);
    expect(serviceFeeCents(2000, ADR_0021)).toBe(99);
    expect(serviceFeeCents(15000, ADR_0021)).toBe(299);
    // 3% of $41.50 is 124.5¢, rounded half up.
    expect(serviceFeeCents(4150, ADR_0021)).toBe(125);
    expect(serviceFeeCents(0, ADR_0021)).toBe(0);
    expect(serviceFeeCents(6000, NO_SERVICE_FEE)).toBe(0);
  });
});

describe("service fee part of an issue refund", () => {
  // $66 of goods with a $1.98 fee and $8.99 courier.
  const order = { serviceFeeCents: 198, capturedAmountCents: 6600 + 198 + 899, tipCents: 0, deliveryFeeCents: 899 };

  it("is the fee share of the goods the refund covers, also for an amount the store lowered", () => {
    expect(serviceFeeRefundCents(2100, order)).toBe(63);
    expect(serviceFeeShareOfRefund(2163, order)).toBe(63);
    // $10 approved by the store: $9.71 of goods plus their 29¢ share.
    expect(serviceFeeShareOfRefund(1000, order)).toBe(29);
    expect(serviceFeeShareOfRefund(6600 + 198, order)).toBe(198);
    expect(serviceFeeShareOfRefund(2163, { ...order, serviceFeeCents: 0, capturedAmountCents: 7499 })).toBe(0);
  });
});

describe("capture split (ADR-0021 example order)", () => {
  it("$60 goods + $8.99 courier: customer pays $70.79, store receives $57.96, platform keeps $1.49", () => {
    const split = captureSplit({ capturedCents: 7079, serviceFeeCents: 180, courierFeeCents: 899 });
    expect(split.storeReceivesCents).toBe(5796);
    expect(split.platformKeepsCents).toBe(149);
    expect(split.storeCardFeeCents).toBe(204);
    expect(split.platformCardFeeCents).toBe(31);
    expect(split.applicationFeeCents).toBe(7079 - 5796);
  });

  it("store delivery and tip stay with the store, which bears their card fee", () => {
    // $60 goods + $1.80 fee + $5 store delivery + $3 tip = $69.80; store part $68.
    const split = captureSplit({ capturedCents: 6980, serviceFeeCents: 180, courierFeeCents: 0 });
    expect(split.storeCardFeeCents).toBe(227);
    expect(split.storeReceivesCents).toBe(6800 - 227);
    expect(split.applicationFeeCents).toBe(180 + 227);
  });

  it("never takes more than the capture and nothing from a zero capture", () => {
    expect(captureSplit({ capturedCents: 50, serviceFeeCents: 0, courierFeeCents: 40 }).applicationFeeCents).toBe(50);
    expect(captureSplit({ capturedCents: 0, serviceFeeCents: 0, courierFeeCents: 899 }).applicationFeeCents).toBe(0);
  });
});

describe("goods that fit a hold", () => {
  it("is the most goods whose total with the fee stays within the budget", () => {
    // 5000 + 150 = 5150 fits; 5001 + 150 = 5151 does not.
    expect(maxGoodsWithin(5150, ADR_0021)).toBe(5000);
    expect(maxGoodsWithin(5149, ADR_0021)).toBe(4999);
    expect(maxGoodsWithin(0, ADR_0021)).toBe(0);
  });
});
