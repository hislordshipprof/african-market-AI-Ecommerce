import { describe, expect, it } from "vitest";
import {
  basketBlockingProblems,
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
