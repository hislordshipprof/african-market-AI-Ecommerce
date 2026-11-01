import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Reads the audit rows for one listing straight from the database, scoped to
 * the store the way the app does (RLS role plus app.store_id), so an e2e test
 * can prove an action was audited instead of trusting the UI.
 */
export async function findListingAuditLogs(storeSlug: string, listingName: string) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DIRECT_URL is required for e2e audit queries");
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: storeSlug } });
    const [, , listing, logs] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`,
      prisma.listing.findFirst({ where: { storeId: store.id, customName: listingName } }),
      prisma.auditLog.findMany({
        where: { storeId: store.id, entityType: "listing" },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    if (!listing) return [];
    return logs.filter((l) => l.entityId === listing.id);
  } finally {
    await prisma.$disconnect();
  }
}
