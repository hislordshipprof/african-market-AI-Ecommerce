import type { PrismaClient } from "@prisma/client";
import { lockStoreRow, storeScoped, storeScopedTransaction } from "../db";
import { canOfferSwap, lineChargeCents, type ChargeLine } from "./substitution-pricing";

/** How long the customer has to answer before the line's swap rule applies. */
export const SUBSTITUTION_WINDOW_MS = 10 * 60_000;

export type SubstitutionDecision = "swap" | "refund";

type SubstitutionTx = Pick<PrismaClient, "order" | "orderLine" | "listing" | "listingVariant" | "substitutionRequest">;

type ShortLine = {
  id: string;
  orderId: string;
  listingVariantId: string;
  substituteVariantId: string | null;
  swapRule: string;
  qtyOrdered: number;
  unitPriceCents: number;
};

type Candidate = { id: string; price: number };

function inStock(listing: { active: boolean; stockMode: string; qty: number | null; status: string | null }, units: number): boolean {
  if (!listing.active) return false;
  if (listing.stockMode === "counted") return (listing.qty ?? 0) >= units;
  return !(listing.stockMode === "status" && listing.status === "out_of_stock");
}

const LISTING_STOCK = { select: { id: true, active: true, stockMode: true, qty: true, status: true, masterProduct: { select: { categoryId: true } } } } as const;

/**
 * The swap the line's rule allows, from this store's catalog: the customer's named variant, or
 * for `store_suggests` the in-stock variant in the same category closest in price. Exact only: none.
 * Only variants priced at or under `maxUnitCents` count, so a swap never outgrows the card hold.
 */
async function proposeSwap(tx: SubstitutionTx, line: ShortLine, units: number, maxUnitCents: number): Promise<Candidate | null> {
  if (line.swapRule === "named_substitute") {
    if (!line.substituteVariantId || line.substituteVariantId === line.listingVariantId) return null;
    const named = await tx.listingVariant.findUnique({ where: { id: line.substituteVariantId }, include: { listing: LISTING_STOCK } });
    if (!named || !inStock(named.listing, units) || named.price > maxUnitCents) return null;
    return { id: named.id, price: named.price };
  }
  if (line.swapRule !== "store_suggests") return null;

  const original = await tx.listingVariant.findUnique({ where: { id: line.listingVariantId }, include: { listing: LISTING_STOCK } });
  const categoryId = original?.listing.masterProduct?.categoryId;
  if (!original || !categoryId) return null;
  const candidates = await tx.listingVariant.findMany({
    where: {
      price: { lte: maxUnitCents },
      listingId: { not: original.listingId },
      listing: { active: true, masterProduct: { categoryId } },
    },
    include: { listing: LISTING_STOCK },
  });
  const best = candidates
    .filter((variant) => inStock(variant.listing, units))
    .sort((a, b) => Math.abs(a.price - line.unitPriceCents) - Math.abs(b.price - line.unitPriceCents) || a.id.localeCompare(b.id))[0];
  return best ? { id: best.id, price: best.price } : null;
}

/**
 * Opens the prompt for a line just marked short, inside the caller's transaction and store lock.
 * The order's total counts every pending prompt as swapped, since its timer may still accept it.
 */
export async function openSubstitutionRequest(
  tx: SubstitutionTx,
  storeId: string,
  line: ShortLine,
  qtyFound: number,
  order: { totalAuthorizedCents: number; tipCents: number; deliveryFeeCents: number },
): Promise<{ id: string; expiresAt: Date }> {
  const units = line.qtyOrdered - qtyFound;
  const [lines, pending] = await Promise.all([
    tx.orderLine.findMany({ where: { orderId: line.orderId } }),
    tx.substitutionRequest.findMany({ where: { orderId: line.orderId, status: "pending" } }),
  ]);
  const pendingByLine = new Map(pending.map((request) => [request.orderLineId, request]));
  const estimate: ChargeLine[] = lines.map((row) => {
    if (row.id === line.id) return { ...row, status: "pending" };
    const request = pendingByLine.get(row.id);
    return request ? { ...row, status: "substituted", substitutedUnitPriceCents: request.proposedUnitPriceCents } : row;
  });
  const currentTotalCents = estimate.reduce((sum, row) => sum + lineChargeCents(row), 0) + order.tipCents + order.deliveryFeeCents;
  // The largest unit price whose delta still fits: canOfferSwap(hold, current, units × (price − original)).
  const headroom = order.totalAuthorizedCents - currentTotalCents;
  const maxUnitCents = line.unitPriceCents + Math.floor(headroom / units);
  const proposal = await proposeSwap(tx, line, units, maxUnitCents);
  const offered = proposal && canOfferSwap(order.totalAuthorizedCents, currentTotalCents, units * (proposal.price - line.unitPriceCents))
    ? proposal
    : null;

  const expiresAt = new Date(Date.now() + SUBSTITUTION_WINDOW_MS);
  const created = await tx.substitutionRequest.create({
    data: {
      storeId,
      orderId: line.orderId,
      orderLineId: line.id,
      proposedVariantId: offered?.id ?? null,
      proposedUnitPriceCents: offered?.price ?? null,
      qty: units,
      expiresAt,
    },
  });
  return { id: created.id, expiresAt };
}

export type ResolveResult =
  | { ok: true; orderStatus: string }
  | { ok: false; error: "not_found" | "already_answered" | "not_waiting" | "no_swap_offered" | "not_due" };

/**
 * Applies one answer. `customer` is the customer's tap; `timeout` applies the line's rule
 * (a proposed swap is accepted, otherwise the units are refunded). When no prompt is left,
 * the order goes back to Picking. Idempotent: an answered prompt is never changed again.
 */
async function resolveInTx(
  tx: SubstitutionTx,
  requestId: string,
  how: { by: "customer"; decision: SubstitutionDecision; orderId: string } | { by: "timeout" },
): Promise<ResolveResult> {
  const request = await tx.substitutionRequest.findUnique({ where: { id: requestId } });
  if (!request || (how.by === "customer" && request.orderId !== how.orderId)) return { ok: false, error: "not_found" };
  if (request.status !== "pending") return { ok: false, error: "already_answered" };
  const order = await tx.order.findUnique({ where: { id: request.orderId } });
  if (!order || order.status !== "SUBSTITUTION_PENDING") return { ok: false, error: "not_waiting" };
  if (how.by === "timeout" && request.expiresAt.getTime() > Date.now()) return { ok: false, error: "not_due" };

  const decision: SubstitutionDecision = how.by === "customer" ? how.decision : request.proposedVariantId ? "swap" : "refund";
  if (decision === "swap" && !request.proposedVariantId) return { ok: false, error: "no_swap_offered" };

  const status = how.by === "timeout" ? "timed_out" : decision === "swap" ? "approved" : "declined";
  const answered = await tx.substitutionRequest.updateMany({
    where: { id: request.id, status: "pending" },
    data: { status, answeredAt: new Date() },
  });
  if (answered.count !== 1) return { ok: false, error: "already_answered" };
  await tx.orderLine.update({
    where: { id: request.orderLineId },
    data: decision === "swap"
      ? { status: "substituted", substitutedVariantId: request.proposedVariantId, substitutedUnitPriceCents: request.proposedUnitPriceCents }
      : { status: "refunded" },
  });

  const stillPending = await tx.substitutionRequest.count({ where: { orderId: order.id, status: "pending" } });
  if (stillPending > 0) return { ok: true, orderStatus: "SUBSTITUTION_PENDING" };
  await tx.order.update({ where: { id: order.id }, data: { status: "PICKING" } });
  return { ok: true, orderStatus: "PICKING" };
}

/** The customer's answer. The tracking token is the only credential, so the prompt must be that order's. */
export async function resolveSubstitutionByToken(
  storeId: string,
  token: string,
  requestId: string,
  decision: SubstitutionDecision,
): Promise<ResolveResult> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { trackingToken: token }, select: { id: true } });
    if (!order) return { ok: false, error: "not_found" };
    return resolveInTx(tx, requestId, { by: "customer", decision, orderId: order.id });
  });
}

/** The 10-minute timer. A prompt already answered, or not yet due, is left alone. */
export async function applySubstitutionTimeout(storeId: string, requestId: string): Promise<ResolveResult> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    return resolveInTx(tx, requestId, { by: "timeout" });
  });
}

export type SubstitutionPromptView = {
  id: string;
  status: string;
  expiresAt: string;
  qty: number;
  exactOnly: boolean;
  original: { name: string; unitPriceCents: number };
  proposed: { name: string; unitPriceCents: number } | null;
  deltaCents: number;
  outcome: "swap" | "refund" | null;
};

function variantName(variant: { label: string; listing: { customName: string | null; masterProduct: { name: string } | null } }): string {
  return variant.listing.customName?.trim() || variant.listing.masterProduct?.name?.trim() || variant.label;
}

const NAMED_VARIANT = { include: { listing: { select: { customName: true, masterProduct: { select: { name: true } } } } } } as const;

/** The customer page's view of one order's prompts, opened by the tracking token only. */
export async function substitutionPromptsForToken(storeId: string, token: string) {
  const order = await storeScoped(storeId).order.findUnique({
    where: { trackingToken: token },
    select: {
      id: true,
      number: true,
      status: true,
      substitutionRequests: {
        orderBy: { createdAt: "asc" },
        include: {
          proposedVariant: NAMED_VARIANT,
          orderLine: { select: { status: true, swapRule: true, unitPriceCents: true, listingVariant: NAMED_VARIANT } },
        },
      },
    },
  });
  if (!order) return null;
  const prompts: SubstitutionPromptView[] = order.substitutionRequests.map((request) => ({
    id: request.id,
    status: request.status,
    expiresAt: request.expiresAt.toISOString(),
    qty: request.qty,
    exactOnly: request.orderLine.swapRule === "exact_only",
    original: { name: variantName(request.orderLine.listingVariant), unitPriceCents: request.orderLine.unitPriceCents },
    proposed: request.proposedVariant
      ? { name: variantName(request.proposedVariant), unitPriceCents: request.proposedUnitPriceCents ?? request.proposedVariant.price }
      : null,
    deltaCents: request.proposedUnitPriceCents == null ? 0 : request.qty * (request.proposedUnitPriceCents - request.orderLine.unitPriceCents),
    outcome: request.status === "pending" ? null : request.orderLine.status === "substituted" ? "swap" : "refund",
  }));
  return { number: order.number, status: order.status, prompts };
}
