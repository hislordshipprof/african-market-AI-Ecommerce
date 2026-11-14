import { platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { toCsv } from "../analytics/csv";
import { listingLabel } from "./cards";
import { QUANTITY_MAX } from "./types";

export const LEAD_DAYS_MAX = 90;
export const COVER_DAYS_MAX = 90;
export const REORDER_LINES_MAX = 500;
export const NO_COUNT = "reorder (no count)";

export interface ReorderLine {
  listingId: string;
  /** Null keeps a status listing as "reorder (no count)"; 0 leaves the item off the list. */
  quantity: number | null;
}

export interface SavedReorderList {
  savedAt: Date;
  items: Array<{ listingId: string; name: string; quantity: number | null }>;
}

export type SaveResult = { ok: true } | { ok: false; message: string };

const refuse = (message: string): SaveResult => ({ ok: false, message });

/** Lead time 0 to 90 days and cover 1 to 90 days, with an audit row. */
export async function setReorderDays(
  storeId: string,
  days: { leadDays: number; coverDays: number },
  actor: { id: string; email: string },
): Promise<void> {
  const { leadDays, coverDays } = days;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > LEAD_DAYS_MAX) throw new Error("lead time out of range");
  if (!Number.isInteger(coverDays) || coverDays < 1 || coverDays > COVER_DAYS_MAX) throw new Error("cover out of range");
  await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { reorderLeadDays: true, reorderCoverDays: true } });
    if (!before || (before.reorderLeadDays === leadDays && before.reorderCoverDays === coverDays)) return;
    await tx.store.update({ where: { id: storeId }, data: { reorderLeadDays: leadDays, reorderCoverDays: coverDays } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.reorder_days",
        entityType: "store",
        entityId: storeId,
        before: { leadDays: before.reorderLeadDays, coverDays: before.reorderCoverDays },
        after: { leadDays, coverDays },
      },
    });
  });
}

/** Replaces the store's one draft reorder list. Writes no stock and orders nothing. */
export async function saveReorderList(
  storeId: string,
  lines: ReorderLine[],
  actor: { id: string; email: string },
): Promise<SaveResult> {
  if (lines.length > REORDER_LINES_MAX) return refuse(`At most ${REORDER_LINES_MAX} items.`);
  for (const line of lines) {
    const q = line.quantity;
    if (q !== null && (!Number.isInteger(q) || q < 0 || q > QUANTITY_MAX)) return refuse("Whole numbers only.");
  }
  if (new Set(lines.map((line) => line.listingId)).size !== lines.length) return refuse("An item is listed twice.");
  const kept = lines.filter((line) => line.quantity !== 0);
  if (kept.length === 0) return refuse("Nothing to save. Every quantity is 0.");

  const listings = await storeScoped(storeId).listing.findMany({
    where: { id: { in: kept.map((line) => line.listingId) }, active: true },
    select: { id: true, customName: true, stockMode: true, masterProduct: { select: { name: true } } },
  });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  for (const line of kept) {
    const listing = byId.get(line.listingId);
    if (!listing) return refuse("An item is no longer in your store. Reload the page.");
    if (line.quantity === null && listing.stockMode === "counted") return refuse(`Enter a quantity for ${listingLabel(listing)}.`);
  }

  await storeScopedTransaction(storeId, async (tx) => {
    const list = await tx.reorderList.upsert({
      where: { storeId },
      create: { storeId, savedById: actor.id },
      update: { savedById: actor.id, updatedAt: new Date() },
    });
    await tx.reorderListItem.deleteMany({ where: { listId: list.id } });
    await tx.reorderListItem.createMany({
      data: kept.map((line, position) => ({
        listId: list.id,
        storeId,
        listingId: line.listingId,
        name: listingLabel(byId.get(line.listingId)!),
        quantity: line.quantity,
        position,
      })),
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.reorder_list",
        entityType: "reorder_list",
        entityId: list.id,
        after: { items: kept.map((line) => ({ listingId: line.listingId, quantity: line.quantity })) },
      },
    });
  });
  return { ok: true };
}

export async function loadReorderList(storeId: string): Promise<SavedReorderList | null> {
  const list = await storeScoped(storeId).reorderList.findUnique({
    where: { storeId },
    select: {
      updatedAt: true,
      items: { orderBy: { position: "asc" }, select: { listingId: true, name: true, quantity: true } },
    },
  });
  return list ? { savedAt: list.updatedAt, items: list.items } : null;
}

const quantityText = (quantity: number | null) => (quantity === null ? NO_COUNT : String(quantity));

export function reorderCsv(list: Pick<SavedReorderList, "items">): string {
  return toCsv([["Item", "Quantity"], ...list.items.map((item) => [item.name, quantityText(item.quantity)])]);
}

/** Plain text to paste into a message to a wholesaler. */
export function reorderText(list: Pick<SavedReorderList, "items">, storeName: string): string {
  return [`Reorder list for ${storeName}`, ...list.items.map((item) => `${item.name}: ${quantityText(item.quantity)}`)].join("\n");
}
