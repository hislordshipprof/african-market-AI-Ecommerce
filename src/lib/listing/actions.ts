"use server";
import { revalidateStorefront } from "../storefront/cache";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { INT4_MAX, ListingInputError, parseVariantsJson } from "./parse-variants";
import {
  createListing,
  updateListing,
  deactivateListing,
  reactivateListing,
  listMasterProducts,
  toActor,
  VALID_STOCK_MODES,
  isStockStatus,
  type StockMode,
  type StockStatus,
} from "./service";
import { isPreparedKind, MAX_PREP_MINUTES, type PreparedKind } from "./prepared";
import { parseInput, readFormFields } from "../security/parse-input";

const listingField = z.string().max(500).nullable();
const listingFormSchema = z.strictObject({
  customName: listingField,
  masterProductId: listingField,
  categoryId: z.string().max(200).nullable(),
  price: z.string().max(40).nullable(),
  stockMode: z.string().max(20).nullable(),
  qty: z.string().max(20).nullable(),
  qtyLoaded: z.string().max(20).nullable(),
  status: z.string().max(40).nullable(),
  frozen: z.string().max(10).nullable(),
  perishable: z.string().max(10).nullable(),
  shippable: z.string().max(10).nullable(),
  prepared: z.string().max(10).nullable(),
  prepMinutes: z.string().max(20).nullable(),
  cateringLead: z.string().max(20).nullable(),
  cateringLeadUnit: z.string().max(10).nullable(),
  cateringMinQty: z.string().max(20).nullable(),
  maxPerOrder: z.string().max(20).nullable(),
  variants: z.string().max(200_000).nullable(),
  listingId: z.string().max(200).nullable(),
});
const LISTING_FIELDS = [
  "customName",
  "masterProductId",
  "categoryId",
  "price",
  "stockMode",
  "qty",
  "qtyLoaded",
  "status",
  "frozen",
  "perishable",
  "shippable",
  "prepared",
  "prepMinutes",
  "cateringLead",
  "cateringLeadUnit",
  "cateringMinQty",
  "maxPerOrder",
  "variants",
  "listingId",
] as const;
const MAX_VARIANTS = 50;
const MAX_PER_ORDER = 999;
const MAX_PER_ORDER_ERROR = `Max per order must be a whole number, 1 to ${MAX_PER_ORDER}`;
const PRICE_ERROR = "Valid non-negative price is required";

function readListingForm(formData: FormData) {
  const parsed = parseInput(listingFormSchema, readFormFields(formData, LISTING_FIELDS));
  if (!parsed.ok) return null;
  return parsed.data;
}

/** The aisle is the owner's pick only for a custom listing; a master product brings its own. */
function aisleFor(masterProductId: string | null, categoryId: string | null): string | null {
  return masterProductId ? null : categoryId || null;
}

/** A count is a whole number the owner typed. Blank or bad input is refused, never read as 0. */
function quantityError(raw: string | null): string | null {
  if (raw === null || !raw.trim()) return "Enter a quantity";
  const q = Number(raw);
  if (!Number.isInteger(q) || q < 0 || q > INT4_MAX) return "Quantity must be a whole number, 0 or more";
  return null;
}

/**
 * The form's prepared fields: "" is grocery, "hot" or "cold" with whole prep minutes is prepared food.
 * Null when the form did not send the field.
 */
function readPrepared(
  prepared: string | null,
  prepMinutes: string | null,
): { value: { prepared: PreparedKind | null; prepMinutes: number | null } } | { error: string } | null {
  if (prepared === null) return null;
  if (prepared === "") return { value: { prepared: null, prepMinutes: null } };
  if (!isPreparedKind(prepared)) return { error: "Prepared food must be hot or cold" };
  const minutes = Number(prepMinutes ?? "");
  if (!prepMinutes?.trim() || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PREP_MINUTES) {
    return { error: `Prep time must be a whole number of minutes, 0 to ${MAX_PREP_MINUTES}` };
  }
  return { value: { prepared, prepMinutes: minutes } };
}

/**
 * The form's catering fields (#571): "" lead is not catering; else a whole lead in hours or days
 * and a minimum quantity. The service checks ranges. Null when the form did not send the field.
 */
function readCatering(
  lead: string | null,
  unit: string | null,
  minQty: string | null,
): { value: { cateringLeadHours: number | null; cateringMinQty: number | null } } | { error: string } | null {
  if (lead === null) return null;
  if (!lead.trim()) return { value: { cateringLeadHours: null, cateringMinQty: null } };
  const amount = Number(lead);
  const min = Number(minQty ?? "");
  if (!Number.isInteger(amount) || amount < 1) return { error: "Catering lead time must be a whole number" };
  if (!minQty?.trim() || !Number.isInteger(min)) return { error: "Catering minimum must be a whole number" };
  return { value: { cateringLeadHours: unit === "days" ? amount * 24 : amount, cateringMinQty: min } };
}

/** A price in whole cents that fits the database column. */
function validPrice(raw: string): boolean {
  const p = Number(raw);
  return raw.trim() !== "" && Number.isInteger(p) && p >= 0 && p <= INT4_MAX;
}

/** Blank is no limit (null); otherwise a whole number from 1 to MAX_PER_ORDER. */
function readMaxPerOrder(raw: string): { value: number | null } | { error: string } {
  if (!raw.trim()) return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_ORDER) return { error: MAX_PER_ORDER_ERROR };
  return { value: n };
}

/** The owner-facing text of a refusal; any other error's text stays on the server. */
function errorText(err: unknown, fallback: string): string {
  return err instanceof ListingInputError ? err.message : fallback;
}

/** The storefront and cart charge the variant price, so the listing price is the cheapest variant's. */
function cheapestPrice(variants: { price: number }[]): number {
  return Math.min(...variants.map((variant) => variant.price));
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
  if (priceRaw !== null && !validPrice(priceRaw)) return { error: PRICE_ERROR };
  if (!VALID_STOCK_MODES.has(stockMode)) {
    return { error: "Stock mode must be 'counted' or 'status'" };
  }
  const qtyError = stockMode === "counted" ? quantityError(qtyRaw) : null;
  if (qtyError) return { error: qtyError };
  const qty = stockMode === "counted" ? Number(qtyRaw) : null;
  const prepared = readPrepared(fields.prepared, fields.prepMinutes);
  if (prepared && "error" in prepared) return { error: prepared.error };
  const catering = readCatering(fields.cateringLead, fields.cateringLeadUnit, fields.cateringMinQty);
  if (catering && "error" in catering) return { error: catering.error };
  const maxPerOrder = maxPerOrderRaw ? readMaxPerOrder(maxPerOrderRaw) : { value: null };
  if ("error" in maxPerOrder) return { error: maxPerOrder.error };

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
      categoryId: aisleFor(masterProductId, fields.categoryId),
      price: cheapestPrice(variants),
      stockMode: stockMode as StockMode,
      qty,
      status: stockMode === "status" ? ((status as StockStatus) ?? "in_stock") : null,
      frozen,
      perishable,
      ...prepared?.value,
      ...catering?.value,
      maxPerOrder: maxPerOrder.value,
      variants,
      actor: toActor(session.user),
    });
    revalidateStorefront(session.store.id);
    return { success: true, id: result.id, ...(result.active === false && { heldForAllergens: true }) };
  } catch (err) {
    return { error: errorText(err, "Failed to create listing") };
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
  const qtyLoadedRaw = fields.qtyLoaded;
  const status = fields.status;
  const frozen = fields.frozen;
  const perishable = fields.perishable;
  const maxPerOrderRaw = fields.maxPerOrder;
  const variantsJson = fields.variants;

  if (customName !== null && !customName.trim() && !masterProductId) {
    return { error: "Product name is required" };
  }
  if (priceRaw !== null && !validPrice(priceRaw)) return { error: PRICE_ERROR };
  if (stockMode !== null && !VALID_STOCK_MODES.has(stockMode)) {
    return { error: "Stock mode must be 'counted' or 'status'" };
  }
  if (qtyRaw !== null) {
    const qtyError = quantityError(qtyRaw);
    if (qtyError) return { error: qtyError };
  }
  if (qtyLoadedRaw !== null && quantityError(qtyLoadedRaw)) {
    return { error: "Quantity must be a whole number, 0 or more" };
  }
  if (status !== null && !isStockStatus(status)) {
    return { error: "Stock status must be in stock, low or out of stock" };
  }
  const maxPerOrder = maxPerOrderRaw !== null ? readMaxPerOrder(maxPerOrderRaw) : null;
  if (maxPerOrder && "error" in maxPerOrder) return { error: maxPerOrder.error };

  const prepared = readPrepared(fields.prepared, fields.prepMinutes);
  if (prepared && "error" in prepared) return { error: prepared.error };
  const catering = readCatering(fields.cateringLead, fields.cateringLeadUnit, fields.cateringMinQty);
  if (catering && "error" in catering) return { error: catering.error };

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
      return { error: errorText(err, "Invalid variants") };
    }
  }

  try {
    const updated = await updateListing({
      storeId: session.store.id,
      listingId,
      ...(customName !== null && { customName: customName.trim() || null }),
      ...(masterProductId !== null && { masterProductId: masterProductId || null }),
      ...(fields.categoryId !== null && { categoryId: aisleFor(masterProductId, fields.categoryId) }),
      ...(parsedVariants ? { price: cheapestPrice(parsedVariants) } : priceRaw !== null && { price: Number(priceRaw) }),
      ...(stockMode !== null && { stockMode: stockMode as StockMode }),
      ...(qtyRaw !== null && { qty: Number(qtyRaw) }),
      ...(qtyLoadedRaw !== null && { qtyLoaded: Number(qtyLoadedRaw) }),
      ...(status !== null && { status: status as StockStatus }),
      ...(frozen !== null && { frozen: frozen === "true" }),
      ...(perishable !== null && { perishable: perishable === "true" }),
      ...(fields.shippable !== null && { shippable: fields.shippable === "true" }),
      ...prepared?.value,
      ...catering?.value,
      ...(maxPerOrder && { maxPerOrder: maxPerOrder.value }),
      actor: toActor(session.user),
      variants: parsedVariants,
    });

    revalidateStorefront(session.store.id);
    return {
      success: true,
      id: updated.id,
      qty: updated.qty,
      ...(updated.heldForAllergens && { heldForAllergens: true }),
      ...(updated.stockMoved && { stockMoved: updated.stockMoved }),
    };
  } catch (err) {
    return { error: errorText(err, "Failed to update listing") };
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
