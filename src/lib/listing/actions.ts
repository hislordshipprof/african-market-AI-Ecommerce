"use server";
import { revalidateStorefront } from "../storefront/cache";

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

const VALID_STOCK_MODES = new Set<string>(["counted", "status"]);

function toActor(user: { id: string; email: string }): Actor {
  return { id: user.id, email: user.email };
}

export async function createListingAction(formData: FormData) {
  const session = await requireStoreOwner();

  const customName = formData.get("customName") as string | null;
  const masterProductId = formData.get("masterProductId") as string | null;
  const priceRaw = formData.get("price") as string | null;
  const stockMode = (formData.get("stockMode") as string | null) ?? "counted";
  const qtyRaw = formData.get("qty") as string | null;
  const status = formData.get("status") as string | null;
  const frozen = formData.get("frozen") === "true";
  const perishable = formData.get("perishable") === "true";
  const maxPerOrderRaw = formData.get("maxPerOrder") as string | null;
  const variantsJson = formData.get("variants") as string | null;

  if (!customName && !masterProductId) {
    return { error: "Product name or master product is required" };
  }
  const price = Number(priceRaw);
  if (!priceRaw || !isFinite(price) || price < 0) {
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

  const listingId = formData.get("listingId") as string | null;
  if (!listingId) return { error: "Listing ID is required" };

  const customName = formData.get("customName") as string | null;
  const masterProductId = formData.get("masterProductId") as string | null;
  const priceRaw = formData.get("price") as string | null;
  const stockMode = formData.get("stockMode") as string | null;
  const qtyRaw = formData.get("qty") as string | null;
  const status = formData.get("status") as string | null;
  const frozen = formData.get("frozen") as string | null;
  const perishable = formData.get("perishable") as string | null;
  const maxPerOrderRaw = formData.get("maxPerOrder") as string | null;
  const variantsJson = formData.get("variants") as string | null;

  if (customName !== null && !customName.trim() && !masterProductId) {
    return { error: "Product name is required" };
  }
  if (priceRaw !== null) {
    const p = Number(priceRaw);
    if (!isFinite(p) || p < 0) return { error: "Valid non-negative price is required" };
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

  try {
    await deactivateListing(
      session.store.id,
      listingId,
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

  try {
    await reactivateListing(
      session.store.id,
      listingId,
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
  const safeQuery = typeof query === "string" ? query.slice(0, 100) : undefined;
  const products = await listMasterProducts(safeQuery, 50);
  return products.map((p) => ({ id: p.id, name: p.name }));
}
