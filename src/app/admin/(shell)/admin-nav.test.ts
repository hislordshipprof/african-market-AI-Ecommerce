import { describe, expect, it } from "vitest";
import { currentNavHref } from "./admin-nav";

describe("currentNavHref", () => {
  it("marks the section a nested page belongs to, not a lookalike path", () => {
    expect(currentNavHref("/admin/stores/abc123")).toBe("/admin/stores");
    expect(currentNavHref("/admin/storesX")).toBe("/admin");
    expect(currentNavHref("/admin/orders/checked")).toBe("/admin/orders");
    expect(currentNavHref("/admin/ai/conversations/shopper/abc123")).toBe("/admin/ai/conversations");
  });

  it("marks the fee ledger for the ledger page", () => {
    expect(currentNavHref("/admin/billing/ledger")).toBe("/admin/billing/ledger");
  });
});
