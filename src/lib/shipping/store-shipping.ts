import { platformAdminTransaction } from "../db";

export const HANDLING_DAYS_MAX = 10;

export type StoreShippingResult = { ok: true } | { ok: false; message: string };

/** The store opts in to shipping with its handling days, or opts out with null (#567). Only this store's row changes. */
export async function saveStoreShipping(
  storeId: string,
  handlingDays: number | null,
  actor: { id: string; email: string },
): Promise<StoreShippingResult> {
  if (handlingDays !== null && (!Number.isInteger(handlingDays) || handlingDays < 1 || handlingDays > HANDLING_DAYS_MAX)) {
    return { ok: false, message: `Handling time is 1 to ${HANDLING_DAYS_MAX} business days.` };
  }
  return platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { shippingHandlingDays: true } });
    if (!before) return { ok: false as const, message: "Store not found." };
    if (before.shippingHandlingDays === handlingDays) return { ok: true as const };
    await tx.store.update({ where: { id: storeId }, data: { shippingHandlingDays: handlingDays } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.shipping",
        entityType: "store",
        entityId: storeId,
        before: { shippingHandlingDays: before.shippingHandlingDays },
        after: { shippingHandlingDays: handlingDays },
      },
    });
    return { ok: true as const };
  });
}
