import { describe, expect, it } from "vitest";
import { ADMIN_NAV, currentNavHref } from "./admin-nav";

describe("currentNavHref", () => {
  it("marks the section a nested page belongs to, not a lookalike path", () => {
    expect(currentNavHref("/admin/stores/abc123")).toBe("/admin/stores");
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/store-requests")).toBe("/admin/store-requests");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
    expect(currentNavHref("/admin/catalog/products/abc123")).toBe("/admin/catalog/products");
    expect(currentNavHref("/admin/catalog/review")).toBe("/admin/catalog/review");
    expect(currentNavHref("/admin/catalog/categories/abc123")).toBe("/admin/catalog/categories");
    expect(currentNavHref("/admin/ai/conversations/shopper/abc123")).toBe("/admin/ai/conversations");
    expect(currentNavHref("/admin/ai/eval-spend")).toBe("/admin/ai/eval-spend");
    expect(currentNavHref("/admin/billing/subscriptions")).toBe("/admin/billing/subscriptions");
    expect(currentNavHref("/admin/settings/couriers")).toBe("/admin/settings/couriers");
    expect(currentNavHref("/admin/settings/ai-onboarding")).toBe("/admin/settings/ai-onboarding");
    expect(currentNavHref("/admin/settings")).toBe("/admin");
  });
});

describe("ADMIN_NAV", () => {
  it("carries label, href and icon in each entry, with no repeated href", () => {
    for (const entry of ADMIN_NAV) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.href).toMatch(/^\/admin/);
      expect(entry.icon).toBeDefined();
    }
    expect(new Set(ADMIN_NAV.map((entry) => entry.href)).size).toBe(ADMIN_NAV.length);
  });
});
