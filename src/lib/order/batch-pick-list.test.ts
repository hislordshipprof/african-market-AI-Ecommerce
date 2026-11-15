import { describe, expect, it } from "vitest";
import { allocateFound, buildBatchPickList, type BatchOrderInput, type BatchLineInput } from "./batch-pick-list";

const SOUP = { name: "Soup ingredients", sortOrder: 2 };
const GRAINS = { name: "Grains & flour", sortOrder: 1 };

function line(id: string, overrides: Partial<BatchLineInput> = {}): BatchLineInput {
  return {
    id,
    listingVariantId: "v-egusi",
    qtyOrdered: 1,
    qtyPicked: 0,
    status: "pending",
    swapRule: "exact_only",
    substituteName: null,
    name: "Egusi",
    label: "1 lb",
    imageUrl: null,
    frozen: false,
    perishable: false,
    zone: SOUP,
    ...overrides,
  };
}

function order(id: string, number: number, minutesAgo: number, lines: BatchLineInput[]): BatchOrderInput {
  return {
    id,
    number,
    createdAt: new Date(Date.UTC(2026, 10, 14, 12, 0) - minutesAgo * 60_000),
    status: "ACCEPTED",
    fulfillment: "pickup",
    lines,
  };
}

describe("buildBatchPickList (#564)", () => {
  it("combines a shared item into one line with the total and the split per order, oldest order first with tote A", () => {
    // Passed newest first: tote letters still follow order age.
    const list = buildBatchPickList([
      order("o-1043", 1043, 5, [line("l-3", { qtyOrdered: 1 })]),
      order("o-1042", 1042, 20, [line("l-1", { qtyOrdered: 2 })]),
    ]);

    expect(list.totes.map((t) => [t.number, t.letter])).toEqual([[1042, "A"], [1043, "B"]]);
    const egusi = list.zones[0].lines[0];
    expect(egusi.totalQty).toBe(3);
    expect(egusi.splits.map((s) => [s.number, s.letter, s.qty])).toEqual([[1042, "A", 2], [1043, "B", 1]]);
    expect(egusi.open).toBe(true);
  });

  it("groups lines by zone in the store's category order, with uncategorised before chilled and frozen last", () => {
    const list = buildBatchPickList([
      order("o-1", 1, 10, [
        line("fish", { listingVariantId: "v-fish", name: "Frozen tilapia", frozen: true, zone: SOUP }),
        line("ugu", { listingVariantId: "v-ugu", name: "Ugu leaves", perishable: true, zone: SOUP }),
        line("egusi", { listingVariantId: "v-egusi", name: "Egusi", zone: SOUP }),
        line("pot", { listingVariantId: "v-pot", name: "Cooking pot", zone: null }),
        line("garri", { listingVariantId: "v-garri", name: "Garri", zone: GRAINS }),
      ]),
      order("o-2", 2, 5, [line("garri-2", { listingVariantId: "v-garri", name: "Garri", zone: GRAINS })]),
    ]);

    expect(list.zones.map((z) => [z.name, z.lines.map((l) => l.name)])).toEqual([
      ["Grains & flour", ["Garri"]],
      ["Soup ingredients", ["Egusi"]],
      ["Other", ["Cooking pot"]],
      ["Chilled", ["Ugu leaves"]],
      ["Frozen", ["Frozen tilapia"]],
    ]);
  });

  it("shows the shopper's pre-approved swap on that order's split only", () => {
    const list = buildBatchPickList([
      order("o-1", 1, 10, [line("a", { swapRule: "named_substitute", substituteName: "Egusi (ground) 1 lb" })]),
      order("o-2", 2, 5, [line("b", { swapRule: "store_suggests" })]),
      order("o-3", 3, 1, [line("c")]),
    ]);

    expect(list.zones[0].lines[0].splits.map((s) => s.swap)).toEqual([
      "Swap OK: Egusi (ground) 1 lb",
      "Store may suggest a swap",
      null,
    ]);
  });

  it("marks a combined line done only when every order's line is resolved", () => {
    const list = buildBatchPickList([
      order("o-1", 1, 10, [line("a", { status: "picked", qtyPicked: 1 })]),
      order("o-2", 2, 5, [line("b", { status: "short", qtyPicked: 0 })]),
    ]);
    expect(list.zones[0].lines[0].open).toBe(true);

    const done = buildBatchPickList([
      order("o-1", 1, 10, [line("a", { status: "picked", qtyPicked: 1 })]),
      order("o-2", 2, 5, [line("b", { status: "refunded", qtyPicked: 0 })]),
    ]);
    expect(done.zones[0].lines[0].open).toBe(false);
  });
});

describe("allocateFound (#564)", () => {
  it("fills the oldest order first, so a short lands on the newest", () => {
    const lines = [
      { id: "a", qtyOrdered: 2 },
      { id: "b", qtyOrdered: 1 },
      { id: "c", qtyOrdered: 2 },
    ];
    expect(allocateFound(lines, 3)).toEqual([
      { id: "a", found: 2 },
      { id: "b", found: 1 },
      { id: "c", found: 0 },
    ]);
    expect(allocateFound(lines, 4)).toEqual([
      { id: "a", found: 2 },
      { id: "b", found: 1 },
      { id: "c", found: 1 },
    ]);
    expect(allocateFound(lines, 0).map((l) => l.found)).toEqual([0, 0, 0]);
  });
});
