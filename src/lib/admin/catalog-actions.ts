"use server";

import { z } from "zod";
import { platformAdmin, platformAdminTransaction, lockMasterProductRow } from "../db";
import { requirePlatformAdmin } from "./session";
import { downloadAndUploadImage } from "../catalog-image";
import { parseInput } from "../security/parse-input";
import { assistantModelId } from "../assistant/model";
import { assistantSpendState } from "../assistant/spend";
import { extractProductAttributes } from "../catalog/attribute-extract";
import { normaliseIngredientName, resolveIngredients } from "../catalog/ingredients";

const productIdSchema = z.string().min(1).max(200);

export type ReviewProduct = {
  id: string;
  name: string;
  categoryName: string | null;
  subcategory: string | null;
  description: string | null;
  confidence: string | null;
  originCountries: string | null;
  unit: string | null;
  weightG: number | null;
  storage: string | null;
  perishable: boolean;
  frozen: boolean;
  imageUrl: string | null;
  status: string;
  synonymCount: number;
};

export async function listReviewProducts(opts?: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ products: ReviewProduct[]; total: number; page: number; pageSize: number }> {
  await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    status: z.string().max(40).optional(),
    page: z.number().int().min(1).max(100_000).optional(),
    pageSize: z.number().int().min(1).max(10_000).optional(),
  }), opts ?? {});
  if (!parsed.ok) return { products: [], total: 0, page: 1, pageSize: 25 };

  const status = parsed.data.status ?? "needs_review";
  const page = Math.max(1, parsed.data.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, parsed.data.pageSize ?? 25));
  const skip = (page - 1) * pageSize;

  const [products, total] = await Promise.all([
    platformAdmin.masterProduct.findMany({
      where: { status },
      include: {
        category: { select: { name: true } },
        _count: { select: { synonyms: true } },
      },
      orderBy: [{ confidence: "desc" }, { name: "asc" }],
      skip,
      take: pageSize,
    }),
    platformAdmin.masterProduct.count({ where: { status } }),
  ]);

  return {
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      categoryName: p.category?.name ?? null,
      subcategory: p.subcategory,
      description: p.description,
      confidence: p.confidence,
      originCountries: p.originCountries,
      unit: p.unit,
      weightG: p.weightG,
      storage: p.storage,
      perishable: p.perishable,
      frozen: p.frozen,
      imageUrl: p.imageUrl,
      status: p.status,
      synonymCount: p._count.synonyms,
    })),
    total,
    page,
    pageSize,
  };
}

export type CatalogActionResult = {
  success?: boolean;
  error?: string;
};

async function downloadCatalogImage(
  sourceUrl: string,
  productId: string,
): Promise<string | null> {
  const hasR2 = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
  if (!hasR2) return null;
  const result = await downloadAndUploadImage(sourceUrl, productId, {
    userAgent: "AfricanMarketsPlatform/1.0 (catalog review)",
  });
  return result.ok ? result.url : null;
}

export async function approveProduct(
  productId: string,
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const id = parseInput(productIdSchema, productId);
  if (!id.ok) return { error: "Product not found" };
  productId = id.data;

  // Optimistic read, outside the transaction, only so the image download (network I/O)
  // never happens while the row lock is held. The locked re-read below is authoritative.
  const preview = await platformAdmin.masterProduct.findUnique({
    where: { id: productId },
  });
  if (!preview) return { error: "Product not found" };
  if (preview.status === "active") return { success: true };

  let downloadedUrl: string | null = null;
  if (!preview.imageUrl && preview.imageSourceUrl) {
    downloadedUrl = await downloadCatalogImage(preview.imageSourceUrl, productId);
  }

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId } });
    if (!product) return { error: "Product not found" };
    if (product.status === "active") return { success: true };

    const imageUrl = product.imageUrl ?? downloadedUrl;
    await tx.masterProduct.update({
      where: { id: productId },
      data: { status: "active", imageUrl },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.approve",
        entityType: "master_product",
        entityId: productId,
        before: { status: product.status },
        after: { status: "active", imageUrl },
      },
    });
    return { success: true };
  });
}

export async function rejectProduct(
  productId: string,
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const id = parseInput(productIdSchema, productId);
  if (!id.ok) return { error: "Product not found" };
  productId = id.data;

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId } });
    if (!product) return { error: "Product not found" };
    if (product.status === "rejected") return { success: true };

    await tx.masterProduct.update({
      where: { id: productId },
      data: { status: "rejected" },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.reject",
        entityType: "master_product",
        entityId: productId,
        before: { status: product.status },
        after: { status: "rejected" },
      },
    });
    return { success: true };
  });
}

export async function updateReviewProduct(
  productId: string,
  data: {
    name?: string;
    description?: string;
    unit?: string;
    storage?: string;
    originCountries?: string;
  },
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    productId: productIdSchema,
    data: z.strictObject({
      name: z.string().max(500).optional(),
      description: z.string().max(20_000).optional(),
      unit: z.string().max(100).optional(),
      storage: z.string().max(100).optional(),
      originCountries: z.string().max(500).optional(),
    }),
  }), { productId, data });
  if (!parsed.ok) return { error: "Product not found" };
  productId = parsed.data.productId;
  data = parsed.data.data;

  const updateData: {
    name?: string;
    description?: string | null;
    unit?: string | null;
    storage?: string | null;
    originCountries?: string | null;
  } = {};
  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) return { error: "Name is required" };
    updateData.name = name;
  }
  if (data.description !== undefined) updateData.description = data.description || null;
  if (data.unit !== undefined) updateData.unit = data.unit || null;
  if (data.storage !== undefined) updateData.storage = data.storage || null;
  if (data.originCountries !== undefined) updateData.originCountries = data.originCountries || null;

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId } });
    if (!product) return { error: "Product not found" };
    if (Object.keys(updateData).length === 0) return { success: true };

    await tx.masterProduct.update({
      where: { id: productId },
      data: updateData,
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.edit",
        entityType: "master_product",
        entityId: productId,
        before: {
          name: product.name,
          description: product.description,
          unit: product.unit,
          storage: product.storage,
          originCountries: product.originCountries,
        },
        after: updateData as Record<string, string | null>,
      },
    });
    return { success: true };
  });
}

export async function getReviewStats() {
  await requirePlatformAdmin();

  const [needsReview, active, rejected] = await Promise.all([
    platformAdmin.masterProduct.count({ where: { status: "needs_review" } }),
    platformAdmin.masterProduct.count({ where: { status: "active" } }),
    platformAdmin.masterProduct.count({ where: { status: "rejected" } }),
  ]);

  return { needsReview, active, rejected, total: needsReview + active + rejected };
}

export type ProposeAttributesResult = CatalogActionResult & { proposalId?: string };

/** Claude reads the product's label photo and description into a proposal for review. */
export async function proposeProductAttributes(productId: string): Promise<ProposeAttributesResult> {
  await requirePlatformAdmin();
  const id = parseInput(productIdSchema, productId);
  if (!id.ok) return { error: "Product not found" };

  const product = await platformAdmin.masterProduct.findUnique({ where: { id: id.data } });
  if (!product) return { error: "Product not found" };
  try {
    if ((await assistantSpendState()).resting) return { error: "AI spend limit reached for today" };
    const proposed = await extractProductAttributes({
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
    });
    const proposal = await platformAdmin.attributeProposal.create({
      data: {
        productId: product.id,
        ingredientsRead: proposed.ingredients !== null,
        ingredients: proposed.ingredients ?? [],
        allergensRead: proposed.allergens !== null,
        allergens: proposed.allergens ?? [],
        dietaryRead: proposed.dietaryClaims !== null,
        dietaryClaims: proposed.dietaryClaims ?? [],
        model: assistantModelId(),
      },
    });
    return { success: true, proposalId: proposal.id };
  } catch (error) {
    console.error("[catalog] attribute proposal failed", error instanceof Error ? error.name : "unknown");
    return { error: "Could not read this product's attributes. Try again later." };
  }
}

export type AttributeProposalRow = {
  id: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  ingredients: string[] | null;
  allergens: string[] | null;
  dietaryClaims: string[] | null;
  createdAt: Date;
};

export async function listAttributeProposals(): Promise<AttributeProposalRow[]> {
  await requirePlatformAdmin();
  const rows = await platformAdmin.attributeProposal.findMany({
    where: { status: "pending" },
    include: { masterProduct: { select: { name: true, imageUrl: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    productName: row.masterProduct.name,
    imageUrl: row.masterProduct.imageUrl,
    ingredients: row.ingredientsRead ? row.ingredients : null,
    allergens: row.allergensRead ? row.allergens : null,
    dietaryClaims: row.dietaryRead ? row.dietaryClaims : null,
    createdAt: row.createdAt,
  }));
}

const proposalIdSchema = z.string().min(1).max(200);

/** Groups the model read become reviewed on the product; a group it could not read is left as it was. */
export async function approveAttributeProposal(proposalId: string): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const id = parseInput(proposalIdSchema, proposalId);
  if (!id.ok) return { error: "Proposal not found" };

  const preview = await platformAdmin.attributeProposal.findUnique({ where: { id: id.data } });
  if (!preview) return { error: "Proposal not found" };

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    await lockMasterProductRow(tx, preview.productId);
    const proposal = await tx.attributeProposal.findUnique({ where: { id: id.data } });
    if (!proposal) return { error: "Proposal not found" };
    if (proposal.status !== "pending") return { error: "Proposal already reviewed" };
    const product = await tx.masterProduct.findUniqueOrThrow({
      where: { id: proposal.productId },
      include: { ingredients: { select: { ingredientId: true } } },
    });

    const data: {
      ingredientsStatus?: string;
      allergens?: string[];
      allergensStatus?: string;
      dietaryClaims?: string[];
      dietaryStatus?: string;
    } = {};
    let ingredientIds: string[] | null = null;
    if (proposal.ingredientsRead) {
      ingredientIds = (await resolveIngredients(tx, proposal.ingredients, { create: true })).ids;
      await tx.masterProductIngredient.deleteMany({ where: { productId: product.id } });
      await tx.masterProductIngredient.createMany({
        data: ingredientIds.map((ingredientId) => ({ productId: product.id, ingredientId })),
      });
      data.ingredientsStatus = "reviewed";
    }
    if (proposal.allergensRead) {
      data.allergens = proposal.allergens;
      data.allergensStatus = "reviewed";
    }
    if (proposal.dietaryRead) {
      data.dietaryClaims = proposal.dietaryClaims;
      data.dietaryStatus = "reviewed";
    }
    await tx.masterProduct.update({ where: { id: product.id }, data });
    await tx.attributeProposal.update({
      where: { id: proposal.id },
      data: { status: "approved", reviewedAt: new Date(), reviewedBy: session.user.id },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.attributes_approve",
        entityType: "master_product",
        entityId: product.id,
        before: {
          ingredientsStatus: product.ingredientsStatus,
          ingredientIds: product.ingredients.map((link) => link.ingredientId),
          allergens: product.allergens,
          allergensStatus: product.allergensStatus,
          dietaryClaims: product.dietaryClaims,
          dietaryStatus: product.dietaryStatus,
        },
        after: { proposalId: proposal.id, ...data, ...(ingredientIds ? { ingredientIds } : {}) },
      },
    });
    return { success: true };
  });
}

export async function rejectAttributeProposal(proposalId: string): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const id = parseInput(proposalIdSchema, proposalId);
  if (!id.ok) return { error: "Proposal not found" };

  const preview = await platformAdmin.attributeProposal.findUnique({ where: { id: id.data } });
  if (!preview) return { error: "Proposal not found" };

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    await lockMasterProductRow(tx, preview.productId);
    const proposal = await tx.attributeProposal.findUnique({ where: { id: id.data } });
    if (!proposal) return { error: "Proposal not found" };
    if (proposal.status !== "pending") return { error: "Proposal already reviewed" };
    await tx.attributeProposal.update({
      where: { id: proposal.id },
      data: { status: "rejected", reviewedAt: new Date(), reviewedBy: session.user.id },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.attributes_reject",
        entityType: "master_product",
        entityId: proposal.productId,
        before: { proposalId: proposal.id, status: "pending" },
        after: { proposalId: proposal.id, status: "rejected" },
      },
    });
    return { success: true };
  });
}

/** Records a local name (e.g. "ata rodo") for an ingredient, so it resolves to that ingredient. */
export async function addIngredientSynonym(
  ingredientId: string,
  term: string,
  language?: string,
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    ingredientId: z.string().min(1).max(200),
    term: z.string().max(100),
    language: z.string().max(20).optional(),
  }), { ingredientId, term, language });
  if (!parsed.ok) return { error: "Ingredient not found" };
  const normalised = normaliseIngredientName(parsed.data.term);
  if (!normalised) return { error: "Local name is required" };

  return platformAdminTransaction(async (tx): Promise<CatalogActionResult> => {
    const ingredient = await tx.ingredient.findUnique({ where: { id: parsed.data.ingredientId } });
    if (!ingredient) return { error: "Ingredient not found" };
    const taken = await tx.ingredientSynonym.findUnique({ where: { term: normalised } });
    if (taken) return taken.ingredientId === ingredient.id ? { success: true } : { error: "That name belongs to another ingredient" };
    if (await tx.ingredient.findUnique({ where: { name: normalised } })) return { error: "That name belongs to another ingredient" };
    await tx.ingredientSynonym.create({
      data: { ingredientId: ingredient.id, term: normalised, language: parsed.data.language || null },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.ingredient_synonym_add",
        entityType: "ingredient",
        entityId: ingredient.id,
        before: {},
        after: { term: normalised, language: parsed.data.language || null },
      },
    });
    return { success: true };
  });
}
