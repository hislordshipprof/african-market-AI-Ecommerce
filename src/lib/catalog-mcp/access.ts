import { platformAdminTransaction } from "../db";
import { revalidateStore } from "../get-store";
import type { ListingResult } from "../directory/listing";

/** The owner's "Let AI assistants read my catalog" switch (#572), with an audit row. */
export async function saveAiCatalogAccess(
  storeId: string,
  readable: boolean,
  actor: { id: string; email: string },
): Promise<ListingResult> {
  const store = await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({
      where: { id: storeId },
      select: { id: true, slug: true, customDomain: true, aiCatalogReadable: true },
    });
    if (!before || before.aiCatalogReadable === readable) return before;
    await tx.store.update({ where: { id: storeId }, data: { aiCatalogReadable: readable } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.ai_catalog_access",
        entityType: "store",
        entityId: storeId,
        before: { aiCatalogReadable: before.aiCatalogReadable },
        after: { aiCatalogReadable: readable },
      },
    });
    return before;
  });
  if (!store) return { ok: false, message: "Store not found." };
  // The MCP endpoint reads the cached store row; clear it so the switch applies at once.
  revalidateStore(store);
  return { ok: true };
}
