import { describe, expect, it } from "vitest";
import { ADMIN_NAV, ADMIN_NAV_GROUPS, currentNavHref, type AdminNavItem } from "./admin-nav";

describe("currentNavHref", () => {
  it("marks the section a nested page belongs to, not a lookalike path", () => {
    expect(currentNavHref("/admin/stores/abc123")).toBe("/admin/stores");
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/store-requests")).toBe("/admin/store-requests");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
    expect(currentNavHref("/admin/catalog/products/abc123")).toBe("/admin/catalog/products");
    expect(currentNavHref("/admin/catalog/review")).toBe("/admin/catalog/review");
    expect(currentNavHref("/admin/catalog/duplicates")).toBe("/admin/catalog/duplicates");
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

  it("has no Assistant entry: the assistant opens from the floating button on every page (#855)", () => {
    expect(ADMIN_NAV.map((entry) => entry.href)).not.toContain("/admin/assistant");
  });
});

describe("ADMIN_NAV_GROUPS", () => {
  it("groups the menu under the headings of design A (#859), in order", () => {
    expect(ADMIN_NAV_GROUPS.map((group) => [group.label, group.items.map((item) => item.label)])).toEqual([
      [null, ["Home"]],
      ["Stores", ["Stores", "Applications", "Store requests", "Subscriptions"]],
      ["Catalogue", ["Products", "Categories", "Recipes", "Catalog review", "Duplicates"]],
      ["Orders and money", ["Refunds", "Orders to check", "Search orders", "Disputes", "Fee ledger"]],
      ["Delivery", ["Courier incidents", "Courier settings", "Metros"]],
      ["Support", ["Messages"]],
      ["AI", ["AI conversations", "AI eval and spend"]],
      ["Settings", ["AI and onboarding"]],
    ]);
  });

  it("is the flat menu, each page in exactly one group", () => {
    expect(ADMIN_NAV_GROUPS.flatMap((group): readonly AdminNavItem[] => group.items)).toEqual([...ADMIN_NAV]);
  });

  it("names the queue count each badge shows", () => {
    const counted = Object.fromEntries(ADMIN_NAV.flatMap((item) => ("count" in item ? [[item.label, item.count]] : [])));
    expect(counted).toEqual({
      Applications: "applications",
      "Store requests": "storeRequests",
      "Catalog review": "catalogReview",
      Refunds: "refunds",
      "Orders to check": "ordersToCheck",
      Disputes: "disputes",
      "Courier incidents": "courierIncidents",
      Messages: "messages",
    });
  });
});
