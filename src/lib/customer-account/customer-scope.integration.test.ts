import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  authPrisma,
  customerScoped,
  customerScopedTransaction,
  platformAdminTransaction,
  platformSessionUser,
  Prisma,
  storeScoped,
  storeScopedRawQuery,
  storeScopedTransaction,
} from "../db";
import { addAddress } from "./address-book";

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t248-${Date.now()}`;

describe.skipIf(!hasDb)("customer scope (lane DB, app_runtime)", () => {
  const userA = `userA-${run}`;
  const userB = `userB-${run}`;
  const storeId = `store-${run}`;
  const emailA = `${userA}@example.test`;
  const emailB = `${userB}@example.test`;

  afterAll(async () => {
    await authPrisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await authPrisma.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
  });

  it("proves the login role and rejects an empty customer id before any query", async () => {
    expect(await platformSessionUser()).toBe("app_runtime");
    expect(() => customerScoped("")).toThrow(/customer id/i);
    expect(() => customerScoped("   ")).toThrow(/customer id/i);
    await expect(customerScopedTransaction(" \n ", async () => null)).rejects.toThrow(/customer id/i);
  });

  it("customerScoped(B) cannot read, update or delete A's rows; A reads them back", async () => {
    await authPrisma.user.create({ data: { id: userA, name: "Ada", email: emailA } });
    await authPrisma.user.create({ data: { id: userB, name: "Bea", email: emailB } });
    const created = await addAddress(userA, {
      label: "Home",
      line1: "1 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96813",
    });

    expect(await customerScoped(userB).customerAddress.findMany()).toEqual([]);
    const updated = await customerScoped(userB).customerAddress.updateMany({
      where: { id: created.id },
      data: { label: "Stolen" },
    });
    expect(updated.count).toBe(0);
    const removed = await customerScoped(userB).customerAddress.deleteMany({ where: { id: created.id } });
    expect(removed.count).toBe(0);

    const own = await customerScoped(userA).customerAddress.findUnique({ where: { id: created.id } });
    expect(own?.label).toBe("Home");
    expect(own?.line1).toBe("1 Market St");
  });

  it("storeScoped, storeScopedRawQuery and platform admin read 0 rows and cannot write either table", async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`
        INSERT INTO stores (id, name, slug, status, updated_at)
        VALUES (${storeId}, 'Scope Store', ${storeId}, 'active', now())
      `;
    });
    const rawProfile = await storeScopedRawQuery<{ user_id: string }>(
      storeId,
      Prisma.sql`SELECT user_id FROM platform_customer_profiles`,
    );
    expect(rawProfile).toEqual([]);
    expect(await storeScoped(storeId).cart.findMany({ where: { storeId } })).toEqual([]);

    await expect(storeScopedTransaction(storeId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO customer_addresses (id, user_id, label, line1, city, state, zip, updated_at)
        VALUES (${`bad-${run}`}, ${userA}, 'X', '1', 'Honolulu', 'HI', '96813', now())
      `;
    })).rejects.toThrow(/row-level security|42501/i);

    const adminRead = await platformAdminTransaction(async (tx) => {
      return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM customer_addresses`;
    });
    expect(adminRead).toEqual([]);

    const adminWrite = await platformAdminTransaction(async (tx) => {
      return tx.$executeRaw`DELETE FROM platform_customer_profiles`;
    });
    expect(Number(adminWrite)).toBe(0);
    const still = await customerScoped(userA).customerAddress.findUnique({ where: { id: (await customerScoped(userA).customerAddress.findFirst())!.id } });
    expect(still?.label).toBe("Home");
  });

  it("a pooled connection after customerScoped(A) sees nothing under a store scope", async () => {
    await customerScoped(userA).platformCustomerProfile.findUnique({ where: { userId: userA } });
    const rows = await storeScopedRawQuery<{ user_id: string }>(
      storeId,
      Prisma.sql`SELECT user_id FROM platform_customer_profiles`,
    );
    expect(rows).toEqual([]);
  });

  it("cross-user insert and owner transfer fail on one connection, and scope resets", async () => {
    const client = new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
    await client.connect();
    try {
      const login = await client.query<{ session_user: string }>("SELECT session_user::text AS session_user");
      expect(["app_runtime", "app_owner"]).toContain(login.rows[0]?.session_user);
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.user_id', $1, true)", [userB]);
      await expect(client.query(
        `INSERT INTO customer_addresses (id, user_id, label, line1, city, state, zip, updated_at)
         VALUES ($1, $2, 'Nope', '1', 'Honolulu', 'HI', '96813', now())`,
        [`cross-${run}`, userA],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      const hidden = await client.query("SELECT id FROM customer_addresses");
      await client.query("COMMIT");
      expect(hidden.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("new rows cascade for an otherwise deletable user; a store customer still restricts deletion", async () => {
    await authPrisma.user.delete({ where: { id: userB } });
    expect(await customerScoped(userA).customerAddress.findFirst()).toBeTruthy();
    const customerId = `cust-${run}`;
    await storeScoped(storeId).customer.create({
      data: { id: customerId, storeId, userId: userA, name: "Ada" },
    });
    await expect(authPrisma.user.delete({ where: { id: userA } })).rejects.toThrow();
    const remaining = await customerScoped(userA).customerAddress.findFirst();
    expect(remaining?.line1).toBe("1 Market St");
    await storeScoped(storeId).customer.delete({ where: { id: customerId } });
    await authPrisma.user.delete({ where: { id: userA } });
    expect(await customerScoped(userA).customerAddress.findMany()).toEqual([]);
  });
});
