import { describe, expect, it } from "vitest";
import { collectAllowedCents, groundAmounts } from "./grounding";

const allowed = new Set([450, 1299]);

describe("price grounding", () => {
  it("keeps amounts a tool returned", () => {
    expect(groundAmounts("Egusi is $4.50 and ogiri $12.99", allowed).text).toBe(
      "Egusi is $4.50 and ogiri $12.99",
    );
    expect(groundAmounts("$4.5", allowed).stripped).toEqual([]);
    expect(groundAmounts("US$12.99", allowed).text).toBe("US$12.99");
  });

  it("replaces other amounts with (see card)", () => {
    expect(groundAmounts("Egusi is $4.50, was $5.00", allowed).text).toBe(
      "Egusi is $4.50, was (see card)",
    );
  });

  it("converts formats to cents", () => {
    expect(groundAmounts("$4.50", allowed).stripped).toEqual([]);
    expect(groundAmounts("$1,234", new Set([123400])).text).toBe("$1,234");
    expect(groundAmounts("$1,299.00", allowed).text).toBe("(see card)");
  });

  it("strips 3-decimal amounts", () => {
    expect(groundAmounts("$4.505", allowed).text).toBe("(see card)");
  });

  it("ignores amounts from earlier turns", () => {
    const thisTurn = collectAllowedCents({ priceCents: 450 });
    expect(groundAmounts("was $5.00 now $4.50", thisTurn).text).toBe("was (see card) now $4.50");
  });

  it("collects nested *Cents fields", () => {
    const cents = collectAllowedCents({
      items: [{ unitPriceCents: 199, lineTotalCents: 597, name: "rice" }],
      minimumOrderCents: 2000,
      note: "notCents",
      skipped: { cents: 12 },
    });
    expect([...cents].sort((a, b) => a - b)).toEqual([199, 597, 2000]);
  });
});
