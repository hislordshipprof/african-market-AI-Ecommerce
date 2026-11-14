import { describe, expect, it } from "vitest";
import { currentNavHref } from "./admin-nav";

describe("currentNavHref", () => {
  it("marks the section a nested page belongs to, not a lookalike path", () => {
    expect(currentNavHref("/admin/stores/abc123")).toBe("/admin/stores");
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
  });

  it("marks Search orders on the search page and on an order opened from it, not Refunds", () => {
    expect(currentNavHref("/admin/orders/search")).toBe("/admin/orders/search");
    expect(currentNavHref("/admin/orders/search/cmorder123")).toBe("/admin/orders/search");
    expect(currentNavHref("/admin/orders")).toBe("/admin/orders");
  });
});
