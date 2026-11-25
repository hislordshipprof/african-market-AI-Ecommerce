import { describe, expect, it } from "vitest";
import {
  basketBlockingProblems,
  checkoutBasketBlock,
  contactErrors,
  firstInvalidContactField,
  issueFromError,
  issueFromProblems,
} from "./checkout-issue";

const GARRI = JSON.stringify(["listing-garri", "variant-1kg"]);

describe("checkout issue placement (#708, #717 AC3)", () => {
  it("puts an unavailable item in the basket section with the affected line", () => {
    const issue = issueFromProblems([
      { code: "invalid-contact", message: "Name, email, and a valid phone number are required." },
      { code: "out-of-stock", message: "Yellow Garri is unavailable.", lineKey: GARRI },
    ]);
    expect(issue).toEqual({
      section: "basket",
      message: "Yellow Garri is unavailable.",
      lineKeys: [GARRI],
    });
  });

  it("puts an address outside the radius beside the address, not in the summary", () => {
    expect(issueFromProblems([{ code: "outside-radius", message: "Outside the 8 mile delivery area." }])?.section).toBe("address");
  });

  it("#763 AC2: items that can't ship get their own section naming them, not the address one", () => {
    const GOAT = JSON.stringify(["listing-goat", "variant-2lb"]);
    const issue = issueFromProblems([
      { code: "cannot-ship", message: "Yellow Garri can't ship.", lineKey: GARRI },
      { code: "cannot-ship", message: "Goat Meat can't ship.", lineKey: GOAT },
    ]);
    expect(issue).toEqual({ section: "shipping", message: "Yellow Garri can't ship. Goat Meat can't ship.", lineKeys: [GARRI, GOAT] });
  });

  it("returns nothing when only contact problems remain (the fields show those)", () => {
    expect(issueFromProblems([{ code: "invalid-contact", message: "Required." }])).toBeNull();
  });

  it("reads the failure code a step attached, never the message text", () => {
    const declined = Object.assign(new Error("Test payment declined."), { code: "payment-failed" });
    const expired = Object.assign(new Error("Checkout session expired. Please quote again."), { code: "session-expired" });
    expect(issueFromError(declined).section).toBe("payment");
    expect(issueFromError(expired).section).toBe("session");
    // Same words, no code: stays general rather than guessing from text.
    expect(issueFromError(new Error("Checkout session expired.")).section).toBe("general");
  });

  it("blocks Pay only on basket problems, not on contact or address ones", () => {
    const blocking = basketBlockingProblems([
      { code: "invalid-contact", message: "Required." },
      { code: "minimum-order", message: "Minimum order is $35." },
      { code: "ineligible", message: "We couldn't find that address" },
      { code: "max-quantity", message: "Maximum 2 per order for this item." },
    ]);
    expect(blocking.map((problem) => problem.code)).toEqual(["minimum-order", "max-quantity"]);
  });
});

describe("contact validation and first invalid field (#708 AC3)", () => {
  it("flags all three empty fields and focuses the name first", () => {
    const empty = { name: "", phone: "", email: "" };
    expect(Object.keys(contactErrors(empty))).toEqual(["name", "phone", "email"]);
    expect(firstInvalidContactField(empty)).toBe("name");
  });

  it("moves to the phone when the name is filled but the phone is short", () => {
    expect(firstInvalidContactField({ name: "Ada", phone: "555-0199", email: "ada@example.com" })).toBe("phone");
  });

  it("has no invalid field for a complete contact", () => {
    const contact = { name: "Ada Obi", phone: "(202) 555-0199", email: "ada@example.com" };
    expect(contactErrors(contact)).toEqual({});
    expect(firstInvalidContactField(contact)).toBeNull();
  });
});

describe("what blocks Pay in checkout (#708 P1)", () => {
  const line = { listingId: "listing-garri", variantId: "variant-1kg", name: "Yellow Garri", price: 4000, quantity: 1 };
  const yam = { listingId: "listing-yam", name: "Yam", price: 900, quantity: 1 };

  it("a line the basket knows is unavailable blocks Pay before any quote arrives", () => {
    const block = checkoutBasketBlock(null, [{ ...line, available: false }, yam]);
    expect(block?.section).toBe("basket");
    expect(block?.lineKeys).toEqual([GARRI]);
    expect(block?.message).toBeTruthy();
  });

  it("a line over its per-order limit blocks Pay too", () => {
    expect(checkoutBasketBlock([], [{ ...line, quantity: 3, maxPerOrder: 2 }])?.lineKeys).toEqual([GARRI]);
  });

  it("two packs of one listing over its stock left block Pay (#808)", () => {
    const single = { ...line, variantId: "variant-single", quantity: 2, stockLeft: 4 };
    expect(checkoutBasketBlock([], [{ ...line, quantity: 3, stockLeft: 4 }, single])?.lineKeys).toHaveLength(2);
  });

  it("a basket problem from the quote still blocks, with the server's reason and the known lines", () => {
    const block = checkoutBasketBlock(
      [{ code: "minimum-order", message: "Minimum order is $50." }],
      [{ ...line, available: false }],
    );
    expect(block).toEqual({ section: "basket", message: "Minimum order is $50.", lineKeys: [GARRI] });
  });

  it("nothing blocks a sellable basket, whatever the contact fields say", () => {
    expect(checkoutBasketBlock([{ code: "invalid-contact", message: "Required." }], [line, yam])).toBeNull();
    expect(checkoutBasketBlock(null, [{ ...line, available: true, maxPerOrder: 1 }])).toBeNull();
  });
});
