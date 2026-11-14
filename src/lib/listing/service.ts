import { Prisma } from "@prisma/client";
import { storeScoped, storeScopedTransaction, lockStoreRow, lockListingRow, lockListingVariantRows } from "../db";

export type StockMode = "counted" | "status";
export type StockStatus = "in_stock" | "low" | "out_of_stock";
export type StockEventType = "sale" | "recount" | "restock" | "short" | "adjust" | "counter_sale";

export interface ResolvedStock {
  stockMode: StockMode;
  qty: number | null;
  status: StockStatus | null;
}

export function resolveStockMode(input: {
  stockMode?: string;
  hasQtyColumn: boolean;
  qty?: number;
  status?: string;
}): ResolvedStock {
  const explicit =
    input.stockMode !== undefined && isStockMode(input.stockMode) ? input.stockMode : undefined;
  // A cell the owner filled wins over the file-level fallback. Qty 0 is filled in.
  const mode: StockMode = explicit
    ? explicit
    : input.qty !== undefined
      ? "counted"
      : input.status
        ? "status"
        : input.hasQtyColumn
          ? "counted"
          : "status";

  if (mode === "counted") {
    return { stockMode: "counted", qty: input.qty ?? 0, status: null };
  }
  return {
    stockMode: "status",
    qty: null,
    status: input.status !== undefined && isStockStatus(input.status) ? input.status : "in_stock",
  };
}

export interface CreateVariantInput {
  label: string;
  price: number;
  weightG: number;
  sku?: string | null;
  barcode?: string | null;
  /** The weight is a stand-in the owner still has to set (no known weight). */
  weightPlaceholder?: boolean;
}

/** A variant row on a save. `id` is set when the row already belongs to this listing. */
export interface SaveVariantInput extends CreateVariantInput {
  id?: string;
}

/** The signed-in user performing a listing mutation, recorded in audit rows. */
export interface Actor {
  id: string;
  email: string;
}

/** The only stock modes a listing form or a CSV `stock_mode` cell may name. */
export const VALID_STOCK_MODES = new Set<string>(["counted", "status"]);

/** The only status cells a CSV `status` column or `resolveStockMode()` may keep. */
export const VALID_STOCK_STATUSES = new Set<string>(["in_stock", "low", "out_of_stock"]);

export function isStockMode(value: string): value is StockMode {
  return VALID_STOCK_MODES.has(value);
}

export function isStockStatus(value: string): value is StockStatus {
  return VALID_STOCK_STATUSES.has(value);
}

export function toActor(user: { id: string; email: string }): Actor {
  return { id: user.id, email: user.email };
}

type ListingTx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/** Inserts variant rows for a listing. Shared by create, update and updateVariants. */
async function createVariantRows(
  tx: ListingTx,
  listingId: string,
  variants: CreateVariantInput[],
) {
  return Promise.all(
    variants.map((v) =>
      tx.listingVariant.create({
        data: {
          listingId,
          label: v.label,
          price: v.price,
          weightG: v.weightG,
          weightPlaceholder: v.weightPlaceholder ?? false,
          sku: v.sku ?? null,
          barcode: v.barcode ?? null,
        },
      }),
    ),
  );
}

type VariantPriceRow = { label: string; price: number };

function sortedPrices(rows: VariantPriceRow[]): VariantPriceRow[] {
  return rows
    .map((v) => ({ label: v.label, price: v.price }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function variantPricesDiffer(before: VariantPriceRow[], after: VariantPriceRow[]): boolean {
  return (
    before.length !== after.length ||
    before.some((old, i) => old.label !== after[i]?.label || old.price !== after[i]?.price)
  );
}

export interface CreateListingInput {
  storeId: string;
  masterProductId?: string | null;
  customName?: string | null;
  price: number;
  stockMode: StockMode;
  qty?: number | null;
  status?: StockStatus | null;
  frozen: boolean;
  perishable: boolean;
  maxPerOrder?: number | null;
  variants: CreateVariantInput[];
  actor: Actor;
  /** Where the listing came from, recorded on its audit row (e.g. `photo_draft`). */
  source?: string;
}

export async function createListing(input: CreateListingInput) {
  return storeScopedTransaction(input.storeId, (tx) => createListingInTransaction(tx, input));
}

/** The listing, its variants, a recount event and one `listing.create` audit row, inside the caller's transaction. */
export async function createListingInTransaction(tx: ListingTx, input: CreateListingInput) {
  const stock = resolveStockMode({
    stockMode: input.stockMode,
    hasQtyColumn: input.stockMode === "counted",
    qty: input.qty ?? undefined,
    status: input.status ?? undefined,
  });

  const listing = await tx.listing.create({
    data: {
      storeId: input.storeId,
      masterProductId: input.masterProductId ?? null,
      customName: input.customName ?? null,
      price: input.price,
      stockMode: stock.stockMode,
      qty: stock.qty,
      status: stock.status,
      frozen: input.frozen,
      perishable: input.perishable,
      maxPerOrder: input.maxPerOrder ?? null,
    },
  });

  const variants = await createVariantRows(tx, listing.id, input.variants);

  if (stock.stockMode === "counted" && (stock.qty ?? 0) > 0) {
    await tx.stockEvent.create({
      data: {
        storeId: input.storeId,
        listingId: listing.id,
        type: "recount",
        delta: stock.qty!,
        actorId: input.actor.id,
      },
    });
  }

  await tx.auditLog.create({
    data: {
      storeId: input.storeId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      action: "listing.create",
      entityType: "listing",
      entityId: listing.id,
      after: {
        customName: listing.customName,
        masterProductId: listing.masterProductId,
        price: listing.price,
        stockMode: listing.stockMode,
        qty: listing.qty,
        status: listing.status,
        frozen: listing.frozen,
        perishable: listing.perishable,
        ...(input.source ? { source: input.source } : {}),
      },
    },
  });

  return { ...listing, variants };
}

export interface UpdateListingInput {
  storeId: string;
  listingId: string;
  customName?: string | null;
  masterProductId?: string | null;
  price?: number;
  stockMode?: StockMode;
  qty?: number | null;
  /** The qty the edit form loaded. `qty` equal to it means the owner did not change the number. */
  qtyLoaded?: number;
  status?: StockStatus | null;
  frozen?: boolean;
  perishable?: boolean;
  maxPerOrder?: number | null;
  actor: Actor;
  variants?: SaveVariantInput[];
}

/** These queue behind checkout and CSV commit on the store lock, so Prisma's 5-second default is too short. */
const LISTING_WRITE_TRANSACTION = { timeout: 20_000, maxWait: 8_000 };

export async function updateListing(input: UpdateListingInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    await lockStoreRow(tx, input.storeId);
    await lockListingRow(tx, input.listingId);

    const existing = await tx.listing.findUnique({
      where: { id: input.listingId },
    });
    if (!existing) throw new Error("Listing not found");

    const modeChanged = input.stockMode !== undefined && input.stockMode !== existing.stockMode;
    // The number this form loaded coming back is not a count: an order may have moved qty since.
    const requestedQty = !modeChanged && input.qty === input.qtyLoaded ? undefined : input.qty;

    const data: Record<string, unknown> = {};
    if (input.customName !== undefined) data.customName = input.customName;
    if (input.masterProductId !== undefined) data.masterProductId = input.masterProductId;
    if (input.price !== undefined) data.price = input.price;
    if (input.stockMode !== undefined) data.stockMode = input.stockMode;
    if (input.frozen !== undefined) data.frozen = input.frozen;
    if (input.perishable !== undefined) data.perishable = input.perishable;
    if (input.maxPerOrder !== undefined) data.maxPerOrder = input.maxPerOrder;

    const resolvedStockMode = input.stockMode ?? existing.stockMode;

    if (resolvedStockMode === "counted") {
      if (requestedQty !== undefined) data.qty = requestedQty;
      if (modeChanged) data.status = null;
    }
    if (resolvedStockMode === "status") {
      if (input.status !== undefined) data.status = input.status;
      if (modeChanged) data.qty = null;
    }

    const stockChanged =
      (resolvedStockMode === "counted" && requestedQty !== undefined && requestedQty !== existing.qty) ||
      (resolvedStockMode === "status" && input.status !== undefined && input.status !== existing.status);

    // Read after the store lock, so a count taken while an order waits is newer than that order's reservation.
    const now = new Date();
    if (stockChanged) {
      data.confidence = 1.0;
      data.confidenceUpdatedAt = now;
    }

    const listing = await tx.listing.update({
      where: { id: input.listingId },
      data,
    });
    // Orders moved the count after the form loaded it. The owner is told, whichever number won.
    const stockMoved = resolvedStockMode === "counted" && !modeChanged && input.qtyLoaded !== undefined
      && existing.qty !== null && existing.qty !== input.qtyLoaded
      ? { from: input.qtyLoaded, to: existing.qty }
      : null;
    const updated = { ...listing, stockMoved };

    if (input.price !== undefined && input.price !== existing.price) {
      await tx.auditLog.create({
        data: {
          storeId: input.storeId,
          actorId: input.actor.id,
          actorEmail: input.actor.email,
          action: "listing.price_change",
          entityType: "listing",
          entityId: input.listingId,
          before: { price: existing.price },
          after: { price: input.price },
        },
      });
    }

    if (stockChanged) {
      const beforeStock = existing.stockMode === "counted"
        ? { qty: existing.qty }
        : { status: existing.status };
      const afterStock = resolvedStockMode === "counted"
        ? { qty: updated.qty }
        : { status: updated.status };

      await tx.auditLog.create({
        data: {
          storeId: input.storeId,
          actorId: input.actor.id,
          actorEmail: input.actor.email,
          action: "listing.stock_change",
          entityType: "listing",
          entityId: input.listingId,
          before: beforeStock,
          after: afterStock,
        },
      });

      if (resolvedStockMode === "counted" && requestedQty !== undefined) {
        const delta = (requestedQty ?? 0) - (existing.qty ?? 0);
        await tx.stockEvent.create({
          data: {
            storeId: input.storeId,
            listingId: input.listingId,
            type: "adjust",
            delta,
            actorId: input.actor.id,
            createdAt: now,
          },
        });
      }

      if (resolvedStockMode === "status") {
        await tx.stockEvent.create({
          data: {
            storeId: input.storeId,
            listingId: input.listingId,
            type: "adjust",
            delta: 0,
            actorId: input.actor.id,
            createdAt: now,
          },
        });
      }
    }

    if (input.variants !== undefined) {
      await saveVariantsInPlace(tx, {
        storeId: input.storeId,
        listingId: input.listingId,
        variants: input.variants,
        actor: input.actor,
      });
    }

    return updated;
  }, LISTING_WRITE_TRANSACTION);
}

async function setListingActive(
  storeId: string,
  listingId: string,
  active: boolean,
  actor: Actor,
) {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const existing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });

    const updated = await tx.listing.update({
      where: { id: listingId },
      data: { active },
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: active ? "listing.reactivate" : "listing.deactivate",
        entityType: "listing",
        entityId: listingId,
        before: { active: existing.active },
        after: { active },
      },
    });

    return updated;
  }, LISTING_WRITE_TRANSACTION);
}

export async function deactivateListing(storeId: string, listingId: string, actor: Actor) {
  return setListingActive(storeId, listingId, false, actor);
}

export async function reactivateListing(storeId: string, listingId: string, actor: Actor) {
  return setListingActive(storeId, listingId, true, actor);
}

export async function listListings(storeId: string, includeInactive = false) {
  const scoped = storeScoped(storeId);
  return scoped.listing.findMany({
    where: includeInactive ? {} : { active: true },
    include: { variants: true, masterProduct: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getListing(storeId: string, listingId: string) {
  const scoped = storeScoped(storeId);
  return scoped.listing.findUnique({
    where: { id: listingId },
    include: { variants: true, masterProduct: true },
  });
}

export const MASTER_PRODUCT_PAGE_SIZE = 50;

/** Prisma `contains` passes the term to LIKE unescaped, so `%`, `_` and `\` would act as wildcards/escapes. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

export async function listMasterProducts(query?: string, take = MASTER_PRODUCT_PAGE_SIZE) {
  const { masterProduct } = await import("../db").then((m) => m.platformAdmin);
  const term = query?.trim();
  return masterProduct.findMany({
    where: term ? { name: { contains: escapeLike(term), mode: "insensitive" } } : undefined,
    orderBy: { name: "asc" },
    take: Math.min(Math.max(1, Math.floor(take)), MASTER_PRODUCT_PAGE_SIZE),
  });
}

export interface UpdateVariantsInput {
  storeId: string;
  listingId: string;
  variants: SaveVariantInput[];
  actor: Actor;
}

export async function updateVariants(input: UpdateVariantsInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    return saveVariantsInPlace(tx, input);
  }, LISTING_WRITE_TRANSACTION);
}

const CANT_REMOVE = (label: string) =>
  `"${label}" is in a customer's cart or an order, so it can't be removed.`;

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

/**
 * Updates, creates and deletes variants inside the caller's transaction.
 * The caller already holds the store and listing locks when this runs from
 * updateListing; updateVariants enters here with neither, so both are taken again
 * (same transaction: a no-op if already held).
 */
async function saveVariantsInPlace(
  tx: ListingTx,
  input: {
    storeId: string;
    listingId: string;
    variants: SaveVariantInput[];
    actor: Actor;
  },
) {
  if (input.variants.length === 0) {
    throw new Error("At least one variant is required");
  }

  await lockStoreRow(tx, input.storeId);
  await lockListingRow(tx, input.listingId);
  const listing = await tx.listing.findUnique({ where: { id: input.listingId } });
  if (!listing) throw new Error("Listing not found");

  const existing = await tx.listingVariant.findMany({
    where: { listingId: input.listingId },
  });
  const byId = new Map(existing.map((variant) => [variant.id, variant]));

  const seen = new Set<string>();
  for (const variant of input.variants) {
    if (!variant.id) continue;
    if (seen.has(variant.id)) throw new Error("A variant appears twice in this save.");
    seen.add(variant.id);
    if (!byId.has(variant.id)) throw new Error("Variant not found");
  }

  const removed = existing
    .filter((variant) => !seen.has(variant.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (removed.length > 0) {
    const removedIds = removed.map((variant) => variant.id);
    await lockListingVariantRows(tx, removedIds);
    const removedSet = new Set(removedIds);
    const [cartRefs, orderRefs] = await Promise.all([
      tx.cartLine.findMany({
        where: {
          OR: [
            { variantId: { in: removedIds } },
            { substituteVariantId: { in: removedIds } },
          ],
        },
        select: { variantId: true, substituteVariantId: true },
      }),
      tx.orderLine.findMany({
        where: {
          OR: [
            { listingVariantId: { in: removedIds } },
            { substituteVariantId: { in: removedIds } },
          ],
        },
        select: { listingVariantId: true, substituteVariantId: true },
      }),
    ]);
    const referenced = new Set<string>();
    for (const row of cartRefs) {
      if (removedSet.has(row.variantId)) referenced.add(row.variantId);
      if (row.substituteVariantId && removedSet.has(row.substituteVariantId)) {
        referenced.add(row.substituteVariantId);
      }
    }
    for (const row of orderRefs) {
      if (removedSet.has(row.listingVariantId)) referenced.add(row.listingVariantId);
      if (row.substituteVariantId && removedSet.has(row.substituteVariantId)) {
        referenced.add(row.substituteVariantId);
      }
    }
    const hit = removed.find((variant) => referenced.has(variant.id));
    if (hit) throw new Error(CANT_REMOVE(hit.label));
  }

  for (const variant of input.variants) {
    if (!variant.id) continue;
    await tx.listingVariant.update({
      where: { id: variant.id },
      data: {
        label: variant.label,
        price: variant.price,
        weightG: variant.weightG,
        weightPlaceholder: false,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
      },
    });
  }

  for (const variant of removed) {
    try {
      await tx.listingVariant.delete({ where: { id: variant.id } });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new Error(CANT_REMOVE(variant.label));
      throw err;
    }
  }

  for (const variant of input.variants) {
    if (variant.id) continue;
    await tx.listingVariant.create({
      data: {
        listingId: input.listingId,
        label: variant.label,
        price: variant.price,
        weightG: variant.weightG,
        weightPlaceholder: false,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
      },
    });
  }

  const oldPrices = sortedPrices(existing);
  const newPrices = sortedPrices(input.variants);
  if (variantPricesDiffer(oldPrices, newPrices)) {
    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.actor.id,
        actorEmail: input.actor.email,
        action: "listing.variant_price_change",
        entityType: "listing",
        entityId: input.listingId,
        before: { variants: oldPrices },
        after: { variants: newPrices },
      },
    });
  }

  return tx.listingVariant.findMany({ where: { listingId: input.listingId } });
}
