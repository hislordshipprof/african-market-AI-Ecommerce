import { describe, expect, it } from "vitest";
import { payButtonLabel } from "./feedback";

describe("pay button wording (real vs demo) (#708 AC2a)", () => {
  it("real checkout never shows demo wording", () => {
    expect(payButtonLabel("idle", true, "Pay $52.00")).toBe("Pay $52.00");
    expect(payButtonLabel("pending", true, "Pay $52.00")).toBe("Authorizing payment…");
    expect(payButtonLabel("success", true, "Pay $52.00")).toBe("Order placed");
  });

  it("demo checkout keeps demo wording", () => {
    expect(payButtonLabel("idle", false, "Place demo order · $52.00")).toBe(
      "Place demo order · $52.00",
    );
    expect(payButtonLabel("pending", false, "Place demo order · $52.00")).toBe(
      "Authorizing test hold…",
    );
    expect(payButtonLabel("success", false, "Place demo order · $52.00")).toBe(
      "Demo order placed",
    );
  });
});
