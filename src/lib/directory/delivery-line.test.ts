import { describe, expect, it } from "vitest";
import { deliveryLine } from "./delivery-line";

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
