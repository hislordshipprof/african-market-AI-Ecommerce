import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { storeHome } from "./home";
import { searchStoreAdmin } from "./search";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 86_400_000;
// Noon in the store's zone, so "today" and "a week ago" are whole store days.
const now = new Date("2026-11-25T18:00:00Z");
const TZ = "America/Chicago";

describe.skipIf(!hasDb)("store admin Home and search (#860)", () => {
  let raw: PrismaClient;
  let storeA: string;
  let storeB: string;
  let ada: string;
  let number = 7000;

  function order(storeId: string, customerId: string, status: string, at: Date, captured: number | null = null) {
    return storeScopedTransaction(storeId, (tx) =>
      tx.order.create({
        data: {
          storeId,
          number: ++number,
          customerId,
          status,
          fulfillment: "pickup",
          subtotalCents: 2000,
          bufferCents: 200,
          totalAuthorizedCents: 2200,
          totalCents: 2000,
          capturedAmountCents: captured,
          createdAt: at,
        },
      }),
    );
  }

  function listing(storeId: string, customName: string, stock: { stockMode: string; qty?: number; status?: string }) {
    return storeScoped(storeId).listing.create({ data: { storeId, customName, price: 500, ...stock } });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `home-a-${suffix}`, name: "Home A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `home-b-${suffix}`, name: "Home B", themePreset: "palm-and-shea" } })).id;
    ada = (await storeScoped(storeA).customer.create({ data: { storeId: storeA, name: "Ada Obi", phone: "7135550142" } })).id;
    const bola = (await storeScoped(storeB).customer.create({ data: { storeId: storeB, name: "Ada Elsewhere" } })).id;

    await order(storeA, ada, "COMPLETED", new Date(now.getTime() - 2 * 3_600_000), 3000);
    await order(storeA, ada, "COMPLETED", new Date(now.getTime() - 1 * 3_600_000), 5000);
    await order(storeA, ada, "COMPLETED", new Date(now.getTime() - 7 * DAY), 4000);
    await order(storeA, ada, "AUTHORIZED", new Date(now.getTime() - 27 * 60_000));
    await order(storeA, ada, "AUTHORIZED", new Date(now.getTime() - 5 * 60_000));
    await order(storeA, ada, "PICKING", new Date(now.getTime() - 40 * 60_000));
    await order(storeA, ada, "SUBSTITUTION_PENDING", new Date(now.getTime() - 50 * 60_000));
    await order(storeB, bola, "AUTHORIZED", new Date(now.getTime() - 60_000));
    await order(storeB, bola, "COMPLETED", new Date(now.getTime() - 60_000), 9900);

    await listing(storeA, "Ugu", { stockMode: "counted", qty: 2 });
    await listing(storeA, "Ata rodo", { stockMode: "status", status: "low" });
    await listing(storeA, "Garri", { stockMode: "counted", qty: 4 });
    await listing(storeA, "Egusi", { stockMode: "counted", qty: 40 });
    await listing(storeA, "Sold out palm oil", { stockMode: "counted", qty: 0 });
    await listing(storeB, "Elsewhere ugu", { stockMode: "counted", qty: 1 });
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB]) {
      await storeScoped(storeId).order.deleteMany({});
      await storeScoped(storeId).listing.deleteMany({});
      await storeScoped(storeId).customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("counts today's sales against the same weekday last week, from this store only", async () => {
    const home = await storeHome(storeA, TZ, now);
    expect(home.today).toMatchObject({ day: "2026-11-25", salesCents: 8000, lastWeekCents: 4000, orders: 2, averageBasketCents: 4000 });
    expect(home.week).toHaveLength(7);
    expect(home.week[6]).toEqual({ day: "2026-11-25", salesCents: 8000 });
    expect(home.week[0].day).toBe("2026-11-19");
  });

  it("counts orders to pack, new orders with the oldest first, swaps, and running-low products", async () => {
    const home = await storeHome(storeA, TZ, now);
    expect(home.toPack).toEqual({ total: 4, fresh: 2, packing: 2 });
    expect(home.newOrders.count).toBe(2);
    expect(home.newOrders.oldestAt?.getTime()).toBe(now.getTime() - 27 * 60_000);
    expect(home.swaps.map((swap) => swap.customerName)).toEqual(["Ada Obi"]);
    expect(home.lowStock.count).toBe(3);
    expect(home.lowStock.names).toEqual(["Ugu", "Garri"]);
  });

  it("lists the five most recent orders, newest first", async () => {
    const home = await storeHome(storeA, TZ, now);
    expect(home.recent).toHaveLength(5);
    expect(home.recent[0]).toMatchObject({ customerName: "Ada Obi", status: "AUTHORIZED", active: true, totalCents: 2000 });
  });

  it("searches this store's orders, products and customers", async () => {
    const byName = await searchStoreAdmin(storeA, "ada");
    expect(byName.orders.length).toBeGreaterThan(0);
    expect(byName.orders.every((row) => row.customerName === "Ada Obi")).toBe(true);
    expect(byName.customers.map((row) => row.name)).toEqual(["Ada Obi"]);

    const products = await searchStoreAdmin(storeA, "UGU");
    expect(products.products.map((row) => row.name)).toEqual(["Ugu"]);

    const byPhone = await searchStoreAdmin(storeA, "(713) 555-0142");
    expect(byPhone.customers.map((row) => row.name)).toEqual(["Ada Obi"]);

    const first = byName.orders[byName.orders.length - 1];
    const byNumber = await searchStoreAdmin(storeA, `#${first.number}`);
    expect(byNumber.orders.map((row) => row.id)).toEqual([first.id]);
    expect(await searchStoreAdmin(storeA, "   ")).toEqual({ orders: [], products: [], customers: [] });
  });
});
