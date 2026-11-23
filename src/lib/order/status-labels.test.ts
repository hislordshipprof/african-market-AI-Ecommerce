import { describe, expect, it } from "vitest";
import { orderStatusLabel } from "./status-labels";
import { fulfilledStatus } from "./constants";

describe("orderStatusLabel", () => {
  it("names a ready pickup order the same whether it is READY or waiting at the counter", () => {
    expect(orderStatusLabel("READY", "pickup")).toBe("Ready for pickup");
    expect(orderStatusLabel(fulfilledStatus("pickup"), "pickup")).toBe("Ready for pickup");
  });

  it("names a ready order by how it leaves the store", () => {
    expect(orderStatusLabel("READY", "store-delivery")).toBe("Ready for delivery");
    expect(orderStatusLabel("READY", "courier")).toBe("Ready for courier");
    expect(orderStatusLabel("READY", "ship")).toBe("Ready to ship");
  });

  it("still labels a status the map does not know", () => {
    expect(orderStatusLabel("SOMETHING_NEW", "pickup")).toBe("In progress");
  });
});
