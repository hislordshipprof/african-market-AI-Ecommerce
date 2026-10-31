import { describe, it, expect } from "vitest";
import { checkCheckoutReady } from "./checkout-gate";

describe("checkCheckoutReady (checkout gate)", () => {
  it("returns enabled for complete status", () => {
    const result = checkCheckoutReady("complete");
    expect(result.enabled).toBe(true);
    expect(result.message).toBeNull();
  });

  it("returns disabled for not_started status", () => {
    const result = checkCheckoutReady("not_started");
    expect(result.enabled).toBe(false);
    expect(result.message).toBe(
      "This store is not yet accepting online orders",
    );
  });

  it("returns disabled for pending status", () => {
    const result = checkCheckoutReady("pending");
    expect(result.enabled).toBe(false);
    expect(result.message).toBe(
      "This store is not yet accepting online orders",
    );
  });

  it("returns disabled for restricted status", () => {
    const result = checkCheckoutReady("restricted");
    expect(result.enabled).toBe(false);
    expect(result.message).toBe(
      "This store is not yet accepting online orders",
    );
  });
});
