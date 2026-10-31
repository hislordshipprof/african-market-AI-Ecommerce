import { storeScoped, storeScopedTransaction } from "../db";

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
  actorId: string;
  actorEmail: string;
}

export async function createListing(input: CreateListingInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    const listing = await tx.listing.create({
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

    const variants = await Promise.all(
      input.variants.map((v) =>
        tx.listingVariant.create({
          data: {
            listingId: listing.id,
            label: v.label,
            price: v.price,
            weightG: v.weightG,
            sku: v.sku ?? null,
            barcode: v.barcode ?? null,
          },
        }),
      ),
    );

    if (input.stockMode === "counted" && (input.qty ?? 0) > 0) {
      await tx.stockEvent.create({
        data: {
          storeId: input.storeId,
          listingId: listing.id,
          type: "recount",
          delta: input.qty!,
          actorId: input.actorId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
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
  actorId: string;
  actorEmail: string;
}

export async function updateListing(input: UpdateListingInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
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
    if (resolvedStockMode === "counted" && input.qty !== undefined) {
      data.qty = input.qty;
    }
    if (resolvedStockMode === "status" && input.status !== undefined) {
      data.status = input.status;
    }

    const updated = await tx.listing.update({
      where: { id: input.listingId },
      data,
    });

    if (input.price !== undefined && input.price !== existing.price) {
      await tx.auditLog.create({
        data: {
          storeId: input.storeId,
          actorId: input.actorId,
          actorEmail: input.actorEmail,
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
          actorId: input.actorId,
          actorEmail: input.actorEmail,
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
            actorId: input.actorId,
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
            actorId: input.actorId,
          },
        });
      }
    }

    return updated;
  });
}

export async function deactivateListing(
  storeId: string,
  listingId: string,
  actorId: string,
  actorEmail: string,
) {
  return storeScopedTransaction(storeId, async (tx) => {
    const updated = await tx.listing.update({
      where: { id: listingId },
      data: { active: false },
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        actorEmail,
        action: "listing.deactivate",
        entityType: "listing",
        entityId: listingId,
        before: { active: true },
        after: { active: false },
      },
    });

    return updated;
  });
}

export async function reactivateListing(
  storeId: string,
  listingId: string,
  actorId: string,
  actorEmail: string,
) {
  return storeScopedTransaction(storeId, async (tx) => {
    const updated = await tx.listing.update({
      where: { id: listingId },
      data: { active: true },
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        actorEmail,
        action: "listing.reactivate",
        entityType: "listing",
        entityId: listingId,
        before: { active: false },
        after: { active: true },
      },
    });

    return updated;
  });
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

export async function listMasterProducts() {
  const { masterProduct } = await import("../db").then((m) => m.platformAdmin);
  return masterProduct.findMany({
    orderBy: { name: "asc" },
  });
}

export interface UpdateVariantsInput {
  storeId: string;
  listingId: string;
  variants: (CreateVariantInput & { id?: string })[];
}

export async function updateVariants(input: UpdateVariantsInput) {
  return storeScopedTransaction(input.storeId, async (tx) => {
    await tx.listingVariant.deleteMany({ where: { listingId: input.listingId } });

    return Promise.all(
      input.variants.map((v) =>
        tx.listingVariant.create({
          data: {
            listingId: input.listingId,
            label: v.label,
            price: v.price,
            weightG: v.weightG,
            sku: v.sku ?? null,
            barcode: v.barcode ?? null,
          },
        }),
      ),
    );
  });
}
