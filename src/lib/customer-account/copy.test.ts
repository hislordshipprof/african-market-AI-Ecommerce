import { describe, expect, it } from "vitest";
import { contactPrefillNote } from "./copy";

describe("contactPrefillNote (#750)", () => {
  it("names only the fields the account filled", () => {
    expect(contactPrefillNote({ name: "", phone: "", email: "ada@example.com" })).toBe(
      "We filled your email from your account. Edits apply to this order only.",
    );
    expect(contactPrefillNote({ name: "Ada", phone: "", email: "ada@example.com" })).toBe(
      "We filled your name and email from your account. Edits apply to this order only.",
    );
    expect(contactPrefillNote({ name: "Ada", phone: "2025550100", email: "ada@example.com" })).toBe(
      "We filled your name, phone number and email from your account. Edits apply to this order only.",
    );
  });

  it("claims nothing was filled for a guest or an account with no details", () => {
    const guest = "Guest checkout. A phone number helps your shopper reach you about substitutions.";
    expect(contactPrefillNote(null)).toBe(guest);
    expect(contactPrefillNote({ name: " ", phone: "", email: "" })).toBe(
      "A phone number helps your shopper reach you about substitutions.",
    );
  });
});
