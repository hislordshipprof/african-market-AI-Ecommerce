import { lockListingRow, platformAdmin, storeScopedTransaction } from "../db";
import type { Actor } from "../listing/service";
import { attributeGroup, type Allergen, type AttributeStatus, type DietaryClaim, type ProductAttributes } from "./attributes";
import { resolveIngredients } from "./ingredients";

const UNKNOWN_ATTRIBUTES: ProductAttributes = {
  ingredients: { status: "unknown", ingredientIds: [] },
  allergens: { status: "unknown", values: [] },
  dietary: { status: "unknown", values: [] },
};

/** A store owner states a group as known or unknown, or clears their correction to use the catalog value. */
export type OwnerStatus = "known" | "unknown" | "catalog";

export interface ListingAttributesCorrection {
  ingredients?: { status: OwnerStatus; names: string[] };
  allergens?: { status: OwnerStatus; values: Allergen[] };
  dietary?: { status: OwnerStatus; values: DietaryClaim[] };
}

export type CorrectionResult = { ok: true } | { ok: false; error: string };

type Group<T> = { status: AttributeStatus; values: T[] };

/**
 * The owner's group over the master's. With both an owner value and a reviewed master value the safer
 * one wins: contains-lists take the union, claims the intersection; an owner's unknown stays unknown.
 */
function saferGroup<T>(master: Group<T>, own: Group<T> | null, combine: "union" | "intersection"): Group<T> {
  if (!own) return master;
  if (own.status === "unknown" || master.status === "unknown") return own;
  const values = combine === "union"
    ? [...new Set([...own.values, ...master.values])]
    : own.values.filter((value) => master.values.includes(value));
  return { status: "known", values };
}

/**
 * The listing's attributes: each group from its master product, else unknown, combined with the
 * owner's correction where there is one. Null when the listing is not this store's.
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
    const base: ProductAttributes = master
      ? {
        ingredients: {
          status: master.ingredientsStatus as AttributeStatus,
          ingredientIds: master.ingredients.map((link) => link.ingredientId),
        },
        allergens: { status: master.allergensStatus as AttributeStatus, values: master.allergens as Allergen[] },
        dietary: { status: master.dietaryStatus as AttributeStatus, values: master.dietaryClaims as DietaryClaim[] },
      }
      : structuredClone(UNKNOWN_ATTRIBUTES);
    const ingredients = saferGroup(
      { status: base.ingredients.status, values: base.ingredients.ingredientIds },
      own?.ingredientsStatus
        ? { status: own.ingredientsStatus as AttributeStatus, values: listing.ingredients.map((link) => link.ingredientId) }
        : null,
      "union",
    );
    return {
      ingredients: { status: ingredients.status, ingredientIds: ingredients.values },
      allergens: saferGroup(
        base.allergens,
        own?.allergensStatus ? { status: own.allergensStatus as AttributeStatus, values: own.allergens as Allergen[] } : null,
        "union",
      ),
      dietary: saferGroup(
        base.dietary,
        own?.dietaryStatus ? { status: own.dietaryStatus as AttributeStatus, values: own.dietaryClaims as DietaryClaim[] } : null,
        "intersection",
      ),
    };
  });
}

export interface OwnerAttributeGroup<T> {
  status: AttributeStatus;
  values: T[];
  /** A model read of this group waits in the platform's review queue. */
  proposed: boolean;
  /** The owner has a correction for this group, which "Use catalog value" clears. */
  ownerSet: boolean;
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
  const { masterProductId, own, names } = await storeScopedTransaction(storeId, async (tx) => {
    const listing = await tx.listing.findUniqueOrThrow({
      where: { id: listingId },
      select: { masterProductId: true, attributes: { select: { ingredientsStatus: true, allergensStatus: true, dietaryStatus: true } } },
    });
    const ingredients = await tx.ingredient.findMany({
      where: { id: { in: attributes.ingredients.ingredientIds } },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return {
      masterProductId: listing.masterProductId,
      own: listing.attributes,
      names: ingredients.map((ingredient) => ingredient.name),
    };
  });
  // Proposals are platform-admin rows; the owner only learns which groups have a pending read.
  const pending = masterProductId
    ? await platformAdmin.attributeProposal.findMany({
      where: { productId: masterProductId, status: "pending" },
      select: { ingredientsRead: true, allergensRead: true, dietaryRead: true },
    })
    : [];
  return {
    ingredients: {
      status: attributes.ingredients.status,
      values: names,
      proposed: pending.some((p) => p.ingredientsRead),
      ownerSet: !!own?.ingredientsStatus,
    },
    allergens: { ...attributes.allergens, proposed: pending.some((p) => p.allergensRead), ownerSet: !!own?.allergensStatus },
    dietary: { ...attributes.dietary, proposed: pending.some((p) => p.dietaryRead), ownerSet: !!own?.dietaryStatus },
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

    // "catalog" clears the group (null); anything else goes through the one attribute rule.
    const ownerGroup = <K extends "ingredients" | "allergens" | "dietary">(name: K, status: OwnerStatus, values: string[]) =>
      status === "catalog" ? null : attributeGroup(name, status === "known" ? values : null, "owner");

    let ingredientIds: string[] | null = null;
    if (correction.ingredients) {
      const group = ownerGroup("ingredients", correction.ingredients.status, correction.ingredients.names);
      if (group && !group.ok) return { ok: false, error: group.error };
      ingredientIds = [];
      if (group?.group?.status === "known") {
        const resolved = await resolveIngredients(tx, group.group.values, { create: false });
        if (resolved.unmatched.length > 0) return { ok: false, error: `Unknown ingredient: ${resolved.unmatched.join(", ")}` };
        ingredientIds = resolved.ids;
      }
    }

    const data: {
      ingredientsStatus?: string | null;
      allergens?: string[];
      allergensStatus?: string | null;
      dietaryClaims?: string[];
      dietaryStatus?: string | null;
    } = {};
    if (correction.ingredients) data.ingredientsStatus = correction.ingredients.status === "catalog" ? null : correction.ingredients.status;
    if (correction.allergens) {
      const group = ownerGroup("allergens", correction.allergens.status, correction.allergens.values);
      if (group && !group.ok) return { ok: false, error: group.error };
      data.allergensStatus = group?.group?.status ?? null;
      data.allergens = group?.group?.values ?? [];
    }
    if (correction.dietary) {
      const group = ownerGroup("dietary", correction.dietary.status, correction.dietary.values);
      if (group && !group.ok) return { ok: false, error: group.error };
      data.dietaryStatus = group?.group?.status ?? null;
      data.dietaryClaims = group?.group?.values ?? [];
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
