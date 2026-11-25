import { describe, expect, it } from "vitest";
import { deliveryFee, deliveryLine, splitByDelivery } from "./delivery-line";

const store = (over: Partial<Parameters<typeof deliveryLine>[0]> = {}) => ({
  storeDeliveryEnabled: false,
  courierMayDeliver: false,
  ...over,
});

describe("deliveryLine", () => {
  it("says the store delivers to you when the shopper's point is inside its own radius", () => {
    expect(deliveryLine(store({ storeDeliveryEnabled: true, deliversToYou: true, courierMayDeliver: true }))).toBe("Delivers to you");
  });

  it("with no shopper point (state and city pages), says only that the store delivers", () => {
    expect(deliveryLine(store({ storeDeliveryEnabled: true }))).toBe("Delivery");
    expect(deliveryLine(store({ storeDeliveryEnabled: true, courierMayDeliver: true }))).toBe("Delivery");
  });

  it("never promises its own delivery outside the radius; a courier is only a maybe", () => {
    expect(deliveryLine(store({ storeDeliveryEnabled: true, deliversToYou: false }))).toBeNull();
    expect(deliveryLine(store({ storeDeliveryEnabled: true, deliversToYou: false, courierMayDeliver: true }))).toBe("Courier may be available");
    expect(deliveryLine(store({ courierMayDeliver: true }))).toBe("Courier may be available");
  });

  it("is nothing for a pickup-only store", () => {
    expect(deliveryLine(store())).toBeNull();
    expect(deliveryLine(store({ deliversToYou: false }))).toBeNull();
  });
});

describe("deliveryFee (#863: a fee only where the store has a real one)", () => {
  it("prices the store's own delivery where it reaches the shopper or no point was given", () => {
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: true, storeDeliveryFeeCents: 499 })).toBe("$4.99 delivery");
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: true, deliversToYou: true, storeDeliveryFeeCents: 1250 })).toBe("$12.50 delivery");
  });

  it("shows no fee for a zero or unknown fee, outside the radius, or for a courier (its fee is a quote)", () => {
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: true, storeDeliveryFeeCents: 0 })).toBeNull();
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: true, storeDeliveryFeeCents: null })).toBeNull();
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: true, deliversToYou: false, storeDeliveryFeeCents: 499 })).toBeNull();
    expect(deliveryFee({ courierMayDeliver: false, storeDeliveryEnabled: false, storeDeliveryFeeCents: 499 })).toBeNull();
  });
});

describe("splitByDelivery (#863)", () => {
  const near = (slug: string, deliversToYou: boolean, pickupEnabled: boolean) => ({ slug, deliversToYou, pickupEnabled });

  it("puts stores whose own delivery reaches the shopper first, pickup stores next, nearest order kept", () => {
    const split = splitByDelivery([near("a", false, true), near("b", true, false), near("c", false, true), near("d", true, true)]);
    expect(split.door.map((s) => s.slug)).toEqual(["b", "d"]);
    expect(split.pickup.map((s) => s.slug)).toEqual(["a", "c"]);
    expect(split.other).toEqual([]);
  });

  it("never lists a store under pickup when it offers no pickup", () => {
    const split = splitByDelivery([near("courier-only", false, false)]);
    expect(split.pickup).toEqual([]);
    expect(split.other.map((s) => s.slug)).toEqual(["courier-only"]);
  });
});
