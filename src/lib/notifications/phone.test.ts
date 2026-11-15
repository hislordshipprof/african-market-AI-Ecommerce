import { describe, expect, it } from "vitest";
import { normalizeUsPhone } from "./phone";

describe("normalizeUsPhone", () => {
  it("treats a leading + as US only when it is 11 digits starting with 1", () => {
    expect(normalizeUsPhone("+220 770 1234")).toEqual({ ok: false, reason: "sms_non_us_number" });
    expect(normalizeUsPhone("+231 777 1234")).toEqual({ ok: false, reason: "sms_non_us_number" });
    expect(normalizeUsPhone("+65 8234 5678")).toEqual({ ok: false, reason: "sms_non_us_number" });
    expect(normalizeUsPhone("+45 32 45 67 89")).toEqual({ ok: false, reason: "sms_non_us_number" });
    expect(normalizeUsPhone("+1 301 448 2210")).toEqual({ ok: true, e164: "+13014482210" });
    expect(normalizeUsPhone("(301) 448-2210")).toEqual({ ok: true, e164: "+13014482210" });
    expect(normalizeUsPhone("13014482210")).toEqual({ ok: true, e164: "+13014482210" });
  });
});
