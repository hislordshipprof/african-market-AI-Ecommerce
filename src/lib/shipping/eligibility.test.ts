import { describe, expect, it } from "vitest";
import { shipRefusal, shipsToLabel, storeShipsTo } from "./eligibility";

const lines = [{ ships: true, weightG: 900, qty: 1 }];

describe("where a store ships (#750)", () => {
  it("ships to the platform's states only when the store set handling days", () => {
    expect(storeShipsTo(2, ["VA", "MD"])).toEqual(["MD", "VA"]);
    expect(storeShipsTo(null, ["MD"])).toEqual([]);
  });

  it("offers no shipping while the platform ships to no state", () => {
    expect(storeShipsTo(2, [])).toEqual([]);
  });

  it("names the states in words before any address is typed", () => {
    expect(shipsToLabel(["MD"])).toBe("Ships to Maryland");
    expect(shipsToLabel(["MD", "VA"])).toBe("Ships to Maryland and Virginia");
    expect(shipsToLabel(["DC", "MD", "VA"])).toBe("Ships to District of Columbia, Maryland and Virginia");
  });

  it("refuses to quote a shipment while the platform ships to no state", () => {
    expect(shipRefusal({ lines, handlingDays: 2, state: null, allowedStates: [] })).toBe("We don't ship to any state yet.");
    expect(shipRefusal({ lines, handlingDays: 2, state: null, allowedStates: ["MD"] })).toBeNull();
  });
});
