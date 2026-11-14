import { describe, expect, it } from "vitest";
import { ADMIN_NAV, currentNavHref } from "./admin-nav";

describe("admin menu", () => {
  it("lists the six admin sections in order", () => {
    expect(ADMIN_NAV.map((item) => item.label)).toEqual([
      "Home",
      "Stores",
      "Catalog review",
      "Refunds",
      "Orders to check",
      "Messages",
    ]);
  });

  it.each([
    ["/admin", "/admin"],
    ["/admin/stores", "/admin/stores"],
    ["/admin/stores/new", "/admin/stores"],
    ["/admin/stores/abc123", "/admin/stores"],
    ["/admin/catalog/review", "/admin/catalog/review"],
    ["/admin/orders", "/admin/orders"],
    ["/admin/orders/check", "/admin/orders/check"],
    ["/admin/support", "/admin/support"],
  ])("marks %s as %s", (pathname, href) => {
    expect(currentNavHref(pathname)).toBe(href);
  });

  it("does not mark a section for a lookalike path", () => {
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
  });
});
