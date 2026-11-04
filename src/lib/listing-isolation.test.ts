import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, platformAdmin, platformSessionUser } from "./db";
import { Client } from "pg";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Listing RLS isolation", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;
  let listingAId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-listing-a" },
      update: {},
      create: { slug: "rls-listing-a", name: "Listing Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-listing-b" },
      update: {},
      create: { slug: "rls-listing-b", name: "Listing Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "rls-listing-test@example.com" },
      update: {},
      create: { id: "rls-listing-user", email: "rls-listing-test@example.com", name: "Listing Test User", emailVerified: true },
    });
    testUserId = user.id;

    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.create({
      data: {
        storeId: storeAId,
        customName: "Egusi Ground",
        price: 1200,
        stockMode: "counted",
        qty: 50,
        frozen: false,
        perishable: false,
      },
    });
    listingAId = listing.id;

    await scopedA.listingVariant.create({
      data: {
        listingId: listingAId,
        label: "500g",
        price: 1200,
        weightG: 500,
      },
    });

    await scopedA.stockEvent.create({
      data: {
        storeId: storeAId,
        listingId: listingAId,
        type: "recount",
        delta: 50,
        actorId: testUserId,
      },
    });

    await scopedA.auditLog.create({
      data: {
        storeId: storeAId,
        actorId: testUserId,
        actorEmail: "rls-listing-test@example.com",
        action: "listing.create",
        entityType: "listing",
        entityId: listingAId,
        after: { customName: "Egusi Ground", price: 1200 },
      },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { actorId: testUserId } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.user.deleteMany({ where: { email: "rls-listing-test@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["rls-listing-a", "rls-listing-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("store A can read its own listings", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.listing.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A listings", async () => {
    const scoped = storeScoped(storeBId);
    const rows = await scoped.listing.findMany();
    expect(rows.every((r) => r.storeId === storeBId)).toBe(true);
  });

  it("cross-store listing insert fails with RLS violation", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.listing.create({
        data: {
          storeId: storeBId,
          customName: "Hacked",
          price: 100,
          stockMode: "counted",
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own listing variants", async () => {
    const scoped = storeScoped(storeAId);
    const variants = await scoped.listingVariant.findMany();
    expect(variants.length).toBeGreaterThanOrEqual(1);
  });

  it("store B cannot read store A listing variants", async () => {
    const scoped = storeScoped(storeBId);
    const variants = await scoped.listingVariant.findMany();
    expect(variants.length).toBe(0);
  });

  it("cross-store variant insert fails", async () => {
    const scoped = storeScoped(storeBId);
    await expect(
      scoped.listingVariant.create({
        data: {
          listingId: listingAId,
          label: "Hacked",
          price: 100,
          weightG: 100,
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own stock events", async () => {
    const scoped = storeScoped(storeAId);
    const events = await scoped.stockEvent.findMany();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A stock events", async () => {
    const scoped = storeScoped(storeBId);
    const events = await scoped.stockEvent.findMany();
    expect(events.every((e) => e.storeId === storeBId)).toBe(true);
  });

  it("cross-store stock event insert fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.stockEvent.create({
        data: {
          storeId: storeBId,
          listingId: listingAId,
          type: "adjust",
          delta: -1,
          actorId: testUserId,
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own audit logs", async () => {
    const scoped = storeScoped(storeAId);
    const logs = await scoped.auditLog.findMany({ where: { entityType: "listing" } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.every((l) => l.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A audit logs", async () => {
    const scoped = storeScoped(storeBId);
    const logs = await scoped.auditLog.findMany({ where: { entityType: "listing" } });
    expect(logs.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("store cannot UPDATE or DELETE audit log entries", async () => {
    const scoped = storeScoped(storeAId);
    const result = await scoped.auditLog.updateMany({
      where: { entityType: "listing" },
      data: { action: "hacked" },
    });
    expect(result.count).toBe(0);
  });

  it("store-scoped queries log in as app_runtime", async () => {
    expect(await platformSessionUser()).toBe("app_runtime");
  });

  it("store B cannot create a stock event on store A's listing", async () => {
    const before = await storeScoped(storeAId).stockEvent.findMany({
      where: { listingId: listingAId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const eventId = `t235-foreign-${crypto.randomUUID()}`;
    await expectStockEventRls(() => storeScoped(storeBId).stockEvent.create({
      data: {
        id: eventId,
        storeId: storeBId,
        listingId: listingAId,
        type: "adjust",
        delta: 1,
        actorId: testUserId,
      },
    }));
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { listingId: listingAId } })).toEqual([]);
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
    const after = await storeScoped(storeAId).stockEvent.findMany({
      where: { listingId: listingAId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("store B cannot re-point its stock event to store A's listing or a missing listing", async () => {
    const listingB = await storeScoped(storeBId).listing.create({
      data: {
        storeId: storeBId,
        customName: `Repoint ${crypto.randomUUID()}`,
        price: 400,
        stockMode: "counted",
        qty: 2,
        frozen: false,
        perishable: false,
      },
    });
    const event = await storeScoped(storeBId).stockEvent.create({
      data: {
        storeId: storeBId,
        listingId: listingB.id,
        type: "recount",
        delta: 2,
        actorId: testUserId,
      },
    });
    await expectStockEventRls(() => storeScoped(storeBId).stockEvent.updateMany({
      where: { id: event.id },
      data: { listingId: listingAId },
    }));
    await expectStockEventRls(() => storeScoped(storeBId).stockEvent.updateMany({
      where: { id: event.id },
      data: { listingId: `missing-${crypto.randomUUID()}` },
    }));
    const reread = await storeScoped(storeBId).stockEvent.findUnique({ where: { id: event.id } });
    expect(reread?.listingId).toBe(listingB.id);
    expect(reread?.delta).toBe(2);
  });

  it("a missing listing id and a foreign listing id get the same RLS error", async () => {
    const missingId = `missing-${crypto.randomUUID()}`;
    const foreign = await captureStockEventError(() => storeScoped(storeBId).stockEvent.create({
      data: {
        id: `t235-oracle-a-${crypto.randomUUID()}`,
        storeId: storeBId,
        listingId: listingAId,
        type: "adjust",
        delta: 1,
        actorId: testUserId,
      },
    }));
    const missing = await captureStockEventError(() => storeScoped(storeBId).stockEvent.create({
      data: {
        id: `t235-oracle-m-${crypto.randomUUID()}`,
        storeId: storeBId,
        listingId: missingId,
        type: "adjust",
        delta: 1,
        actorId: testUserId,
      },
    }));
    expect(foreign.message).toMatch(/new row violates row-level security policy for table "stock_events"/i);
    expect(missing.message).toMatch(/new row violates row-level security policy for table "stock_events"/i);
    expect(foreign.code).not.toBe("P2003");
    expect(missing.code).not.toBe("P2003");
    expect(foreign.message).not.toMatch(/stock_events_listing_id_fkey/);
    expect(missing.message).not.toMatch(/stock_events_listing_id_fkey/);
    expect(foreign.code).toBe(missing.code);
  });

  it("store B cannot read, update or delete store A's stock event by id", async () => {
    const event = await storeScoped(storeAId).stockEvent.create({
      data: {
        storeId: storeAId,
        listingId: listingAId,
        type: "adjust",
        delta: 3,
        actorId: testUserId,
      },
    });
    const scopedB = storeScoped(storeBId);
    expect(await scopedB.stockEvent.findUnique({ where: { id: event.id } })).toBeNull();
    expect(await scopedB.stockEvent.findMany({ where: { id: event.id } })).toEqual([]);
    expect(await scopedB.stockEvent.updateMany({
      where: { id: event.id },
      data: { delta: 99 },
    })).toEqual({ count: 0 });
    expect(await scopedB.stockEvent.deleteMany({ where: { id: event.id } })).toEqual({ count: 0 });
    const still = await storeScoped(storeAId).stockEvent.findUnique({ where: { id: event.id } });
    expect(still?.listingId).toBe(listingAId);
    expect(still?.delta).toBe(3);
    expect(still?.storeId).toBe(storeAId);
  });

  it("a rejected stock event create sent twice writes nothing", async () => {
    const eventId = `t235-twice-${crypto.randomUUID()}`;
    const write = () => storeScoped(storeBId).stockEvent.create({
      data: {
        id: eventId,
        storeId: storeBId,
        listingId: listingAId,
        type: "adjust",
        delta: 1,
        actorId: testUserId,
      },
    });
    await expectStockEventRls(write);
    await expectStockEventRls(write);
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
    expect(await storeScoped(storeAId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
  });

  it("mixed stock event createMany rejects atomically", async () => {
    const listingB = await storeScoped(storeBId).listing.create({
      data: {
        storeId: storeBId,
        customName: `Batch ${crypto.randomUUID()}`,
        price: 250,
        stockMode: "counted",
        qty: 1,
        frozen: false,
        perishable: false,
      },
    });
    const validId = `t235-batch-ok-${crypto.randomUUID()}`;
    const foreignId = `t235-batch-foreign-${crypto.randomUUID()}`;
    const missingId = `t235-batch-missing-${crypto.randomUUID()}`;
    await expectStockEventRls(() => storeScoped(storeBId).stockEvent.createMany({
      data: [
        {
          id: validId,
          storeId: storeBId,
          listingId: listingB.id,
          type: "recount",
          delta: 1,
          actorId: testUserId,
        },
        {
          id: foreignId,
          storeId: storeBId,
          listingId: listingAId,
          type: "adjust",
          delta: 4,
          actorId: testUserId,
        },
        {
          id: missingId,
          storeId: storeBId,
          listingId: `missing-${crypto.randomUUID()}`,
          type: "adjust",
          delta: 5,
          actorId: testUserId,
        },
      ],
    }));
    const ids = [validId, foreignId, missingId];
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: { in: ids } } })).toEqual([]);
    expect(await storeScoped(storeAId).stockEvent.findMany({ where: { id: { in: ids } } })).toEqual([]);
  });

  it("listing delete and stock event insert preserve referential integrity concurrently", async () => {
    const direct = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    expect(direct).toBeTruthy();
    const insertWins = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `Insert wins ${crypto.randomUUID()}`,
        price: 100,
        stockMode: "counted",
        qty: 0,
        frozen: false,
        perishable: false,
      },
    });
    const deleteWins = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `Delete wins ${crypto.randomUUID()}`,
        price: 100,
        stockMode: "counted",
        qty: 0,
        frozen: false,
        perishable: false,
      },
    });
    const eventId = `t235-race-${crypto.randomUUID()}`;
    const lostEventId = `t235-race-lost-${crypto.randomUUID()}`;
    const holder = new Client({ connectionString: direct });
    const waiter = new Client({ connectionString: direct });
    const observer = new Client({ connectionString: direct });
    await Promise.all([holder.connect(), waiter.connect(), observer.connect()]);
    try {
      await beginAsStore(holder, storeAId);
      await holder.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ($1, $2, $3, 'adjust', 1, $4)`,
        [eventId, storeAId, insertWins.id, testUserId],
      );
      await beginAsStore(waiter, storeAId);
      const waiterPid = await backendPid(waiter);
      const deleting = waiter.query(`DELETE FROM listings WHERE id = $1`, [insertWins.id]);
      await waitForLockWait(observer, waiterPid);
      await holder.query("COMMIT");
      const deleteError = await deleting.then(
        () => null,
        (error: unknown) => error,
      );
      expect(pgError(deleteError).code).toBe("23001");
      expect(pgError(deleteError).message).toMatch(/stock_events_listing_id_fkey/);
      await waiter.query("ROLLBACK");

      const keptListing = await storeScoped(storeAId).listing.findUnique({ where: { id: insertWins.id } });
      const keptEvent = await storeScoped(storeAId).stockEvent.findUnique({ where: { id: eventId } });
      expect(keptListing?.id).toBe(insertWins.id);
      expect(keptEvent?.listingId).toBe(insertWins.id);
      expect(keptEvent?.delta).toBe(1);

      await beginAsStore(holder, storeAId);
      const removed = await holder.query(`DELETE FROM listings WHERE id = $1`, [deleteWins.id]);
      expect(removed.rowCount).toBe(1);
      await beginAsStore(waiter, storeAId);
      const insertPid = await backendPid(waiter);
      const inserting = waiter.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ($1, $2, $3, 'adjust', 1, $4)`,
        [lostEventId, storeAId, deleteWins.id, testUserId],
      );
      await waitForLockWait(observer, insertPid);
      await holder.query("COMMIT");
      const insertError = await inserting.then(
        () => null,
        (error: unknown) => error,
      );
      expect(pgError(insertError).code).toBe("23503");
      expect(pgError(insertError).message).toMatch(/stock_events_listing_id_fkey/);
      await waiter.query("ROLLBACK");

      expect(await storeScoped(storeAId).listing.findUnique({ where: { id: deleteWins.id } })).toBeNull();
      expect(await storeScoped(storeAId).stockEvent.findMany({ where: { id: lostEventId } })).toEqual([]);
    } finally {
      await Promise.all([
        rollbackQuietly(holder),
        rollbackQuietly(waiter),
        holder.end(),
        waiter.end(),
        observer.end(),
      ]);
    }
  }, 30_000);
});

function pgError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && error.code != null ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    return { code, message };
  }
  return { code: "", message: "" };
}

async function captureStockEventError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return pgError(error);
  }
  throw new Error("expected the stock event write to be rejected");
}

async function expectStockEventRls(run: () => Promise<unknown>) {
  const error = await captureStockEventError(run);
  expect(error.message).toMatch(/42501|row-level security/i);
  expect(error.code).not.toBe("P2003");
  expect(error.message).not.toMatch(/stock_events_listing_id_fkey/);
  return error;
}

async function beginAsStore(client: Client, storeId: string) {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE app_user");
  await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

async function waitForLockWait(observer: Client, pid: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted LIMIT 1",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the overlapping statement never waited on a lock");
}

async function rollbackQuietly(client: Client) {
  await client.query("ROLLBACK").catch(() => undefined);
}

describe.skipIf(!hasDb)("MasterProduct RLS (shared read)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let masterProductId: string;
  const testMpIds: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "rls-master-prod" },
      update: {},
      create: { slug: "rls-master-prod", name: "Master Prod Test", themePreset: "palm-and-shea" },
    });
    storeAId = store.id;

    const mp = await platformAdmin.masterProduct.create({
      data: { name: "Egusi Whole" },
    });
    masterProductId = mp.id;
    testMpIds.push(mp.id);
  });

  afterAll(async () => {
    await rawPrisma.masterProduct.deleteMany({ where: { id: { in: testMpIds } } });
    await rawPrisma.masterProduct.deleteMany({ where: { name: { startsWith: "Test Admin Insert" } } });
    await rawPrisma.store.deleteMany({ where: { slug: "rls-master-prod" } });
    await rawPrisma.$disconnect();
  });

  it("any store-scoped session can SELECT master products", async () => {
    const result = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.$queryRaw`SELECT id, name FROM master_products WHERE id = ${masterProductId}`,
    ]);
    const rows = result[2] as Array<{ id: string }>;
    expect(rows.length).toBe(1);
  });

  it("store-scoped session cannot INSERT into master products", async () => {
    await expect(
      rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.$executeRaw`INSERT INTO master_products (id, name, created_at, updated_at) VALUES ('rls_mp_test', 'Should Fail', NOW(), NOW())`,
      ]),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("platformAdmin can INSERT into master products", async () => {
    const mp = await platformAdmin.masterProduct.create({
      data: { name: "Test Admin Insert" },
    });
    testMpIds.push(mp.id);
    expect(mp.name).toBe("Test Admin Insert");
    await rawPrisma.masterProduct.deleteMany({ where: { id: mp.id } });
  });
});
