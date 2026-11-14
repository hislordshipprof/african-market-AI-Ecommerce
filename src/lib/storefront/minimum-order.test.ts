import { describe, expect, it } from "vitest";
import { minimumOrderGate } from "./minimum-order";

describe("minimumOrderGate", () => {
  it("blocks checkout under the store's minimum and says how much is left", () => {
    const gate = minimumOrderGate(699, 3500);
    expect(gate.met).toBe(false);
    expect(gate.message).toBe("$28.01 more to reach the $35.00 minimum");
  });

  it("uses the store's own minimum, not a fixed one", () => {
    expect(minimumOrderGate(1000, 2000).message).toBe("$10.00 more to reach the $20.00 minimum");
  });

  it("opens checkout exactly at the minimum", () => {
    const gate = minimumOrderGate(3500, 3500);
    expect(gate.met).toBe(true);
    expect(gate.message).toBeNull();
  });

  it("treats a store with no minimum as always met", () => {
    expect(minimumOrderGate(1, 0)).toEqual({ met: true, message: null });
    expect(minimumOrderGate(1, -500)).toEqual({ met: true, message: null });
  });
});
