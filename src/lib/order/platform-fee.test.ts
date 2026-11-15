import { describe, expect, it } from "vitest";
import { ADR_0021_SERVICE_FEE, capturedApplicationFee, capturedPayout, captureSplit, maxGoodsWithin, NO_SERVICE_FEE, platformTaxCents, refundOfGoodsCents, refundShares, serviceFeeCents, serviceFeeRefundCents, taxRefundCents } from "./platform-fee";

describe("service fee (ADR-0021)", () => {
  it("is 3% of goods, held to the $0.99 minimum and the $2.99 maximum", () => {
    expect(serviceFeeCents(6000, ADR_0021_SERVICE_FEE)).toBe(180);
    expect(serviceFeeCents(2000, ADR_0021_SERVICE_FEE)).toBe(99);
    expect(serviceFeeCents(15000, ADR_0021_SERVICE_FEE)).toBe(299);
    // 3% of $41.50 is 124.5¢, rounded half up.
    expect(serviceFeeCents(4150, ADR_0021_SERVICE_FEE)).toBe(125);
    expect(serviceFeeCents(0, ADR_0021_SERVICE_FEE)).toBe(0);
    expect(serviceFeeCents(6000, NO_SERVICE_FEE)).toBe(0);
  });
});

describe("service fee part of an issue refund", () => {
  // $66 of goods with a $1.98 fee and $8.99 courier.
  const order = { serviceFeeCents: 198, capturedAmountCents: 6600 + 198 + 899, tipCents: 0, deliveryFeeCents: 899, taxCents: 0 };

  it("is the fee share of the goods the refund covers, also for an amount the store lowered", () => {
    expect(serviceFeeRefundCents(2100, order)).toBe(63);
    expect(refundShares(2163, order).serviceFeeCents).toBe(63);
    // $10 approved by the store: $9.71 of goods plus their 29¢ share.
    expect(refundShares(1000, order).serviceFeeCents).toBe(29);
    expect(refundShares(6600 + 198, order).serviceFeeCents).toBe(198);
    expect(refundShares(2163, { ...order, serviceFeeCents: 0, capturedAmountCents: 7499 }).serviceFeeCents).toBe(0);
  });
});

describe("tax part of a refund (#65, decision 2026-11-15-06)", () => {
  // $20 goods, 60¢ fee, $1.65 tax, $8.99 courier, $5 tip: only the goods carry the tax.
  const order = { serviceFeeCents: 60, capturedAmountCents: 2000 + 60 + 165 + 899 + 500, tipCents: 500, deliveryFeeCents: 899, taxCents: 165 };

  it("a goods refund adds the tax paid on those goods, in proportion, and tip, delivery and tax are not goods", () => {
    expect(refundOfGoodsCents(2000, order)).toBe(2000 + 60 + 165);
    expect(refundOfGoodsCents(1000, order)).toBe(1000 + 30 + 83);
    expect(serviceFeeRefundCents(1000, order)).toBe(30);
    expect(taxRefundCents(1000, order)).toBe(83);
  });

  it("an amount splits back into goods, fee share and tax share", () => {
    expect(refundShares(2225, order)).toEqual({ goodsCents: 2000, serviceFeeCents: 60, taxCents: 165 });
    expect(refundShares(1113, order)).toEqual({ goodsCents: 1000, serviceFeeCents: 30, taxCents: 83 });
    expect(refundShares(0, order)).toEqual({ goodsCents: 0, serviceFeeCents: 0, taxCents: 0 });
  });

  it("the tax shares of several refunds never add up to more than the order's tax", () => {
    // 1¢ of tax on $2 of goods: each $1 half rounds up to 1¢, but only one cent was paid.
    const odd = { serviceFeeCents: 0, capturedAmountCents: 201, tipCents: 0, deliveryFeeCents: 0, taxCents: 1 };
    expect(taxRefundCents(100, odd)).toBe(1);
    expect(taxRefundCents(100, odd, 1)).toBe(0);
    expect(refundShares(100, odd, 1)).toEqual({ goodsCents: 100, serviceFeeCents: 0, taxCents: 0 });
    // Once the whole tax is back, a later refund of goods carries only their fee share.
    expect(refundOfGoodsCents(100, order, 165)).toBe(100 + 3);
  });

  it("#671: a refund tied to lines returns those lines' exact tax, scaled only when the amount is lowered", () => {
    // $20 of exempt food and $10 of taxed goods with 83¢ tax and a $5 tip: the proportional rule would give the food 55¢.
    const mixed = { serviceFeeCents: 90, capturedAmountCents: 3000 + 90 + 83 + 500, tipCents: 500, deliveryFeeCents: 0, taxCents: 83 };
    const food = { goodsCents: 2000, taxCents: 0 };
    const taxed = { goodsCents: 1000, taxCents: 83 };
    expect(refundOfGoodsCents(2000, mixed, 0, food)).toBe(2000 + 60);
    expect(refundShares(2060, mixed, 0, food)).toEqual({ goodsCents: 2000, serviceFeeCents: 60, taxCents: 0 });
    expect(refundShares(1000 + 30 + 83, mixed, 0, taxed)).toEqual({ goodsCents: 1000, serviceFeeCents: 30, taxCents: 83 });
    // The store approves $5.65 of it: $5 of goods, 15¢ fee share, half the line's tax 41.5 → 42.
    expect(refundShares(557, mixed, 0, taxed)).toEqual({ goodsCents: 500, serviceFeeCents: 15, taxCents: 42 });
    // Never more than the tax earlier refunds left.
    expect(refundShares(1000 + 30 + 83, mixed, 80, taxed).taxCents).toBe(3);
  });

  it("an order placed before tax refunds no tax", () => {
    expect(taxRefundCents(1000, { ...order, taxCents: 0, capturedAmountCents: 2000 + 60 + 899 + 500 })).toBe(0);
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

describe("store payout shown in the inbox", () => {
  it("comes from the fee stored at capture, so a courier order captured before the service fee shows what Stripe paid", () => {
    const order = { capturedAmountCents: 7079, fulfillment: "courier", deliveryFeeCents: 899, taxCents: 0, taxLiableParty: "platform" };
    // Before #495 the stored fee was 2.9% + 30¢ of the whole capture: 235.
    expect(capturedPayout({ ...order, platformFeeCents: 235, serviceFeeCents: 0 })).toEqual({ storeCardFeeCents: 235, storeReceivesCents: 7079 - 235 - 899 });
    expect(capturedPayout({ ...order, platformFeeCents: 180 + 204, serviceFeeCents: 180 })).toEqual({ storeCardFeeCents: 204, storeReceivesCents: 5796 });
    expect(capturedPayout({ ...order, platformFeeCents: null, serviceFeeCents: 180 })).toEqual({ storeCardFeeCents: 204, storeReceivesCents: 5796 });
  });
});

describe("application fee shown to platform admins", () => {
  const courier = { capturedAmountCents: 7079, fulfillment: "courier", deliveryFeeCents: 899, serviceFeeCents: 180, taxCents: 0, taxLiableParty: "platform" };

  it("is the stored platform fee plus the courier fee, the amount Stripe took at capture", () => {
    expect(capturedApplicationFee({ ...courier, platformFeeCents: 180 + 204 })).toBe(180 + 204 + 899);
  });

  it("keeps store delivery's fee out: the store keeps it", () => {
    expect(capturedApplicationFee({ ...courier, fulfillment: "store-delivery", platformFeeCents: 180 + 227 })).toBe(407);
  });

  it("works out an order captured before the fee was stored", () => {
    expect(capturedApplicationFee({ ...courier, platformFeeCents: null })).toBe(7079 - 5796);
  });

  it("never exceeds the capture, and is unknown before capture", () => {
    expect(capturedApplicationFee({ ...courier, capturedAmountCents: 900, platformFeeCents: 180 + 30 })).toBe(900);
    expect(capturedApplicationFee({ ...courier, capturedAmountCents: null, platformFeeCents: null })).toBeNull();
  });
});

describe("goods that fit a hold", () => {
  it("is the most goods whose total with the fee stays within the budget", () => {
    // 5000 + 150 = 5150 fits; 5001 + 150 = 5151 does not.
    expect(maxGoodsWithin(5150, ADR_0021_SERVICE_FEE)).toBe(5000);
    expect(maxGoodsWithin(5149, ADR_0021_SERVICE_FEE)).toBe(4999);
    expect(maxGoodsWithin(0, ADR_0021_SERVICE_FEE)).toBe(0);
  });
});

describe("sales tax in the split (#65, ADR-0008)", () => {
  it("keeps platform-collected tax out of the store's transfer, and the platform bears its card fee", () => {
    const base = captureSplit({ capturedCents: 10_000, serviceFeeCents: 299, courierFeeCents: 0 });
    const taxed = captureSplit({ capturedCents: 10_825, serviceFeeCents: 299, courierFeeCents: 0, platformTaxCents: 825 });
    expect(taxed.storeReceivesCents).toBe(base.storeReceivesCents);
    expect(taxed.applicationFeeCents).toBe(base.applicationFeeCents + 825);
    expect(taxed.platformCardFeeCents).toBe(base.platformCardFeeCents + 24);
  });

  it("passes store-liable tax to the store", () => {
    expect(platformTaxCents({ taxCents: 825, taxLiableParty: "store" })).toBe(0);
    expect(platformTaxCents({ taxCents: 825, taxLiableParty: "platform" })).toBe(825);
    expect(capturedPayout({ capturedAmountCents: 10_825, platformFeeCents: 591, serviceFeeCents: 299, fulfillment: "pickup", deliveryFeeCents: 0, taxCents: 825, taxLiableParty: "platform" }).storeReceivesCents)
      .toBe(10_825 - 591 - 825);
  });
});
