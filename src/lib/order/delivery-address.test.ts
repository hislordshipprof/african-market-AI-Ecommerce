import { describe, expect, it } from "vitest";
import { deliveryDestination, formatDeliveryAddress } from "./delivery-address";

const address = { deliveryLine1: "12 Main St", deliveryLine2: null, deliveryCity: "Houston", deliveryState: "TX", deliveryZip: "77001" };

describe("deliveryDestination (#753)", () => {
  it("says where a store-delivery, courier or older delivery order is going", () => {
    for (const fulfillment of ["store-delivery", "courier", "delivery"]) {
      expect(deliveryDestination({ fulfillment, ...address })).toEqual({ label: "Delivering to", address: "12 Main St, Houston, TX 77001" });
    }
  });

  it("says Shipping to on a shipped order, with the second address line", () => {
    expect(deliveryDestination({ fulfillment: "ship", ...address, deliveryLine2: "Apt 4" }))
      .toEqual({ label: "Shipping to", address: "12 Main St, Apt 4, Houston, TX 77001" });
  });

  it("is null for pickup, or when no address was stored", () => {
    expect(deliveryDestination({ fulfillment: "pickup", ...address })).toBeNull();
    expect(deliveryDestination({ fulfillment: "store-delivery", ...address, deliveryLine1: null })).toBeNull();
  });

  it("formats the address the store inbox shows", () => {
    expect(formatDeliveryAddress({ ...address, deliveryCity: null })).toBe("12 Main St, TX 77001");
  });

  it("joins only the parts that were stored, never printing null (#751)", () => {
    expect(formatDeliveryAddress({ ...address, deliveryState: null, deliveryZip: null })).toBe("12 Main St, Houston");
    expect(formatDeliveryAddress({ ...address, deliveryLine1: null })).toBe("Houston, TX 77001");
    expect(formatDeliveryAddress({ deliveryLine1: null, deliveryLine2: null, deliveryCity: null, deliveryState: null, deliveryZip: null })).toBe("");
  });
});
