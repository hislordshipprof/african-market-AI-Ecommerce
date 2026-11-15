"use server";

import { z } from "zod";
import { uploadCatalogPhoto } from "../catalog-image";
import { lockListingRow, lockMasterProductRow, lockProductProposalRow, platformAdminTransaction } from "../db";
import { readPrivatePhoto } from "../r2";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { requirePlatformAdmin } from "./session";

export type ProductProposalRow = {
  id: string;
  storeId: string;
  storeName: string;
  name: string;
  localName: string | null;
  size: string | null;
  categoryId: string | null;
  categoryName: string | null;
  hasPhoto: boolean;
  listingName: string | null;
  listingPriceCents: number;
  createdAt: Date;
};

export type ProposalActionResult = { success?: boolean; error?: string };

/** Pending at most this many, oldest first: the queue is worked from the top. */
const QUEUE_SIZE = 100;

const ALREADY_REVIEWED = "This suggestion was already reviewed.";
const NOT_FOUND = "Suggestion not found.";

/** Pending product proposals from every store, for the catalog review queue. */
export async function listProductProposals(): Promise<ProductProposalRow[]> {
  await requirePlatformAdmin();
  const rows = await platformAdminTransaction((tx) => tx.productProposal.findMany({
    where: { status: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: QUEUE_SIZE,
    include: {
      store: { select: { name: true } },
      category: { select: { name: true } },
      listing: { select: { customName: true, price: true } },
    },
  }));
  return rows.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    storeName: row.store.name,
    name: row.name,
    localName: row.localName,
    size: row.size,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    hasPhoto: row.photoKey !== null,
    listingName: row.listing.customName,
    listingPriceCents: row.listing.price,
    createdAt: row.createdAt,
  }));
}

const proposalIdSchema = z.string().min(1).max(200);

const approveSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    proposalId: proposalIdSchema,
    mode: z.literal("create"),
    name: z.string().trim().min(1).max(200),
    localName: z.string().trim().max(100).nullable().optional(),
    size: z.string().trim().max(40).nullable().optional(),
    categoryId: z.string().min(1).max(200).nullable().optional(),
    usePhoto: z.boolean(),
  }),
  z.strictObject({
    proposalId: proposalIdSchema,
    mode: z.literal("link"),
    masterProductId: z.string().min(1).max(200),
  }),
]);

const PHOTO_ERRORS: Record<string, string> = {
  storage: "Catalog photos are not set up. Approve without the photo.",
  upload: "The photo could not be saved. Try again, or approve without it.",
  svg: "The suggested photo could not be used. Approve without it.",
  not_photo: "The suggested photo could not be used. Approve without it.",
};

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Approves a store's suggestion: a new active master product (with the local name as a synonym and,
 * if the admin keeps it, the cropped photo through the catalog image pipeline), or an existing product
 * the admin picked. The proposing store's custom listing is re-pointed to it. Both steps are audited.
 */
export async function approveProductProposal(input: unknown): Promise<ProposalActionResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(approveSchema, input);
  if (!parsed.ok) return { error: "Check the product's name, size and category." };
  const decision = parsed.data;

  const preview = await platformAdminTransaction((tx) => tx.productProposal.findUnique({ where: { id: decision.proposalId } }));
  if (!preview) return { error: NOT_FOUND };
  if (preview.status !== "pending") return { error: ALREADY_REVIEWED };

  // The photo goes through the catalog pipeline before the lock: network I/O never holds a row lock.
  let imageUrl: string | null = null;
  if (decision.mode === "create" && decision.usePhoto && preview.photoKey) {
    const bytes = await readPrivatePhoto(preview.photoKey);
    if (!bytes) return { error: "The suggested photo could not be read. Approve without it." };
    const uploaded = await uploadCatalogPhoto(preview.id, bytes);
    if (!uploaded.ok) return { error: PHOTO_ERRORS[uploaded.reason] };
    imageUrl = uploaded.url;
  }

  const result = await platformAdminTransaction(async (tx): Promise<ProposalActionResult> => {
    await lockProductProposalRow(tx, decision.proposalId);
    const proposal = await tx.productProposal.findUnique({ where: { id: decision.proposalId } });
    if (!proposal) return { error: NOT_FOUND };
    if (proposal.status !== "pending") return { error: ALREADY_REVIEWED };
    await lockListingRow(tx, proposal.listingId);
    const listing = await tx.listing.findUniqueOrThrow({ where: { id: proposal.listingId } });

    let masterProductId: string;
    if (decision.mode === "link") {
      await lockMasterProductRow(tx, decision.masterProductId);
      const product = await tx.masterProduct.findUnique({ where: { id: decision.masterProductId } });
      if (!product || product.status !== "active") return { error: "Pick an active catalog product." };
      const listedAlready = await tx.listing.findFirst({
        where: { storeId: proposal.storeId, masterProductId: product.id, id: { not: listing.id } },
        select: { id: true },
      });
      if (listedAlready) return { error: "This store already lists that product. Pick another or create a new one." };
      masterProductId = product.id;
    } else {
      const categoryId = decision.categoryId ?? null;
      if (categoryId && !(await tx.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) {
        return { error: "That category no longer exists. Pick another." };
      }
      const product = await tx.masterProduct.create({
        data: { name: decision.name, unit: decision.size || null, categoryId, status: "active", imageUrl },
      });
      const localName = decision.localName || null;
      if (localName && fold(localName) !== fold(decision.name)) {
        await tx.productSynonym.create({ data: { productId: product.id, term: localName } });
      }
      masterProductId = product.id;
    }

    // A listing the owner already linked to a product keeps that link.
    const relinked = listing.masterProductId === null;
    if (relinked) {
      await tx.listing.update({ where: { id: listing.id }, data: { masterProductId, customName: null } });
      await tx.auditLog.create({
        data: {
          storeId: proposal.storeId,
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: "listing.catalog_link",
          entityType: "listing",
          entityId: listing.id,
          before: { masterProductId: null, customName: listing.customName },
          after: { masterProductId, customName: null, proposalId: proposal.id },
        },
      });
    }
    await tx.productProposal.update({
      where: { id: proposal.id },
      data: { status: "approved", masterProductId, reviewedById: session.user.id, reviewedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        storeId: proposal.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.proposal_approve",
        entityType: "product_proposal",
        entityId: proposal.id,
        before: { status: "pending", name: proposal.name, localName: proposal.localName, size: proposal.size, categoryId: proposal.categoryId },
        after: { status: "approved", mode: decision.mode, masterProductId, imageUrl, listingRelinked: relinked },
      },
    });
    return { success: true };
  });

  if (result.success) revalidateStorefront(preview.storeId);
  else if (imageUrl) console.error("[product-proposals] approved photo left unused", { proposalId: preview.id });
  return result;
}

const rejectSchema = z.strictObject({
  proposalId: proposalIdSchema,
  reason: z.string().trim().max(500),
});

/** Rejects a store's suggestion. The store's custom listing stays exactly as it is. */
export async function rejectProductProposal(input: unknown): Promise<ProposalActionResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(rejectSchema, input);
  if (!parsed.ok) return { error: "Keep the reason under 500 characters." };
  const { proposalId } = parsed.data;
  const reason = parsed.data.reason || null;

  return platformAdminTransaction(async (tx): Promise<ProposalActionResult> => {
    await lockProductProposalRow(tx, proposalId);
    const proposal = await tx.productProposal.findUnique({ where: { id: proposalId } });
    if (!proposal) return { error: NOT_FOUND };
    if (proposal.status !== "pending") return { error: ALREADY_REVIEWED };
    await tx.productProposal.update({
      where: { id: proposal.id },
      data: { status: "rejected", rejectReason: reason, reviewedById: session.user.id, reviewedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        storeId: proposal.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.proposal_reject",
        entityType: "product_proposal",
        entityId: proposal.id,
        before: { status: "pending" },
        after: { status: "rejected", reason },
      },
    });
    return { success: true };
  });
}
