import { lockListingRow, platformAdmin, storeScopedTransaction } from "../db";
import type { Actor } from "../listing/service";
import type { Allergen, AttributeStatus, DietaryClaim, ProductAttributes } from "./attributes";
import { resolveIngredients } from "./ingredients";

const UNKNOWN_ATTRIBUTES: ProductAttributes = {
  ingredients: { status: "unknown", ingredientIds: [] },
  allergens: { status: "unknown", values: [] },
  dietary: { status: "unknown", values: [] },
};

/** A store owner states a group as known, or as unknown. */
export type OwnerStatus = "known" | "unknown";

export interface ListingAttributesCorrection {
  ingredients?: { status: OwnerStatus; names: string[] };
  allergens?: { status: OwnerStatus; values: Allergen[] };
  dietary?: { status: OwnerStatus; values: DietaryClaim[] };
}

export type CorrectionResult = { ok: true } | { ok: false; error: string };

/**
 * The listing's attributes: each group from the owner's correction when there is one,
 * else from its master product, else unknown. Null when the listing is not this store's.
 */
export async function listingAttributes(storeId: string, listingId: string): Promise<ProductAttributes | null> {
  return storeScopedTransaction(storeId, async (tx) => {
    const listing = await tx.listing.findUnique({
      where: { id: listingId },
      include: {
        attributes: true,
        ingredients: { select: { ingredientId: true } },
        masterProduct: { include: { ingredients: { select: { ingredientId: true } } } },
      },
    });
    if (!listing) return null;
    const master = listing.masterProduct;
    const own = listing.attributes;
    const result: ProductAttributes = master
      ? {
        ingredients: {
          status: master.ingredientsStatus as AttributeStatus,
          ingredientIds: master.ingredients.map((link) => link.ingredientId),
        },
        allergens: { status: master.allergensStatus as AttributeStatus, values: master.allergens as Allergen[] },
        dietary: { status: master.dietaryStatus as AttributeStatus, values: master.dietaryClaims as DietaryClaim[] },
      }
      : structuredClone(UNKNOWN_ATTRIBUTES);
    if (own?.ingredientsStatus) {
      result.ingredients = {
        status: own.ingredientsStatus as AttributeStatus,
        ingredientIds: listing.ingredients.map((link) => link.ingredientId),
      };
    }
    if (own?.allergensStatus) {
      result.allergens = { status: own.allergensStatus as AttributeStatus, values: own.allergens as Allergen[] };
    }
    if (own?.dietaryStatus) {
      result.dietary = { status: own.dietaryStatus as AttributeStatus, values: own.dietaryClaims as DietaryClaim[] };
    }
    return result;
  });
}

export interface OwnerAttributeGroup<T> {
  status: AttributeStatus;
  values: T[];
  /** A model read of this group waits in the platform's review queue. */
  proposed: boolean;
}

export interface OwnerListingAttributes {
  ingredients: OwnerAttributeGroup<string>;
  allergens: OwnerAttributeGroup<Allergen>;
  dietary: OwnerAttributeGroup<DietaryClaim>;
}

/** What the store owner's attributes screen shows: ingredient names, and which groups an AI read is pending for. */
export async function ownerListingAttributes(storeId: string, listingId: string): Promise<OwnerListingAttributes | null> {
  const attributes = await listingAttributes(storeId, listingId);
  if (!attributes) return null;
  const { masterProductId, names } = await storeScopedTransaction(storeId, async (tx) => {
    const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId }, select: { masterProductId: true } });
    const ingredients = await tx.ingredient.findMany({
      where: { id: { in: attributes.ingredients.ingredientIds } },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return { masterProductId: listing.masterProductId, names: ingredients.map((ingredient) => ingredient.name) };
  });
  // Proposals are platform-admin rows; the owner only learns which groups have a pending read.
  const pending = masterProductId
    ? await platformAdmin.attributeProposal.findMany({
      where: { productId: masterProductId, status: "pending" },
      select: { ingredientsRead: true, allergensRead: true, dietaryRead: true },
    })
    : [];
  return {
    ingredients: { status: attributes.ingredients.status, values: names, proposed: pending.some((p) => p.ingredientsRead) },
    allergens: { ...attributes.allergens, proposed: pending.some((p) => p.allergensRead) },
    dietary: { ...attributes.dietary, proposed: pending.some((p) => p.dietaryRead) },
  };
}

/** A store owner corrects their own listing's attributes. Ingredients must already exist by name or local name. */
export async function correctListingAttributes(
  storeId: string,
  actor: Actor,
  listingId: string,
  correction: ListingAttributesCorrection,
): Promise<CorrectionResult> {
  return storeScopedTransaction(storeId, async (tx): Promise<CorrectionResult> => {
    await lockListingRow(tx, listingId);
    const listing = await tx.listing.findUnique({
      where: { id: listingId },
      include: { attributes: true, ingredients: { select: { ingredientId: true } } },
    });
    if (!listing) return { ok: false, error: "Listing not found" };

    let ingredientIds: string[] | null = null;
    if (correction.ingredients) {
      ingredientIds = [];
      if (correction.ingredients.status === "known") {
        const resolved = await resolveIngredients(tx, correction.ingredients.names, { create: false });
        if (resolved.unmatched.length > 0) return { ok: false, error: `Unknown ingredient: ${resolved.unmatched.join(", ")}` };
        ingredientIds = resolved.ids;
      }
    }

    const data: {
      ingredientsStatus?: string;
      allergens?: string[];
      allergensStatus?: string;
      dietaryClaims?: string[];
      dietaryStatus?: string;
    } = {};
    if (correction.ingredients) data.ingredientsStatus = correction.ingredients.status;
    if (correction.allergens) {
      data.allergensStatus = correction.allergens.status;
      data.allergens = correction.allergens.status === "known" ? [...new Set(correction.allergens.values)] : [];
    }
    if (correction.dietary) {
      data.dietaryStatus = correction.dietary.status;
      data.dietaryClaims = correction.dietary.status === "known" ? [...new Set(correction.dietary.values)] : [];
    }
    if (Object.keys(data).length === 0) return { ok: true };

    await tx.listingAttributes.upsert({
      where: { listingId },
      create: { listingId, storeId, ...data },
      update: data,
    });
    if (ingredientIds) {
      await tx.listingIngredient.deleteMany({ where: { listingId } });
      await tx.listingIngredient.createMany({
        data: ingredientIds.map((ingredientId) => ({ listingId, ingredientId, storeId })),
      });
    }
    const own = listing.attributes;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "listing.attributes_correct",
        entityType: "listing",
        entityId: listingId,
        before: {
          ingredientsStatus: own?.ingredientsStatus ?? null,
          ingredientIds: listing.ingredients.map((link) => link.ingredientId),
          allergens: own?.allergens ?? [],
          allergensStatus: own?.allergensStatus ?? null,
          dietaryClaims: own?.dietaryClaims ?? [],
          dietaryStatus: own?.dietaryStatus ?? null,
        },
        after: { ...data, ...(ingredientIds ? { ingredientIds } : {}) },
      },
    });
    return { ok: true };
  });
}
