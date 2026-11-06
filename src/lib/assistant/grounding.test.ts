import { describe, expect, it } from "vitest";
import { collectAllowedCents, groundAmounts } from "./grounding";

const allowed = new Set([450, 1299]);
const PHRASE = "I couldn't confirm that price.";

describe("price grounding", () => {
  it("keeps amounts a tool returned", () => {
    expect(groundAmounts("Egusi is $4.50 and ogiri $12.99", allowed).text).toBe(
      "Egusi is $4.50 and ogiri $12.99",
    );
    expect(groundAmounts("$4.5", allowed).stripped).toEqual([]);
    expect(groundAmounts("US$12.99", allowed).text).toBe("US$12.99");
  });

  it("replaces a sentence that contains an unverified amount", () => {
    expect(groundAmounts("Egusi is $4.50, was $5.00", allowed).text).toBe(PHRASE);
    expect(groundAmounts("Egusi is $4.50, was $5.00", allowed).stripped).toEqual(["$5.00"]);
  });

  it("converts formats to cents", () => {
    expect(groundAmounts("$4.50", allowed).stripped).toEqual([]);
    expect(groundAmounts("$1,234", new Set([123400])).text).toBe("$1,234");
    expect(groundAmounts("$1,299.00", allowed).text).toBe(PHRASE);
    expect(groundAmounts("$21.9", new Set([2190])).text).toBe("$21.9");
    expect(groundAmounts("$22", new Set([2200])).text).toBe("$22");
    expect(groundAmounts("$1,234.56", new Set([123456])).text).toBe("$1,234.56");
  });

  it("strips 3-decimal amounts", () => {
    const grounded = groundAmounts("$4.505", allowed);
    expect(grounded.text).toBe(PHRASE);
    expect(grounded.stripped).toEqual(["$4.505"]);
    expect(grounded.text).not.toContain("4.50");
  });

  it("strips a zero price unless a tool returned zero cents", () => {
    expect(groundAmounts("$0", new Set()).text).toBe(PHRASE);
    expect(groundAmounts("$0.00", new Set()).text).toBe(PHRASE);
    expect(groundAmounts("$0 and $0.00", new Set([0])).text).toBe("$0 and $0.00");
  });

  it("leaves empty text and text without a dollar unchanged", () => {
    expect(groundAmounts("", allowed)).toEqual({ text: "", stripped: [] });
    expect(groundAmounts("no price here", allowed)).toEqual({ text: "no price here", stripped: [] });
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

  it("other currency formats are caught and a removed price reads naturally", () => {
    const usd = new Set([1099]);
    expect(groundAmounts("USD 10.99", usd).text).toBe("USD 10.99");
    expect(groundAmounts("10.99 USD", usd).text).toBe("10.99 USD");
    expect(groundAmounts("10.99 dollars", usd).text).toBe("10.99 dollars");
    expect(groundAmounts("99¢", new Set([99])).text).toBe("99¢");
    expect(groundAmounts("99 cents", new Set([99])).text).toBe("99 cents");

    expect(groundAmounts("USD 7.77", usd).text).toBe(PHRASE);
    expect(groundAmounts("€10.99", usd).text).toBe(PHRASE);
    expect(groundAmounts("₦4,500", usd).text).toBe(PHRASE);
    expect(groundAmounts("99¢", usd).text).toBe(PHRASE);

    const foreign = groundAmounts("CAD $10.99", usd);
    expect(foreign.text).toBe(PHRASE);
    expect(foreign.stripped).toEqual(["CAD $10.99"]);
    expect(foreign.text).not.toContain("10.99");
    expect(groundAmounts("EUR 10.99", usd).stripped).toEqual(["EUR 10.99"]);
    expect(groundAmounts("10.99 EUR", usd).stripped).toEqual(["10.99 EUR"]);

    const bare = "2 tins, 8 oz, 9:00 PM, 22:00-02:00, exp 12/30";
    expect(groundAmounts(bare, usd)).toEqual({ text: bare, stripped: [] });

    expect(groundAmounts("Egusi is $7.77 today.", new Set()).text).toBe(PHRASE);
    expect(groundAmounts("- Tomato Paste, 70 g tin: $7.77", new Set()).text).toBe(
      "- Tomato Paste, 70 g tin: price not confirmed",
    );
    expect(groundAmounts("1. Tomato Paste: $7.77", new Set()).text).toBe(
      "1. Tomato Paste: price not confirmed",
    );
    expect(groundAmounts("  12. Palm oil: $7.77", new Set()).text).toBe(
      "  12. Palm oil: price not confirmed",
    );

    const both = groundAmounts("Egusi is $7.77 and $8.88 today.", new Set());
    expect(both.text).toBe(PHRASE);
    expect(both.stripped).toEqual(["$7.77", "$8.88"]);

    expect(groundAmounts("Egusi is $10.99. It was $7.77.", usd).text).toBe(
      `Egusi is $10.99. ${PHRASE}`,
    );
    expect(groundAmounts("Bad $1.00. Also bad $2.00.", new Set()).text).toBe(PHRASE);
    expect(groundAmounts("Ask Dr. Smith, egusi is $7.77.", new Set()).text).toBe(PHRASE);
    expect(groundAmounts("The price is $10.99.", usd).text).toBe("The price is $10.99.");
    expect(groundAmounts(bare, new Set()).text).not.toContain("(see card)");
    expect(groundAmounts("Egusi is $7.77 today.", new Set()).text).not.toContain("(see card)");
  });
});
