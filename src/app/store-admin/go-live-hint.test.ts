import { describe, expect, it } from "vitest";
import { testOrderHint } from "./go-live-hint";

describe("testOrderHint (#784)", () => {
  it("names the store's minimum order, so the test order can be placed", () => {
    const hint = testOrderHint(3500);
    expect(hint).toContain("$35.00");
    expect(hint).not.toMatch(/small order/);
  });

  it("follows the store's own minimum", () => {
    expect(testOrderHint(5000)).toContain("$50.00");
  });

  it("with no minimum, asks for any order", () => {
    const hint = testOrderHint(0);
    expect(hint).not.toContain("$");
    expect(hint).toMatch(/order/);
  });
});
