import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { estimateStock, inventoryReport, storeWeek } from "./inventory-report";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t549-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60_000;
// Wednesday 2026-11-11, 21:00 in Chicago; already Thursday in UTC.
const NOW = new Date("2026-11-12T03:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("estimateStock", () => {
  it("needs a counted listing, stock on hand and at least 3 units sold in 14 days", () => {
    expect(estimateStock({ stockMode: "status", qty: null }, 40, "UTC", NOW)).toEqual({ kind: "not_counted" });
    expect(estimateStock({ stockMode: "counted", qty: 0 }, 40, "UTC", NOW)).toEqual({ kind: "sold_out" });
    expect(estimateStock({ stockMode: "counted", qty: 9 }, 2, "UTC", NOW)).toEqual({ kind: "not_enough_sales" });
    expect(estimateStock({ stockMode: "counted", qty: 9 }, 3, "UTC", NOW)).toMatchObject({ kind: "estimate", daysLeft: 42 });
  });

  it("dates the estimate in the store's time zone", () => {
    const chicago = estimateStock({ stockMode: "counted", qty: 3 }, 14, "America/Chicago", NOW);
    const utc = estimateStock({ stockMode: "counted", qty: 3 }, 14, "UTC", NOW);
    expect(chicago).toEqual({ kind: "estimate", perDay: 1, daysLeft: 3, outDate: "2026-11-14", outDay: "Saturday" });
    expect(utc).toMatchObject({ outDate: "2026-11-15", outDay: "Sunday" });
  });

  it("keys the store week on its Monday, in the store's zone", () => {
    expect(storeWeek("America/Chicago", NOW)).toBe("2026-11-09");
    expect(storeWeek("America/Chicago", new Date("2026-11-16T05:59:00Z"))).toBe("2026-11-09");
    expect(storeWeek("America/Chicago", new Date("2026-11-16T06:00:00Z"))).toBe("2026-11-16");
  });
});

describe.skipIf(!hasDb)("inventory report (lane database)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";
  let actorId = "";
  const ids: Record<string, string> = {};

  async function listing(storeId: string, name: string, data: { stockMode: string; qty?: number; status?: string }) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, confidence: 1, ...data },
    })).id;
  }

  async function events(storeId: string, listingId: string, rows: Array<[type: string, delta: number, at: Date]>) {
    await storeScoped(storeId).stockEvent.createMany({
      data: rows.map(([type, delta, createdAt]) => ({ storeId, listingId, type, delta, actorId, createdAt })),
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeAId = (await raw.store.create({
      data: { slug: `movement-a-${RUN}`, name: "Movement A", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `movement-b-${RUN}`, name: "Movement B", themePreset: "palm-and-shea" },
    })).id;
    actorId = (await raw.user.create({ data: { id: `movement-${RUN}`, name: "Owner", email: `movement-${RUN}@example.com` } })).id;

    ids.palm = await listing(storeAId, "Palm oil 1L", { stockMode: "counted", qty: 3 });
    ids.gari = await listing(storeAId, "Gari", { stockMode: "counted", qty: 10 });
    ids.egusi = await listing(storeAId, "Egusi", { stockMode: "status", status: "in_stock" });
    ids.archived = await listing(storeAId, "Old yam", { stockMode: "counted", qty: 1 });
    await storeScoped(storeAId).listing.update({ where: { id: ids.archived }, data: { active: false } });
    ids.foreign = await listing(storeBId, "Palm oil 1L", { stockMode: "counted", qty: 50 });

    await events(storeAId, ids.palm, [
      ["sale", -5, ago(1)],
      ["sale", -4, ago(3)],
      ["sale", -3, ago(9)],
      ["counter_sale", -2, ago(2)],
      ["restock", 20, ago(4)],
      ["short", -1, ago(5)],
      ["reservation", -6, ago(1)],
      ["recount", 3, ago(1)],
      ["sale", -50, ago(15)],
      ["sale", -50, new Date(NOW.getTime() + 60_000)],
    ]);
    await events(storeAId, ids.gari, [["sale", -2, ago(2)]]);
    await events(storeAId, ids.egusi, [["sale", -6, ago(1)], ["sale", -1, ago(8)]]);
    await events(storeAId, ids.archived, [["sale", -9, ago(1)]]);
    await events(storeBId, ids.foreign, [["sale", -40, ago(1)], ["counter_sale", -7, ago(1)]]);
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it("matches the seeded stock events exactly, soonest out first", async () => {
    const report = await inventoryReport(storeAId, { now: NOW });
    expect(report.timeZone).toBe("America/Chicago");
    expect(report.rows.map((row) => row.name)).toEqual(["Palm oil 1L", "Egusi", "Gari"]);
    expect(report.rows[0]).toEqual({
      listingId: ids.palm,
      name: "Palm oil 1L",
      stockMode: "counted",
      qty: 3,
      online7: 9,
      onlinePrior7: 3,
      counter7: 2,
      restocked7: 20,
      short7: 1,
      estimate: { kind: "estimate", perDay: 1, daysLeft: 3, outDate: "2026-11-14", outDay: "Saturday" },
    });
    expect(report.rows[1]).toMatchObject({ online7: 6, onlinePrior7: 1, qty: null, estimate: { kind: "not_counted" } });
    expect(report.rows[2]).toMatchObject({ online7: 2, counter7: 0, estimate: { kind: "not_enough_sales" } });
    expect(report.totals).toEqual({ online: 17, onlinePrior: 4, counter: 2, restocked: 20, short: 1 });
  });

  it("narrows to a listing search", async () => {
    const report = await inventoryReport(storeAId, { now: NOW, query: "gari" });
    expect(report.rows.map((row) => row.listingId)).toEqual([ids.gari]);
    expect((await inventoryReport(storeAId, { now: NOW, query: "plantain chips" })).rows).toEqual([]);
  });

  it("store B's events never count for store A, and B cannot read or write A's", async () => {
    const a = await inventoryReport(storeAId, { now: NOW, listingIds: [ids.palm, ids.foreign] });
    expect(a.rows.map((row) => row.listingId)).toEqual([ids.palm]);
    expect(a.totals.online).toBe(9);

    const b = await inventoryReport(storeBId, { now: NOW, listingIds: [ids.palm, ids.foreign] });
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ listingId: ids.foreign, online7: 40, counter7: 7 });

    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { listingId: ids.palm } })).toEqual([]);
    await expect(storeScoped(storeBId).stockEvent.create({
      data: { storeId: storeAId, listingId: ids.palm, type: "sale", delta: -100, actorId, createdAt: ago(1) },
    })).rejects.toSatisfy(isRlsRejection);
  });
});
