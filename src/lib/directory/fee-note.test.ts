import { describe, expect, it } from "vitest";
import { feeNote } from "./fee-note";

describe("feeNote (#863: the shopper fee note reads the platform's settings)", () => {
  it("states the service fee rate and its floor and cap", () => {
    expect(feeNote({ rateBps: 300, minCents: 99, maxCents: 299 })).toBe(
      "Prices are the market's own. A service fee of 3% of your goods, from $0.99 to $2.99, and any delivery fee show before you pay. Courier fees are the courier's quote, with no markup.",
    );
  });

  it("keeps a fractional rate", () => {
    expect(feeNote({ rateBps: 250, minCents: 50, maxCents: 400 })).toContain("2.5% of your goods, from $0.50 to $4.00");
  });

  it("names no service fee when the platform charges none", () => {
    const note = feeNote({ rateBps: 0, minCents: 0, maxCents: 0 });
    expect(note).not.toContain("service fee");
    expect(note).toContain("Any delivery fee shows before you pay.");
  });
});
