import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_LISTING_PREFIX } from "../src/lib/storefront/e2e-listings";

/** The seeded store every listing e2e spec writes to. */
export const E2E_STORE_SLUG = "mama-ngozi";

export interface E2eCleanupResult {
  listings: number;
  orders: number;
  customers: number;
}

/** A sweep of 500+ listings with orders needs more than Prisma's 5 s interactive-transaction default. */
const SWEEP_TIMEOUT_MS = 60_000;

/**
 * Deletes e2e-created listings from the e2e store, plus the orders and customers they leave empty.
 *
 * Convention: every e2e spec names the listings it creates with E2E_LISTING_PREFIX ("E2E ").
 * Storefront reads hide that prefix, and this cleanup removes it. A spec that creates listings
 * without the prefix is neither hidden nor cleaned up.
 *
 * Scoped to one store by id, over DIRECT_URL (migration/owner connection). Every store-owned table
 * has FORCE ROW LEVEL SECURITY, and CI and lane databases connect as app_owner (no BYPASSRLS), so the
 * whole sweep runs in one interactive transaction as app_user with app.store_id set (the same pattern
 * as storeScopedTransaction in src/lib/db.ts, repeated inline because Playwright loads this file and
 * db.ts builds the app singleton on the runtime URL). Without that context every query matches zero rows.
 *
 * Pass `names` to remove only those listings (per-spec afterAll); omit it to remove every prefixed
 * listing (globalTeardown). A full sweep throws, and rolls back, if any prefixed listing survives.
 *
 * Orders are removed only when this sweep took their last line; orders that were already empty, or
 * that keep a non-e2e line, stay. A customer goes only with its last order and when it has no cart.
 */
export async function deleteE2eListings(
  opts: { names?: string[]; storeSlug?: string; client?: PrismaClient } = {},
): Promise<E2eCleanupResult> {
  // Resolve the URL first so a missing DIRECT_URL fails fast, before any connection is made.
  const prisma = opts.client ?? new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUnique({ where: { slug: opts.storeSlug ?? E2E_STORE_SLUG } });
    if (!store) return { listings: 0, orders: 0, customers: 0 };
    const storeId = store.id;
    const nameFilter = opts.names
      ? { in: opts.names.filter((n) => n.startsWith(E2E_LISTING_PREFIX)) }
      : { startsWith: E2E_LISTING_PREFIX };

    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;

        const ids = (
          await tx.listing.findMany({ where: { storeId, customName: nameFilter }, select: { id: true } })
        ).map((l) => l.id);
        if (ids.length === 0) return { listings: 0, orders: 0, customers: 0 };

        // Variants and collection items cascade. Stock events, cart lines and order lines point at the
        // listing or its variants without cascade, and other specs (customer journey) can add e2e
        // listings to carts and orders, so those rows go first.
        const variantIds = (
          await tx.listingVariant.findMany({ where: { listingId: { in: ids } }, select: { id: true } })
        ).map((v) => v.id);
        const lineWhere = {
          storeId,
          OR: [{ listingVariantId: { in: variantIds } }, { substituteVariantId: { in: variantIds } }],
        };

        // Candidate orders are read before their lines go: only orders this sweep touches may be deleted.
        const touchedOrderIds = [
          ...new Set((await tx.orderLine.findMany({ where: lineWhere, select: { orderId: true } })).map((l) => l.orderId)),
        ];

        await tx.cartLine.deleteMany({
          where: { storeId, OR: [{ variantId: { in: variantIds } }, { substituteVariantId: { in: variantIds } }] },
        });
        await tx.orderLine.deleteMany({ where: lineWhere });
        await tx.stockEvent.deleteMany({ where: { storeId, listingId: { in: ids } } });
        const listings = await tx.listing.deleteMany({ where: { storeId, id: { in: ids } } });

        const emptied = await tx.order.findMany({
          where: { storeId, id: { in: touchedOrderIds }, lines: { none: {} } },
          select: { id: true, customerId: true },
        });
        const orders = await tx.order.deleteMany({ where: { storeId, id: { in: emptied.map((o) => o.id) } } });
        // Orders first: orders.customer_id is RESTRICT. Customers with other orders or any cart stay.
        const customers = await tx.customer.deleteMany({
          where: {
            storeId,
            id: { in: [...new Set(emptied.map((o) => o.customerId))] },
            orders: { none: {} },
            carts: { none: {} },
          },
        });

        if (!opts.names) {
          const left = await tx.listing.count({
            where: { storeId, customName: { startsWith: E2E_LISTING_PREFIX } },
          });
          if (left > 0) throw new Error(`e2e teardown: ${left} "${E2E_LISTING_PREFIX}" listings survived cleanup`);
        }
        // deleteMany's count, not ids.length: a concurrent sweep may have removed some rows first.
        return { listings: listings.count, orders: orders.count, customers: customers.count };
      },
      { timeout: SWEEP_TIMEOUT_MS },
    );
  } finally {
    if (!opts.client) await prisma.$disconnect();
  }
}
