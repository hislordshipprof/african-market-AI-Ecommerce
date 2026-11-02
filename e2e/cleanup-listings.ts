import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { E2E_LISTING_PREFIX } from "../src/lib/storefront/e2e-listings";

/** The seeded store every listing e2e spec writes to. */
export const E2E_STORE_SLUG = "mama-ngozi";

/**
 * Deletes e2e-created listings from the e2e store and returns how many rows were removed.
 *
 * Convention: every e2e spec names the listings it creates with E2E_LISTING_PREFIX ("E2E ").
 * Storefront reads hide that prefix, and this cleanup removes it. A spec that creates listings
 * without the prefix is neither hidden nor cleaned up.
 *
 * Scoped to one store by id, over DIRECT_URL (migration/owner connection). Pass `names` to
 * remove only those listings (per-spec afterAll); omit it to remove every prefixed listing
 * (globalTeardown). Throws if any prefixed listing survives a full sweep.
 */
export async function deleteE2eListings(opts: { names?: string[] } = {}): Promise<number> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUnique({ where: { slug: E2E_STORE_SLUG } });
    if (!store) return 0;
    const where = {
      storeId: store.id,
      customName: opts.names
        ? { in: opts.names.filter((n) => n.startsWith(E2E_LISTING_PREFIX)) }
        : { startsWith: E2E_LISTING_PREFIX },
    };
    const ids = (await prisma.listing.findMany({ where, select: { id: true } })).map((l) => l.id);
    if (ids.length > 0) {
      // Variants and collection items cascade; stock events reference the listing without cascade.
      await prisma.$transaction([
        prisma.stockEvent.deleteMany({ where: { listingId: { in: ids } } }),
        prisma.listing.deleteMany({ where: { id: { in: ids } } }),
      ]);
    }
    if (!opts.names) {
      const left = await prisma.listing.count({
        where: { storeId: store.id, customName: { startsWith: E2E_LISTING_PREFIX } },
      });
      if (left > 0) throw new Error(`e2e teardown: ${left} "${E2E_LISTING_PREFIX}" listings survived cleanup`);
    }
    return ids.length;
  } finally {
    await prisma.$disconnect();
  }
}
