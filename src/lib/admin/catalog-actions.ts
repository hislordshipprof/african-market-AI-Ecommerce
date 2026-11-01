"use server";

import { platformAdmin, platformAdminTransaction } from "../db";
import { requirePlatformAdmin } from "./session";
import { uploadToR2 } from "../r2";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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

  const status = opts?.status ?? "needs_review";
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 25));
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

async function downloadAndUploadImage(
  sourceUrl: string,
  productId: string,
): Promise<string | null> {
  const hasR2 = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
  if (!hasR2 || !sourceUrl) return null;

  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "AfricanMarketsPlatform/1.0 (catalog review)" },
    });
    if (!response.ok) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("svg") ? "svg" : "jpg";
    const key = `catalog/${productId}.${ext}`;
    return await uploadToR2(key, buffer, contentType);
  } catch {
    return null;
  }
}

export async function approveProduct(
  productId: string,
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();

  const product = await platformAdmin.masterProduct.findUnique({
    where: { id: productId },
  });
  if (!product) return { error: "Product not found" };
  if (product.status === "active") return { success: true };

  let imageUrl = product.imageUrl;
  if (!imageUrl && product.imageSourceUrl) {
    imageUrl = await downloadAndUploadImage(product.imageSourceUrl, productId);
  }

  await platformAdminTransaction(async (tx) => {
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
  });

  return { success: true };
}

export async function rejectProduct(
  productId: string,
): Promise<CatalogActionResult> {
  const session = await requirePlatformAdmin();

  const product = await platformAdmin.masterProduct.findUnique({
    where: { id: productId },
  });
  if (!product) return { error: "Product not found" };
  if (product.status === "rejected") return { success: true };

  await platformAdminTransaction(async (tx) => {
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
  });

  return { success: true };
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

  const product = await platformAdmin.masterProduct.findUnique({
    where: { id: productId },
  });
  if (!product) return { error: "Product not found" };

  const updateData: {
    name?: string;
    description?: string | null;
    unit?: string | null;
    storage?: string | null;
    originCountries?: string | null;
  } = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description || null;
  if (data.unit !== undefined) updateData.unit = data.unit || null;
  if (data.storage !== undefined) updateData.storage = data.storage || null;
  if (data.originCountries !== undefined) updateData.originCountries = data.originCountries || null;

  if (Object.keys(updateData).length === 0) return { success: true };

  await platformAdminTransaction(async (tx) => {
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
  });

  return { success: true };
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
