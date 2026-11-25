import { describe, expect, it } from "vitest";
import { filterStores, parseStoreFilters, storeViewCounts, type ListedStore } from "./store-views";

const store = (id: string, over: Partial<ListedStore> = {}): ListedStore => ({
  id, name: `Store ${id}`, slug: `store-${id}`, status: "active", plan: "starter", metroId: null, subscription: null, ...over,
});

const stores: ListedStore[] = [
  store("a", { name: "Mama Ngozi", slug: "mama-ngozi", metroId: "hou", plan: "pro", subscription: { status: "active", pilot: true, paymentFailedAt: null } }),
  store("b", { name: "Lagos Fresh", metroId: "hou", plan: "pro", subscription: { status: "past_due", pilot: false, paymentFailedAt: new Date() } }),
  store("c", { name: "Sahel Spice", status: "setup", metroId: "dal", subscription: { status: "trialing", pilot: false, paymentFailedAt: null } }),
  store("d", { name: "Kumasi Corner", status: "suspended", subscription: { status: "canceled", pilot: false, paymentFailedAt: null } }),
];

describe("storeViewCounts", () => {
  it("counts the saved views design A shows as tabs", () => {
    expect(storeViewCounts(stores)).toEqual({ all: 4, live: 2, setup: 1, "payment-failed": 1, suspended: 1 });
  });
});

describe("filterStores", () => {
  const none = parseStoreFilters({}, ["hou", "dal"]);

  it("shows a view's stores", () => {
    expect(filterStores(stores, { ...none, view: "live" }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(filterStores(stores, { ...none, view: "payment-failed" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("matches the search on name or slug, ignoring case", () => {
    expect(filterStores(stores, { ...none, q: "LAGOS" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterStores(stores, { ...none, q: "mama-ng" }).map((s) => s.id)).toEqual(["a"]);
  });

  it("applies every filter together, a store in no metro under none", () => {
    expect(filterStores(stores, { ...none, metro: "hou", plan: "pro", pilot: "yes" }).map((s) => s.id)).toEqual(["a"]);
    expect(filterStores(stores, { ...none, metro: "none" }).map((s) => s.id)).toEqual(["d"]);
    expect(filterStores(stores, { ...none, billing: "none" }).map((s) => s.id)).toEqual([]);
    expect(filterStores(stores, { ...none, billing: "trialing", pilot: "no" }).map((s) => s.id)).toEqual(["c"]);
  });
});

describe("parseStoreFilters", () => {
  it("keeps only known values, so a hand-typed URL falls back to all", () => {
    expect(parseStoreFilters({ view: "live", metro: "hou", plan: "pro", billing: "past_due", pilot: "yes", q: "  ada " }, ["hou"]))
      .toEqual({ view: "live", metro: "hou", plan: "pro", billing: "past_due", pilot: "yes", q: "ada" });
    expect(parseStoreFilters({ view: "gone", metro: "zzz", plan: "gold", billing: "x", pilot: "maybe", q: ["a", "b"] }, ["hou"]))
      .toEqual({ view: "all", metro: "", plan: "", billing: "", pilot: "", q: "" });
    expect(parseStoreFilters({ q: "x".repeat(200) }, []).q).toHaveLength(100);
  });
});
