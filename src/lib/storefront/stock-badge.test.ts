import { describe, it, expect } from "vitest";
import { listingAvailable, stockBadge, stockLeftLabel } from "./stock-badge";

describe("stockBadge", () => {
  it("returns in-stock for high confidence counted with qty", () => {
    expect(stockBadge({ confidence: 0.8, stockMode: "counted", qty: 10, status: null }))
      .toBe("in-stock");
  });

  it("returns limited for medium confidence counted with qty", () => {
    expect(stockBadge({ confidence: 0.4, stockMode: "counted", qty: 3, status: null }))
      .toBe("limited");
  });

  it("returns ask-store for low confidence counted with qty", () => {
    expect(stockBadge({ confidence: 0.1, stockMode: "counted", qty: 1, status: null }))
      .toBe("ask-store");
  });

  it("returns ask-store for hard-zero counted qty=0 even with high confidence", () => {
    expect(stockBadge({ confidence: 0.9, stockMode: "counted", qty: 0, status: null }))
      .toBe("ask-store");
  });

  it("returns ask-store for hard-zero status out_of_stock even with high confidence", () => {
    expect(stockBadge({ confidence: 0.8, stockMode: "status", qty: null, status: "out_of_stock" }))
      .toBe("ask-store");
  });

  it("returns limited for status mode with medium confidence and status=low", () => {
    expect(stockBadge({ confidence: 0.5, stockMode: "status", qty: null, status: "low" }))
      .toBe("limited");
  });

  it("returns in-stock for status mode with high confidence and status=in_stock", () => {
    expect(stockBadge({ confidence: 0.8, stockMode: "status", qty: null, status: "in_stock" }))
      .toBe("in-stock");
  });

  it("returns in-stock at exact 0.6 threshold", () => {
    expect(stockBadge({ confidence: 0.6, stockMode: "counted", qty: 5, status: null }))
      .toBe("in-stock");
  });

  it("returns limited at exact 0.3 threshold", () => {
    expect(stockBadge({ confidence: 0.3, stockMode: "counted", qty: 5, status: null }))
      .toBe("limited");
  });

  it("returns ask-store just below 0.3 threshold", () => {
    expect(stockBadge({ confidence: 0.29, stockMode: "counted", qty: 5, status: null }))
      .toBe("ask-store");
  });
});

const listing = { active: true, stockMode: "unlimited", qty: null, status: null };

describe("listing availability, shared by the basket page and cart lines (#717 AC2)", () => {
  it("sells an active listing with unlimited stock", () => {
    expect(listingAvailable(listing)).toBe(true);
  });

  it("stops selling a listing the store switched off", () => {
    expect(listingAvailable({ ...listing, active: false })).toBe(false);
  });

  it("stops selling counted stock at zero, and a status listing marked out of stock", () => {
    expect(listingAvailable({ ...listing, stockMode: "counted", qty: 0 })).toBe(false);
    expect(listingAvailable({ ...listing, stockMode: "counted", qty: 3 })).toBe(true);
    expect(listingAvailable({ ...listing, stockMode: "status", status: "out_of_stock" })).toBe(false);
  });
});

describe("stockLeftLabel (#808)", () => {
  it("says how many are left only when a counted listing is at or under the low-stock threshold", () => {
    expect(stockLeftLabel(4)).toBe("Only 4 left");
    expect(stockLeftLabel(5)).toBe("Only 5 left");
    expect(stockLeftLabel(6)).toBeNull();
    expect(stockLeftLabel(undefined)).toBeNull();
  });
});
