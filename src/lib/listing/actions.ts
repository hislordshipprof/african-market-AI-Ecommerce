"use server";
import { revalidateStorefront } from "../storefront/cache";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseVariantsJson } from "./parse-variants";
import {
  createListing,
  updateListing,
  deactivateListing,
  reactivateListing,
  listMasterProducts,
  type Actor,
  type StockMode,
  type StockStatus,
} from "./service";
import { parseInput, readFormFields } from "../security/parse-input";

const listingField = z.string().max(500).nullable();
const listingFormSchema = z.strictObject({
  customName: listingField,
  masterProductId: listingField,
  price: z.string().max(40).nullable(),
  stockMode: z.string().max(20).nullable(),
  qty: z.string().max(20).nullable(),
  status: z.string().max(40).nullable(),
  frozen: z.string().max(10).nullable(),
  perishable: z.string().max(10).nullable(),
  maxPerOrder: z.string().max(20).nullable(),
  variants: z.string().max(200_000).nullable(),
  listingId: z.string().max(200).nullable(),
});
const LISTING_FIELDS = [
  "customName",
  "masterProductId",
  "price",
  "stockMode",
  "qty",
  "status",
  "frozen",
  "perishable",
  "maxPerOrder",
  "variants",
  "listingId",
] as const;
const MAX_VARIANTS = 50;

function readListingForm(formData: FormData) {
  const parsed = parseInput(listingFormSchema, readFormFields(formData, LISTING_FIELDS));
  if (!parsed.ok) return null;
  return parsed.data;
}

const VALID_STOCK_MODES = new Set<string>(["counted", "status"]);

function toActor(user: { id: string; email: string }): Actor {
  return { id: user.id, email: user.email };
}

export async function createListingAction(formData: FormData) {
  const session = await requireStoreOwner();
  const fields = readListingForm(formData);
  if (!fields) return { error: "Valid non-negative price is required" };

  const customName = fields.customName;
  const masterProductId = fields.masterProductId;
  const priceRaw = fields.price;
  const stockMode = fields.stockMode ?? "counted";
  const qtyRaw = fields.qty;
  const status = fields.status;
  const frozen = fields.frozen === "true";
  const perishable = fields.perishable === "true";
  const maxPerOrderRaw = fields.maxPerOrder;
  const variantsJson = fields.variants;

  if (!customName && !masterProductId) {
    return { error: "Product name or master product is required" };
  }
  const price = Number(priceRaw);
  if (!priceRaw || !isFinite(price) || price < 0 || !Number.isInteger(price)) {
    return { error: "Valid non-negative price is required" };
  }
  if (!VALID_STOCK_MODES.has(stockMode)) {
    return { error: "Stock mode must be 'counted' or 'status'" };
  }
  const qty = stockMode === "counted" ? Number(qtyRaw ?? 0) : null;
  if (qty !== null && (!isFinite(qty) || qty < 0)) {
    return { error: "Quantity must be a non-negative number" };
  }

  try {
    const variants = parseVariantsJson(variantsJson);
    if (variants.length === 0) {
      return { error: "At least one variant is required" };
    }
    if (variants.length > MAX_VARIANTS) {
      return { error: "Too many variants" };
    }

    const result = await createListing({
      storeId: session.store.id,
      customName: customName || null,
      masterProductId: masterProductId || null,
      price,
      stockMode: stockMode as StockMode,
      qty,
      status: stockMode === "status" ? ((status as StockStatus) ?? "in_stock") : null,
      frozen,
      perishable,
      maxPerOrder: maxPerOrderRaw ? Number(maxPerOrderRaw) : null,
      variants,
      actor: toActor(session.user),
    });
    revalidateStorefront(session.store.id);
    return { success: true, id: result.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create listing";
    return { error: message };
  }
}

export async function updateListingAction(formData: FormData) {
  const session = await requireStoreOwner();
  const fields = readListingForm(formData);
  if (!fields) return { error: "Valid non-negative price is required" };

  const listingId = fields.listingId;
  if (!listingId) return { error: "Listing ID is required" };

  const customName = fields.customName;
  const masterProductId = fields.masterProductId;
  const priceRaw = fields.price;
  const stockMode = fields.stockMode;
  const qtyRaw = fields.qty;
  const status = fields.status;
  const frozen = fields.frozen;
  const perishable = fields.perishable;
  const maxPerOrderRaw = fields.maxPerOrder;
  const variantsJson = fields.variants;

  if (customName !== null && !customName.trim() && !masterProductId) {
    return { error: "Product name is required" };
  }
  if (priceRaw !== null) {
    const p = Number(priceRaw);
    if (!isFinite(p) || p < 0 || !Number.isInteger(p)) return { error: "Valid non-negative price is required" };
  }
  if (stockMode !== null && !VALID_STOCK_MODES.has(stockMode)) {
    return { error: "Stock mode must be 'counted' or 'status'" };
  }
  if (qtyRaw !== null) {
    const q = Number(qtyRaw);
    if (!isFinite(q) || q < 0) return { error: "Quantity must be a non-negative number" };
  }

  let parsedVariants: ReturnType<typeof parseVariantsJson> | undefined;
  if (variantsJson !== null) {
    try {
      parsedVariants = parseVariantsJson(variantsJson);
      if (parsedVariants.length === 0) {
        return { error: "At least one variant is required" };
      }
      if (parsedVariants.length > MAX_VARIANTS) {
        return { error: "Too many variants" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid variants";
      return { error: message };
    }
  }

  try {
    const updated = await updateListing({
      storeId: session.store.id,
      listingId,
      ...(customName !== null && { customName: customName.trim() || null }),
      ...(masterProductId !== null && { masterProductId: masterProductId || null }),
      ...(priceRaw !== null && { price: Number(priceRaw) }),
      ...(stockMode !== null && { stockMode: stockMode as StockMode }),
      ...(qtyRaw !== null && { qty: Number(qtyRaw) }),
      ...(status !== null && { status: status as StockStatus }),
      ...(frozen !== null && { frozen: frozen === "true" }),
      ...(perishable !== null && { perishable: perishable === "true" }),
      ...(maxPerOrderRaw !== null && { maxPerOrder: maxPerOrderRaw ? Number(maxPerOrderRaw) : null }),
      actor: toActor(session.user),
      variants: parsedVariants,
    });

    revalidateStorefront(session.store.id);
    return { success: true, id: updated.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update listing";
    return { error: message };
  }
}

export async function deactivateListingAction(listingId: string) {
  const session = await requireStoreOwner();
  const id = parseInput(z.string().min(1).max(200), listingId);
  if (!id.ok) return { error: "Listing ID is required" };

  try {
    await deactivateListing(
      session.store.id,
      id.data,
      toActor(session.user),
    );
    revalidateStorefront(session.store.id);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to deactivate listing";
    return { error: message };
  }
}

export async function reactivateListingAction(listingId: string) {
  const session = await requireStoreOwner();
  const id = parseInput(z.string().min(1).max(200), listingId);
  if (!id.ok) return { error: "Listing ID is required" };

  try {
    await reactivateListing(
      session.store.id,
      id.data,
      toActor(session.user),
    );
    revalidateStorefront(session.store.id);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reactivate listing";
    return { error: message };
  }
}

export async function listMasterProductsAction(query?: string) {
  await requireStoreOwner();
  const parsed = parseInput(z.string().max(1_000).optional(), query);
  if (!parsed.ok) return [];
  const safeQuery = parsed.data?.slice(0, 100);
  const products = await listMasterProducts(safeQuery, 50);
  return products.map((p) => ({ id: p.id, name: p.name }));
}
