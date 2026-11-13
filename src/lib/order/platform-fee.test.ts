import { describe, expect, it } from "vitest";
import { captureSplit, maxGoodsWithin, serviceFeeCents } from "./platform-fee";

const ADR_0021 = { rateBps: 300, minCents: 99, maxCents: 299 };

describe("service fee (ADR-0021)", () => {
  it("is 3% of goods, held to the $0.99 minimum and the $2.99 maximum", () => {
    expect(serviceFeeCents(6000, ADR_0021)).toBe(180);
    expect(serviceFeeCents(2000, ADR_0021)).toBe(99);
    expect(serviceFeeCents(15000, ADR_0021)).toBe(299);
  });

  it("rounds half a cent up", () => {
    // 3% of $41.50 is 124.5¢.
    expect(serviceFeeCents(4150, ADR_0021)).toBe(125);
  });

  it("is zero when no goods are charged or the order predates the fee", () => {
    expect(serviceFeeCents(0, ADR_0021)).toBe(0);
    expect(serviceFeeCents(6000, { rateBps: 0, minCents: 0, maxCents: 0 })).toBe(0);
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
