import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPrisma, storeScoped } from "../db";
import { loadCheckoutPrefill } from "./checkout-profile";

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t750-prefill-${Date.now()}`;

describe.skipIf(!hasDb)("checkout prefill name (#750)", () => {
  const storeId = crypto.randomUUID();
  const namelessId = `user-${run}-nameless`;
  const namedId = `user-${run}-named`;

  beforeAll(async () => {
    await authPrisma.user.create({ data: { id: namelessId, name: "", email: `${namelessId}@example.test`, emailVerified: true } });
    await authPrisma.user.create({ data: { id: namedId, name: "Account Name", email: `${namedId}@example.test`, emailVerified: true } });
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Prefill Store', ${run}, 'active', now())`;
    });
    const db = storeScoped(storeId);
    for (const userId of [namelessId, namedId]) {
      const account = await db.customer.create({ data: { storeId, userId, name: "" } });
      // A guest order the account claimed: the name the shopper typed last time.
      const guest = await db.customer.create({
        data: { storeId, name: "Ada Okafor", email: `${userId}@example.test`, claimedByCustomerId: account.id, claimedAt: new Date() },
      });
      await db.order.create({
        data: {
          storeId, number: userId === namelessId ? 1 : 2, customerId: guest.id, status: "COMPLETED",
          subtotalCents: 1000, bufferCents: 100, totalAuthorizedCents: 1100,
        },
      });
    }
  });

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${storeId} AND claimed_by_customer_id IS NOT NULL`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
    await authPrisma.user.deleteMany({ where: { id: { in: [namelessId, namedId] } } });
  });

  it("fills Full name from this store's last order when the account has no name", async () => {
    const prefill = await loadCheckoutPrefill(namelessId, storeId);
    expect(prefill.contact.name).toBe("Ada Okafor");
    expect(prefill.contact.email).toBe(`${namelessId}@example.test`);
  });

  it("keeps the account's own name over the last order's", async () => {
    expect((await loadCheckoutPrefill(namedId, storeId)).contact.name).toBe("Account Name");
  });

  it("leaves the name empty with no store to look in", async () => {
    expect((await loadCheckoutPrefill(namelessId)).contact.name).toBe("");
  });
});
