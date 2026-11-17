import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { metroReadiness } from "./metros";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t577-${Date.now().toString(36)}`;
/** A fixed clock, so no test depends on the day it runs. */
const NOW = new Date("2026-03-10T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const after = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000);

let prisma: PrismaClient;
const storeIds: string[] = [];
const metroIds: string[] = [];
let taxBefore: string[] = [];

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

function metro(name: string, states: string[]) {
  return asPlatformAdmin(async (tx) => {
    const row = await tx.metro.create({ data: { name: `${name} ${RUN}`, states, centerLat: 38.99, centerLng: -77.03, radiusMi: 40 } });
    metroIds.push(row.id);
    return row.id;
  });
}

async function store(data: Partial<Prisma.StoreUncheckedCreateInput>) {
  return asPlatformAdmin(async (tx) => {
    const row = await tx.store.create({ data: { name: `Store ${storeIds.length} ${RUN}`, slug: `${RUN}-${storeIds.length}`, ...data } });
    storeIds.push(row.id);
    const customer = await tx.customer.create({ data: { storeId: row.id, name: "Ada Obi", phone: "+13015550199", email: `${RUN}-${row.id}@example.com` } });
    let number = 1;
    return {
      id: row.id,
      /** One courier order with one delivery booked at `bookedAt`; `assignedAt` adds its courier_assigned event. */
      delivery: (bookedAt: Date, assignedAt: Date | null, pickupReadyAt: Date | null = null) =>
        asPlatformAdmin(async (t) => {
          const order = await t.order.create({
            data: { storeId: row.id, customerId: customer.id, number: number++, status: "DELIVERED", fulfillment: "courier", subtotalCents: 4000, bufferCents: 0, totalCents: 4000, totalAuthorizedCents: 4000 },
          });
          const d = await t.delivery.create({
            data: { storeId: row.id, orderId: order.id, provider: "uber", externalId: `${RUN}-${order.id}`, status: "delivered", quoteFeeCents: 899, createdAt: bookedAt, pickupReadyAt },
          });
          if (assignedAt) {
            await t.deliveryEvent.create({ data: { storeId: row.id, orderId: order.id, deliveryId: d.id, externalEventId: `assigned-${d.id}`, type: "courier_assigned", createdAt: assignedAt } });
          }
        }),
      quotes: (provider: string, day: string, attempts: number, successes: number) =>
        prisma.$transaction(async (t) => {
          await t.$executeRaw`SET LOCAL ROLE app_user`;
          await t.$executeRaw`SELECT set_config('app.store_id', ${row.id}, true)`;
          await t.courierQuoteDay.create({ data: { storeId: row.id, provider, day: new Date(day), attempts, successes } });
        }),
    };
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  taxBefore = (await asPlatformAdmin((tx) => tx.platformSettings.findUniqueOrThrow({ where: { id: "platform" } }))).taxSignedOffStates;
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.platformSettings.update({ where: { id: "platform" }, data: { taxSignedOffStates: taxBefore } });
    await tx.deliveryEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.delivery.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
    await tx.metro.deleteMany({ where: { id: { in: metroIds } } });
  });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("metro readiness report (#577 AC3)", () => {
  it("counts only the metro's own stores and data inside the 30-day window", async () => {
    const dmv = await metro("DMV", ["MD", "DC"]);
    const other = await metro("Other", ["MD"]);
    await asPlatformAdmin((tx) => tx.platformSettings.update({ where: { id: "platform" }, data: { taxSignedOffStates: ["MD"] } }));

    const live = await store({
      metroId: dmv, status: "active", listed: true, lat: 38.99, lng: -77.03, city: "Silver Spring", state: "MD",
      doordashStoreId: `${RUN}-dd`, uberRegistrationError: "pickup phone missing",
    });
    const setup = await store({ metroId: dmv, status: "setup", city: "Hyattsville", state: "MD" });
    const elsewhere = await store({ metroId: other, status: "active", listed: true, lat: 39.0, lng: -76.9, city: "Laurel", state: "MD" });

    // Quotes: the first day of the window counts, the day before it does not; another metro's never do.
    await live.quotes("doordash", "2026-03-10", 4, 3);
    await live.quotes("doordash", "2026-02-08", 10, 0);
    await live.quotes("uber", "2026-02-09", 4, 1);
    await setup.quotes("uber", "2026-03-01", 2, 2);
    await elsewhere.quotes("doordash", "2026-03-10", 100, 100);

    // Waits of 120 s, 300 s from the ready time (not from booking), 600 s, and 0 for a courier assigned before the
    // ready time: median 210 s. Left out: booked before the window, never assigned, another metro's.
    await live.delivery(ago(7200), after(ago(7200), 120));
    const booked = ago(3600);
    await live.delivery(booked, after(booked, 1500), after(booked, 1200));
    await live.delivery(ago(3000), after(ago(3000), 600));
    await live.delivery(ago(2000), after(ago(2000), 60), after(ago(2000), 900));
    await live.delivery(ago(31 * 86_400), after(ago(31 * 86_400), 60));
    await live.delivery(ago(1000), null);
    await elsewhere.delivery(ago(500), after(ago(500), 5000));

    const report = await metroReadiness(dmv, NOW);

    expect(report).not.toBeNull();
    expect(report?.counts).toEqual({ live: 1, setup: 1, suspended: 0 });
    expect(report?.stores.map((s) => [s.id, s.couriers])).toEqual([
      [live.id, { doordash: "registered", uber: "failed" }],
      [setup.id, { doordash: "not_registered", uber: "not_registered" }],
    ]);
    expect(report?.quotes).toEqual([
      { provider: "doordash", attempts: 4, successes: 3 },
      { provider: "uber", attempts: 6, successes: 3 },
    ]);
    expect(report?.assignment).toEqual({ medianSeconds: 210, deliveries: 4 });
    expect(report?.taxStates).toEqual([
      { code: "MD", name: "Maryland", signedOff: true },
      { code: "DC", name: "District of Columbia", signedOff: false },
    ]);
    expect(report?.cityPages).toEqual([
      { state: "MD", city: "Hyattsville", href: "/stores/maryland/hyattsville", present: false },
      { state: "MD", city: "Silver Spring", href: "/stores/maryland/silver-spring", present: true },
    ]);
  });

  it("a metro with no stores reports zeros and no median", async () => {
    const empty = await metro("Empty", ["TX"]);
    expect(await metroReadiness(empty, NOW)).toMatchObject({
      stores: [],
      counts: { live: 0, setup: 0, suspended: 0 },
      quotes: [],
      assignment: { medianSeconds: null, deliveries: 0 },
      cityPages: [],
    });
  });
});
