"use server";

import { requireStoreOwner } from "../store-admin/session";
import {
  createListing,
  updateListing,
  deactivateListing,
  reactivateListing,
  updateVariants,
  type StockMode,
  type StockStatus,
  type CreateVariantInput,
} from "./service";

function parseVariantsJson(raw: string | null): CreateVariantInput[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("variants must be an array");
  return parsed.map((v: Record<string, unknown>) => ({
    label: String(v.label ?? ""),
    price: Number(v.price),
    weightG: Number(v.weightG),
    sku: v.sku ? String(v.sku) : null,
    barcode: v.barcode ? String(v.barcode) : null,
  }));
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
  if (!priceRaw || isNaN(Number(priceRaw))) {
    return { error: "Valid price is required" };
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
      price: Number(priceRaw),
      stockMode: stockMode as StockMode,
      qty: stockMode === "counted" ? Number(qtyRaw ?? 0) : null,
      status: stockMode === "status" ? ((status as StockStatus) ?? "in_stock") : null,
      frozen,
      perishable,
      maxPerOrder: maxPerOrderRaw ? Number(maxPerOrderRaw) : null,
      variants,
      actorId: session.user.id,
      actorEmail: session.user.email,
    });
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
  const priceRaw = formData.get("price") as string | null;
  const stockMode = formData.get("stockMode") as string | null;
  const qtyRaw = formData.get("qty") as string | null;
  const status = formData.get("status") as string | null;
  const frozen = formData.get("frozen") as string | null;
  const perishable = formData.get("perishable") as string | null;
  const maxPerOrderRaw = formData.get("maxPerOrder") as string | null;
  const variantsJson = formData.get("variants") as string | null;

  try {
    const updated = await updateListing({
      storeId: session.store.id,
      listingId,
      ...(customName !== null && { customName }),
      ...(priceRaw !== null && { price: Number(priceRaw) }),
      ...(stockMode !== null && { stockMode: stockMode as StockMode }),
      ...(qtyRaw !== null && { qty: Number(qtyRaw) }),
      ...(status !== null && { status: status as StockStatus }),
      ...(frozen !== null && { frozen: frozen === "true" }),
      ...(perishable !== null && { perishable: perishable === "true" }),
      ...(maxPerOrderRaw !== null && { maxPerOrder: Number(maxPerOrderRaw) }),
      actorId: session.user.id,
      actorEmail: session.user.email,
    });

    if (variantsJson !== null) {
      const variants = parseVariantsJson(variantsJson);
      await updateVariants({
        storeId: session.store.id,
        listingId,
        variants,
      });
    }

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
      session.user.id,
      session.user.email,
    );
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
      session.user.id,
      session.user.email,
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reactivate listing";
    return { error: message };
  }
}
