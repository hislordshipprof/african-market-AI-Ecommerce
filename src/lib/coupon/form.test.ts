import { describe, expect, it } from "vitest";
import { parseCouponForm, storeLocalToUtc, utcToStoreLocal } from "./form";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  const base: Record<string, string> = { code: "save10", kind: "percent", percentOff: "10", startsAt: "2026-12-01T09:00" };
  for (const [k, v] of Object.entries({ ...base, ...fields })) data.set(k, v);
  return data;
}

describe("parseCouponForm", () => {
  it("upper-cases the code and reads start in store time", () => {
    const parsed = parseCouponForm(form({ code: "Save-10", minGoods: "25.50", totalUses: "100", usesPerCustomer: "1", firstOrderOnly: "on" }), "America/Chicago");
    expect(parsed).toEqual({
      ok: true,
      data: {
        code: "SAVE-10",
        kind: "percent",
        percentOff: 10,
        amountOffCents: null,
        minGoodsCents: 2550,
        startsAt: new Date("2026-12-01T15:00:00Z"),
        endsAt: null,
        totalUses: 100,
        usesPerCustomer: 1,
        firstOrderOnly: true,
      },
    });
  });

  it("takes a fixed amount in dollars between $1 and $100", () => {
    const ok = parseCouponForm(form({ kind: "fixed", percentOff: "", amountOff: "5" }), "America/New_York");
    expect(ok.ok && ok.data.amountOffCents).toBe(500);
    expect(ok.ok && ok.data.percentOff).toBe(null);
    expect(parseCouponForm(form({ kind: "fixed", amountOff: "0.99" }), "America/New_York").ok).toBe(false);
    expect(parseCouponForm(form({ kind: "fixed", amountOff: "100.01" }), "America/New_York").ok).toBe(false);
  });

  it("refuses a percent outside 1 to 90", () => {
    expect(parseCouponForm(form({ percentOff: "0" }), "America/New_York").ok).toBe(false);
    expect(parseCouponForm(form({ percentOff: "91" }), "America/New_York").ok).toBe(false);
    expect(parseCouponForm(form({ percentOff: "90" }), "America/New_York").ok).toBe(true);
  });

  it("refuses codes with other characters or the wrong length", () => {
    for (const code of ["AB", "A".repeat(21), "SAVE 10", "SAVE_10", "ÉTÉ10"]) {
      expect(parseCouponForm(form({ code }), "America/New_York").ok, code).toBe(false);
    }
    expect(parseCouponForm(form({ code: "A".repeat(20) }), "America/New_York").ok).toBe(true);
  });

  it("refuses an end that is not after the start", () => {
    const parsed = parseCouponForm(form({ endsAt: "2026-12-01T09:00" }), "America/New_York");
    expect(parsed).toEqual({ ok: false, error: "The end must be after the start." });
  });
});

describe("store time", () => {
  it("round-trips across a daylight-saving change", () => {
    expect(storeLocalToUtc("2026-07-04T12:00", "America/Los_Angeles")).toEqual(new Date("2026-07-04T19:00:00Z"));
    expect(storeLocalToUtc("2026-01-04T12:00", "America/Los_Angeles")).toEqual(new Date("2026-01-04T20:00:00Z"));
    expect(utcToStoreLocal(new Date("2026-07-04T19:00:00Z"), "America/Los_Angeles")).toBe("2026-07-04T12:00");
  });
});
