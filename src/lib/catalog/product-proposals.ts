import { randomBytes } from "node:crypto";
import { z } from "zod";
import { storeScoped } from "../db";
import { productProposalPhotoKey, readPrivatePhoto, uploadProductProposalPhoto } from "../r2";

/** The part of the shelf photo the owner framed, as fractions of its width and height. */
export const proposalCropSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.02).max(1),
  height: z.number().min(0.02).max(1),
}).refine((crop) => crop.x + crop.width <= 1.0001 && crop.y + crop.height <= 1.0001);

/** What the owner suggests for the master catalog when publishing an unmatched item. */
export const proposalInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  localName: z.string().trim().max(100).nullable().optional(),
  size: z.string().trim().max(40).nullable().optional(),
  categoryId: z.string().min(1).max(200).nullable().optional(),
  crop: proposalCropSchema.nullable().optional(),
});

export type ProposalInput = z.infer<typeof proposalInputSchema>;
export type ProposalCrop = z.infer<typeof proposalCropSchema>;

const MAX_INPUT_PIXELS = 16_777_216;

/**
 * Cuts the owner's frame out of the private shelf photo, re-encodes it to JPEG (no metadata, long edge
 * at most 960px) and keeps it privately. Null when the photo is missing or cannot be read.
 */
export async function cropShelfPhoto(storeId: string, shelfKey: string, crop: ProposalCrop): Promise<string | null> {
  const bytes = await readPrivatePhoto(shelfKey);
  if (!bytes) return null;
  try {
    const { default: sharp } = await import("sharp");
    const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" });
    const { width, height } = await image.metadata();
    if (!width || !height) return null;
    const left = Math.min(width - 1, Math.round(crop.x * width));
    const top = Math.min(height - 1, Math.round(crop.y * height));
    const jpeg = await image
      .extract({
        left,
        top,
        width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))),
        height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))),
      })
      .resize(960, 960, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const key = productProposalPhotoKey(storeId, randomBytes(12).toString("hex"));
    await uploadProductProposalPhoto(key, jpeg);
    return key;
  } catch (error) {
    console.error("[product-proposals] crop failed", { errorType: error instanceof Error ? error.name : "Error" });
    return null;
  }
}

export interface StoreProposalRow {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  masterProductName: string | null;
  createdAt: string;
}

/** Shown on the store's photo page: this store's latest suggestions and how each ended. */
export const STORE_PROPOSALS_SHOWN = 30;

export async function listStoreProposals(storeId: string): Promise<StoreProposalRow[]> {
  const rows = await storeScoped(storeId).productProposal.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: STORE_PROPOSALS_SHOWN,
    include: { masterProduct: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status as StoreProposalRow["status"],
    rejectReason: row.rejectReason,
    masterProductName: row.masterProduct?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
