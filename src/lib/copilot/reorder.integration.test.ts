import { readFileSync } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { reorderSuggestions, suggestQuantity } from "./reorder";
import { loadReorderList, reorderCsv, reorderText, saveReorderList, setReorderDays } from "./reorder-list";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t551-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-12T03:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("suggestQuantity", () => {
  it("is ceil(daily sales x (lead + cover) - on hand), floored at 0", () => {
    // 28 sold in 28 days is 1 a day; 21 days of need less 5 on hand.
    expect(suggestQuantity({ onHand: 5, sold28: 28 }, 7, 14)).toBe(16);
    // 10 a 28 days x 21 = 7.5, less 2 = 5.5, up to 6.
    expect(suggestQuantity({ onHand: 2, sold28: 10 }, 7, 14)).toBe(6);
    expect(suggestQuantity({ onHand: 40, sold28: 28 }, 7, 14)).toBe(0);
    expect(suggestQuantity({ onHand: 0, sold28: 0 }, 7, 14)).toBe(0);
    expect(suggestQuantity({ onHand: 0, sold28: 1 }, 0, 1)).toBe(1);
  });

  it("has no floating point drift on an exact need", () => {
    // 3 a day x 7 is exactly 21: on hand 0 needs 21, not 22.
    expect(suggestQuantity({ onHand: 0, sold28: 84 }, 3, 4)).toBe(21);
  });
});

describe("the suggestions module has no write path", () => {
  it("reorder.ts never creates, updates, deletes or writes SQL", () => {
    const source = readFileSync(path.join(__dirname, "reorder.ts"), "utf8");
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(source).not.toMatch(/\$executeRaw|Transaction|\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe.skipIf(!hasDb)("reorder suggestions and list (lane database)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";
  let actor = { id: "", email: "" };
  const ids: Record<string, string> = {};

  async function listing(storeId: string, name: string, data: { stockMode: string; qty?: number; status?: string }) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, confidence: 1, ...data },
    })).id;
  }

  async function events(storeId: string, listingId: string, rows: Array<[type: string, delta: number, at: Date]>) {
    await storeScoped(storeId).stockEvent.createMany({
      data: rows.map(([type, delta, createdAt]) => ({ storeId, listingId, type, delta, actorId: actor.id, createdAt })),
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeAId = (await raw.store.create({ data: { slug: `reorder-a-${RUN}`, name: "Reorder A", themePreset: "palm-and-shea" } })).id;
    storeBId = (await raw.store.create({ data: { slug: `reorder-b-${RUN}`, name: "Reorder B", themePreset: "palm-and-shea" } })).id;
    const user = await raw.user.create({ data: { id: `reorder-${RUN}`, name: "Owner", email: `reorder-${RUN}@example.com` } });
    actor = { id: user.id, email: user.email };

    ids.palm = await listing(storeAId, "Palm oil 1L", { stockMode: "counted", qty: 5 });
    ids.gari = await listing(storeAId, "Gari", { stockMode: "counted", qty: 2 });
    ids.rice = await listing(storeAId, "Rice 5kg", { stockMode: "counted", qty: 40 });
    ids.egusi = await listing(storeAId, "Egusi", { stockMode: "status", status: "low" });
    ids.ogbono = await listing(storeAId, "Ogbono", { stockMode: "status", status: "out_of_stock" });
    ids.okra = await listing(storeAId, "Okra", { stockMode: "status", status: "in_stock" });
    ids.archived = await listing(storeAId, "Old yam", { stockMode: "counted", qty: 0 });
    await storeScoped(storeAId).listing.update({ where: { id: ids.archived }, data: { active: false } });
    ids.foreign = await listing(storeBId, "Palm oil 1L", { stockMode: "counted", qty: 0 });

    await events(storeAId, ids.palm, [
      ["sale", -20, ago(3)],
      ["counter_sale", -8, ago(10)],
      ["restock", 30, ago(5)],
      ["reservation", -9, ago(1)],
      ["sale", -50, ago(29)],
      ["sale", -50, new Date(NOW.getTime() + 60_000)],
    ]);
    await events(storeAId, ids.gari, [["sale", -10, ago(20)]]);
    await events(storeAId, ids.rice, [["sale", -28, ago(2)]]);
    await events(storeAId, ids.egusi, [["counter_sale", -1, ago(27)]]);
    await events(storeAId, ids.ogbono, [["sale", -4, ago(40)]]);
    await events(storeAId, ids.okra, [["sale", -4, ago(1)]]);
    await events(storeAId, ids.archived, [["sale", -9, ago(1)]]);
    await events(storeBId, ids.foreign, [["sale", -280, ago(1)]]);
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it("suggests counted listings from 28 days of sales and flags low or out status listings that sold", async () => {
    const result = await reorderSuggestions(storeAId, { now: NOW });
    expect(result).toMatchObject({ leadDays: 7, coverDays: 14, windowDays: 28 });
    expect(result.rows).toEqual([
      { listingId: ids.palm, name: "Palm oil 1L", stockMode: "counted", onHand: 5, status: null, sold28: 28, perDay: 1, suggested: 16 },
      { listingId: ids.gari, name: "Gari", stockMode: "counted", onHand: 2, status: null, sold28: 10, perDay: 0.4, suggested: 6 },
      { listingId: ids.egusi, name: "Egusi", stockMode: "status", onHand: null, status: "low", sold28: 1, perDay: 0, suggested: null },
    ]);
  });

  it("uses the store's lead time and cover", async () => {
    await setReorderDays(storeAId, { leadDays: 14, coverDays: 28 }, actor);
    const result = await reorderSuggestions(storeAId, { now: NOW });
    expect(result).toMatchObject({ leadDays: 14, coverDays: 28 });
    // Rice: 1 a day x 42 days, less 40 on hand.
    expect(result.rows.find((row) => row.listingId === ids.rice)?.suggested).toBe(2);
    expect(result.rows.find((row) => row.listingId === ids.palm)?.suggested).toBe(37);
    await setReorderDays(storeAId, { leadDays: 7, coverDays: 14 }, actor);
  });

  it("refuses lead time or cover out of range", async () => {
    await expect(setReorderDays(storeAId, { leadDays: -1, coverDays: 14 }, actor)).rejects.toThrow();
    await expect(setReorderDays(storeAId, { leadDays: 7, coverDays: 0 }, actor)).rejects.toThrow();
    await expect(setReorderDays(storeAId, { leadDays: 7, coverDays: 91 }, actor)).rejects.toThrow();
  });

  it("store B's sales never count for store A", async () => {
    const b = await reorderSuggestions(storeBId, { now: NOW });
    expect(b.rows).toEqual([expect.objectContaining({ listingId: ids.foreign, sold28: 280, suggested: 210 })]);
    const a = await reorderSuggestions(storeAId, { now: NOW });
    expect(a.rows.map((row) => row.listingId)).not.toContain(ids.foreign);
  });

  it("reading suggestions writes nothing", async () => {
    const before = await storeScoped(storeAId).stockEvent.count({ where: { storeId: storeAId } });
    const listings = await storeScoped(storeAId).listing.findMany({ where: { storeId: storeAId }, orderBy: { id: "asc" }, select: { qty: true, status: true } });
    await reorderSuggestions(storeAId, { now: NOW });
    expect(await storeScoped(storeAId).stockEvent.count({ where: { storeId: storeAId } })).toBe(before);
    expect(await storeScoped(storeAId).listing.findMany({ where: { storeId: storeAId }, orderBy: { id: "asc" }, select: { qty: true, status: true } })).toEqual(listings);
  });

  it("saves the owner's edited quantities as the store's one draft, replacing the last save", async () => {
    const first = await saveReorderList(storeAId, [
      { listingId: ids.palm, quantity: 20 },
      { listingId: ids.egusi, quantity: null },
    ], actor);
    expect(first.ok).toBe(true);
    const second = await saveReorderList(storeAId, [
      { listingId: ids.palm, quantity: 12 },
      { listingId: ids.gari, quantity: 0 },
      { listingId: ids.egusi, quantity: 3 },
      { listingId: ids.okra, quantity: null },
    ], actor);
    expect(second.ok).toBe(true);
    expect(await storeScoped(storeAId).reorderList.count({ where: { storeId: storeAId } })).toBe(1);
    const list = await loadReorderList(storeAId);
    expect(list?.items).toEqual([
      { listingId: ids.palm, name: "Palm oil 1L", quantity: 12 },
      { listingId: ids.egusi, name: "Egusi", quantity: 3 },
      { listingId: ids.okra, name: "Okra", quantity: null },
    ]);
    const audit = await storeScoped(storeAId).auditLog.findFirst({ where: { storeId: storeAId, action: "store.reorder_list" }, orderBy: { createdAt: "desc" } });
    expect(audit?.actorId).toBe(actor.id);
  });

  it("saving changes no stock", async () => {
    const palm = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.palm } });
    expect(palm.qty).toBe(5);
    const restocks = await storeScoped(storeAId).stockEvent.count({ where: { storeId: storeAId, type: "restock" } });
    expect(restocks).toBe(1);
  });

  it("refuses a blank count on a counted listing, a decimal, too large, empty, duplicates, archived or foreign listings", async () => {
    for (const lines of [
      [{ listingId: ids.palm, quantity: null }],
      [{ listingId: ids.palm, quantity: 2.5 }],
      [{ listingId: ids.palm, quantity: 100_001 }],
      [{ listingId: ids.palm, quantity: -1 }],
      [{ listingId: ids.palm, quantity: 0 }],
      [{ listingId: ids.palm, quantity: 1 }, { listingId: ids.palm, quantity: 2 }],
      [{ listingId: ids.archived, quantity: 1 }],
      [{ listingId: ids.foreign, quantity: 1 }],
    ]) {
      expect((await saveReorderList(storeAId, lines, actor)).ok).toBe(false);
    }
    expect((await loadReorderList(storeAId))?.items).toHaveLength(3);
  });

  it("store B cannot read, change or add to store A's list", async () => {
    const listA = await storeScoped(storeAId).reorderList.findUniqueOrThrow({ where: { storeId: storeAId } });
    expect(await loadReorderList(storeBId)).toBeNull();
    expect(await storeScoped(storeBId).reorderList.findMany()).toEqual([]);
    expect(await storeScoped(storeBId).reorderListItem.findMany()).toEqual([]);
    expect((await storeScoped(storeBId).reorderListItem.updateMany({ where: { listId: listA.id }, data: { quantity: 999 } })).count).toBe(0);
    await expect(storeScoped(storeBId).reorderListItem.create({
      data: { listId: listA.id, storeId: storeAId, listingId: ids.palm, name: "x", quantity: 1, position: 9 },
    })).rejects.toSatisfy(isRlsRejection);
    await expect(storeScoped(storeBId).reorderList.create({
      data: { storeId: storeAId, savedById: actor.id },
    })).rejects.toSatisfy(isRlsRejection);
    // B's own list cannot carry A's listing.
    const listB = await storeScoped(storeBId).reorderList.create({ data: { storeId: storeBId, savedById: actor.id } });
    await expect(storeScoped(storeBId).reorderListItem.create({
      data: { listId: listB.id, storeId: storeBId, listingId: ids.palm, name: "x", quantity: 1, position: 0 },
    })).rejects.toSatisfy(isRlsRejection);
  });

  it("exports the saved list as CSV and plain text", async () => {
    const list = await loadReorderList(storeAId);
    expect(list).not.toBeNull();
    expect(reorderCsv(list!)).toBe('Item,Quantity\r\nPalm oil 1L,12\r\nEgusi,3\r\nOkra,reorder (no count)\r\n');
    expect(reorderText(list!, "Reorder A")).toBe("Reorder list for Reorder A\nPalm oil 1L: 12\nEgusi: 3\nOkra: reorder (no count)");
  });
});

describe("reorderCsv", () => {
  it("quotes commas and quotes, and neutralises formula-leading cells", () => {
    const csv = reorderCsv({
      items: [
        { listingId: "a", name: 'Beans, "honey"', quantity: 2 },
        { listingId: "b", name: "=HYPERLINK(1)", quantity: 1 },
      ],
    });
    expect(csv).toBe('Item,Quantity\r\n"Beans, ""honey""",2\r\n\'=HYPERLINK(1),1\r\n');
  });
});
