import { Prisma, storeScoped, storeScopedTransaction, lockListingRow } from "../db";

export type StockMode = "counted" | "status";
export type StockStatus = "in_stock" | "low" | "out_of_stock";
export type StockEventType = "sale" | "recount" | "restock" | "short" | "adjust";

export interface CreateVariantInput {
  label: string;
  price: number;
  weightG: number;
  sku?: string | null;
  barcode?: string | null;
}

/** The signed-in user performing a listing mutation, recorded in audit rows. */
export interface Actor {
  id: string;
  email: string;
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
}

export async function createListing(input: CreateListingInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    let listing;
    try {
      listing = await tx.listing.create({
        data: {
          storeId: input.storeId,
          masterProductId: input.masterProductId ?? null,
          customName: input.customName ?? null,
          price: input.price,
          stockMode: input.stockMode,
          qty: input.stockMode === "counted" ? (input.qty ?? 0) : null,
          status: input.stockMode === "status" ? (input.status ?? "in_stock") : null,
          frozen: input.frozen,
          perishable: input.perishable,
          maxPerOrder: input.maxPerOrder ?? null,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new Error("This product is already listed in your store.");
      }
      throw e;
    }

    const variants = await createVariantRows(tx, listing.id, input.variants);

    if (input.stockMode === "counted" && (input.qty ?? 0) > 0) {
      await tx.stockEvent.create({
        data: {
          storeId: input.storeId,
          listingId: listing.id,
          type: "recount",
          delta: input.qty!,
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
        },
      },
    });

    return { ...listing, variants };
  });
}

export interface UpdateListingInput {
  storeId: string;
  listingId: string;
  customName?: string | null;
  masterProductId?: string | null;
  price?: number;
  stockMode?: StockMode;
  qty?: number | null;
  status?: StockStatus | null;
  frozen?: boolean;
  perishable?: boolean;
  maxPerOrder?: number | null;
  actor: Actor;
  variants?: CreateVariantInput[];
}

export async function updateListing(input: UpdateListingInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    await lockListingRow(tx, input.listingId);

    const existing = await tx.listing.findUniqueOrThrow({
      where: { id: input.listingId },
    });

    const data: Record<string, unknown> = {};
    if (input.customName !== undefined) data.customName = input.customName;
    if (input.masterProductId !== undefined) data.masterProductId = input.masterProductId;
    if (input.price !== undefined) data.price = input.price;
    if (input.stockMode !== undefined) data.stockMode = input.stockMode;
    if (input.frozen !== undefined) data.frozen = input.frozen;
    if (input.perishable !== undefined) data.perishable = input.perishable;
    if (input.maxPerOrder !== undefined) data.maxPerOrder = input.maxPerOrder;

    const resolvedStockMode = input.stockMode ?? existing.stockMode;
    const modeChanged = input.stockMode !== undefined && input.stockMode !== existing.stockMode;

    if (resolvedStockMode === "counted") {
      if (input.qty !== undefined) data.qty = input.qty;
      if (modeChanged) data.status = null;
    }
    if (resolvedStockMode === "status") {
      if (input.status !== undefined) data.status = input.status;
      if (modeChanged) data.qty = null;
    }

    const updated = await tx.listing.update({
      where: { id: input.listingId },
      data,
    });

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

    const stockChanged =
      (resolvedStockMode === "counted" && input.qty !== undefined && input.qty !== existing.qty) ||
      (resolvedStockMode === "status" && input.status !== undefined && input.status !== existing.status);

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

      if (resolvedStockMode === "counted" && input.qty !== undefined) {
        const delta = (input.qty ?? 0) - (existing.qty ?? 0);
        await tx.stockEvent.create({
          data: {
            storeId: input.storeId,
            listingId: input.listingId,
            type: "adjust",
            delta,
            actorId: input.actor.id,
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
          },
        });
      }
    }

    if (input.variants) {
      const existingVariants = await tx.listingVariant.findMany({
        where: { listingId: input.listingId },
      });

      await tx.listingVariant.deleteMany({ where: { listingId: input.listingId } });
      await createVariantRows(tx, input.listingId, input.variants);

      const oldPrices = sortedPrices(existingVariants);
      const newPrices = sortedPrices(input.variants);
      const pricesChanged = variantPricesDiffer(oldPrices, newPrices);

      if (pricesChanged) {
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
    }

    return updated;
  });
}

async function setListingActive(
  storeId: string,
  listingId: string,
  active: boolean,
  actor: Actor,
) {
  return storeScopedTransaction(storeId, async (tx) => {
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
  });
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
  variants: (CreateVariantInput & { id?: string })[];
  actor: Actor;
}

export async function updateVariants(input: UpdateVariantsInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    const existingVariants = await tx.listingVariant.findMany({
      where: { listingId: input.listingId },
    });

    await tx.listingVariant.deleteMany({ where: { listingId: input.listingId } });
    const created = await createVariantRows(tx, input.listingId, input.variants);

    const oldPrices = sortedPrices(existingVariants);
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

    return created;
  });
}
