import { describe, expect, it } from "vitest";
import { validateAddress } from "./address-validation";

const valid = {
  label: "Home",
  line1: "1 Market Street",
  line2: "",
  city: "Honolulu",
  state: "hi",
  zip: "96813-1234",
  notes: "  gate code 12  ",
};

describe("address validator", () => {
  it("address validator accepts max and rejects max + 1 for every field, normalises state and trims", () => {
    const parsed = validateAddress(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.state).toBe("HI");
    expect(parsed.value.line2).toBeNull();
    expect(parsed.value.notes).toBe("gate code 12");
    expect(parsed.value.zip).toBe("96813-1234");

    const max = validateAddress({
      label: "a".repeat(40),
      line1: "b".repeat(100),
      line2: "c".repeat(100),
      city: "d".repeat(60),
      state: "DC",
      zip: "12345",
      notes: "e".repeat(280),
    });
    expect(max.ok).toBe(true);

    expect(validateAddress({ ...valid, label: "a".repeat(41) }).ok).toBe(false);
    expect(validateAddress({ ...valid, label: "   " }).ok).toBe(false);
    expect(validateAddress({ ...valid, line1: "b".repeat(101) }).ok).toBe(false);
    expect(validateAddress({ ...valid, line2: "c".repeat(101) }).ok).toBe(false);
    expect(validateAddress({ ...valid, city: "d".repeat(61) }).ok).toBe(false);
    expect(validateAddress({ ...valid, notes: "e".repeat(281) }).ok).toBe(false);
    expect(validateAddress({ ...valid, state: "ZZ" }).ok).toBe(false);
    expect(validateAddress({ ...valid, zip: "1234" }).ok).toBe(false);
    expect(validateAddress({ ...valid, label: "<script>" }).ok).toBe(true);
  });
});
