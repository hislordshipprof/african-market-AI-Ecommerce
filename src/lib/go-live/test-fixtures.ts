import type { PrismaClient } from "@prisma/client";
import { platformAdminTransaction, storeScoped } from "../db";

/** Test-only. Hours that open on a Monday in Chicago, read against GO_LIVE_TEST_NOW. */
export const GO_LIVE_TEST_HOURS = { monday: "9:00 AM - 8:00 PM", tuesday: "9:00 AM - 8:00 PM" };
export const GO_LIVE_TEST_NOW = new Date("2026-11-16T20:00:00Z");

/** Test-only. A store in setup with every go-live item done at a listing floor of 3. */
export async function createReadyStore(raw: PrismaClient, slug: string, status = "setup") {
  const store = await raw.store.create({
    data: {
      slug,
      name: slug,
      status,
      stripeOnboardingStatus: "complete",
      hours: GO_LIVE_TEST_HOURS,
      timezone: "America/Chicago",
      timezoneSetAt: new Date(),
      pickupEnabled: true,
    },
  });
  await platformAdminTransaction((tx) => tx.storeSubscription.create({
    data: { storeId: store.id, plan: "starter", status: "active", stripeSubscriptionId: `sub_${slug}` },
  }));
  for (let i = 0; i < 3; i++) {
    await storeScoped(store.id).listing.create({ data: { storeId: store.id, customName: `${slug} item`, price: 299, stockMode: "status" } });
  }
  return store;
}

/** Test-only. Removes stores made by createReadyStore with their listings, billing rows and audit rows. */
export async function deleteReadyStores(ids: string[]): Promise<void> {
  for (const id of ids) await storeScoped(id).listing.deleteMany({ where: { storeId: id } });
  await platformAdminTransaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { storeId: { in: ids } } });
    await tx.storeSubscription.deleteMany({ where: { storeId: { in: ids } } });
    await tx.store.deleteMany({ where: { id: { in: ids } } });
  });
}
