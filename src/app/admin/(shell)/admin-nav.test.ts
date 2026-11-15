import { describe, expect, it } from "vitest";
import { currentNavHref } from "./admin-nav";

describe("currentNavHref", () => {
  it("marks the section a nested page belongs to, not a lookalike path", () => {
    expect(currentNavHref("/admin/stores/abc123")).toBe("/admin/stores");
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/store-requests")).toBe("/admin/store-requests");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
    expect(currentNavHref("/admin/catalog/products/abc123")).toBe("/admin/catalog/products");
    expect(currentNavHref("/admin/catalog/review")).toBe("/admin/catalog/review");
    expect(currentNavHref("/admin/ai/conversations/shopper/abc123")).toBe("/admin/ai/conversations");
    expect(currentNavHref("/admin/ai/eval-spend")).toBe("/admin/ai/eval-spend");
    expect(currentNavHref("/admin/billing/subscriptions")).toBe("/admin/billing/subscriptions");
  });
});
