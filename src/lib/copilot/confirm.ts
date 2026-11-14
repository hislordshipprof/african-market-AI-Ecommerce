import { Prisma, lockListingRow, lockStoreRow, storeScoped, storeScopedTransaction, txQuery } from "../db";
import { cardFromParts, listingLabel } from "./cards";
import {
  QTY_COLUMN_MAX,
  WRITE_TRANSACTION,
  type ConfirmResult,
  type CopilotActor,
  type ProposalKind,
  type RejectResult,
  type StockProposalCard,
} from "./types";

const EVENT_TYPE: Record<ProposalKind, string> = {
  restock: "restock",
  counter_sale: "counter_sale",
  recount: "recount",
  set_status: "adjust",
};

interface ProposalRow {
  id: string;
  storeId: string;
  listingId: string;
  kind: string;
  quantity: number | null;
  statusValue: string | null;
  before: unknown;
  state: string;
}

interface ListingRow {
  id: string;
  customName: string | null;
  stockMode: string;
  qty: number | null;
  status: string | null;
  masterProduct: { name: string } | null;
}

function cardFor(proposal: ProposalRow, listing: ListingRow, state: string): StockProposalCard {
  return cardFromParts({
    id: proposal.id,
    listingId: proposal.listingId,
    listingName: listingLabel(listing),
    kind: proposal.kind,
    quantity: proposal.quantity,
    statusValue: proposal.statusValue,
    before: proposal.before,
    state,
  });
}

function fits(kind: string, stockMode: string): boolean {
  if (kind === "set_status") return stockMode === "status";
  return stockMode === "counted";
}

type StockTx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/**
 * The copilot's one stock write, under the caller's store and listing locks: a stock event,
 * the new qty or status at confidence 1, and a `listing.stock_change` audit row naming the owner.
 */
export async function writeStockChange(
  tx: StockTx,
  storeId: string,
  listing: ListingRow,
  change: { kind: ProposalKind; quantity: number; statusValue: string | null },
  actor: CopilotActor,
  idempotencyKey: string,
  source: Record<string, string>,
  now: Date,
) {
  const { kind, quantity } = change;
  const liveQty = listing.qty ?? 0;
  let nextQty = listing.qty;
  let delta = 0;
  if (kind === "restock") {
    nextQty = liveQty + quantity;
    delta = quantity;
  } else if (kind === "counter_sale") {
    nextQty = Math.max(0, liveQty - quantity);
    delta = -quantity;
  } else if (kind === "recount") {
    nextQty = quantity;
    delta = quantity - liveQty;
  }

  await tx.stockEvent.create({
    data: {
      storeId,
      listingId: listing.id,
      type: EVENT_TYPE[kind],
      delta,
      actorId: actor.id,
      idempotencyKey,
      createdAt: now,
    },
  });
  const updated = await tx.listing.update({
    where: { id: listing.id },
    data: {
      ...(kind === "set_status" ? { status: change.statusValue } : { qty: nextQty }),
      confidence: 1,
      confidenceUpdatedAt: now,
    },
  });
  const beforeStock = listing.stockMode === "counted" ? { qty: listing.qty } : { status: listing.status };
  const afterStock = kind === "set_status"
    ? { status: updated.status, source: "copilot", ...source }
    : { qty: updated.qty, source: "copilot", ...source };
  await tx.auditLog.create({
    data: {
      storeId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "listing.stock_change",
      entityType: "listing",
      entityId: listing.id,
      before: beforeStock,
      after: afterStock,
    },
  });
  return updated;
}

async function confirmedResult(
  tx: StockTx,
  proposal: ProposalRow,
  listing: ListingRow,
): Promise<ConfirmResult> {
  const current = await tx.listing.findUnique({ where: { id: listing.id }, select: { qty: true, status: true } });
  return {
    ok: true,
    proposal: cardFor(proposal, listing, "confirmed"),
    listing: { qty: current?.qty ?? listing.qty, status: current?.status ?? listing.status },
  };
}

/** Applies one pending proposal. Callers authenticate the owner before this. */
export async function confirmProposal(storeId: string, proposalId: string, actor: CopilotActor): Promise<ConfirmResult> {
  const peek = await storeScoped(storeId).stockProposal.findUnique({
    where: { id: proposalId },
    select: { listingId: true, state: true },
  });
  if (!peek) return { ok: false, code: "not_found" };
  if (peek.state === "rejected" || peek.state === "expired") return { ok: false, code: "not_found" };

  try {
    return await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      await lockListingRow(tx, peek.listingId);
      const now = new Date();

      const proposal = await tx.stockProposal.findUnique({ where: { id: proposalId } });
      if (!proposal || proposal.storeId !== storeId) return { ok: false, code: "not_found" };
      const listing = await tx.listing.findUnique({
        where: { id: proposal.listingId },
        include: { masterProduct: { select: { name: true } } },
      });
      if (!listing) return { ok: false, code: "not_found" };
      if (proposal.state === "confirmed") return confirmedResult(tx, proposal, listing);
      if (proposal.state !== "pending") return { ok: false, code: "not_found" };

      const clock = await txQuery<Array<{ expired: boolean }>>(tx, Prisma.sql`
        SELECT expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired
        FROM stock_proposals
        WHERE id = ${proposalId}
      `);
      if (clock[0]?.expired) {
        await tx.stockProposal.update({ where: { id: proposalId }, data: { state: "expired" } });
        return { ok: false, code: "expired" };
      }
      if (!fits(proposal.kind, listing.stockMode)) {
        await tx.stockProposal.update({ where: { id: proposalId }, data: { state: "expired" } });
        return { ok: false, code: "stale" };
      }

      const kind = proposal.kind as ProposalKind;
      const quantity = proposal.quantity ?? 0;
      const liveQty = listing.qty ?? 0;
      if (kind === "restock" && liveQty + quantity > QTY_COLUMN_MAX) {
        return { ok: false, code: "too_large" };
      }

      const claimed = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
        UPDATE stock_proposals
        SET state = 'confirmed', decided_by_id = ${actor.id}, decided_at = ${now}
        WHERE id = ${proposalId}
          AND state = 'pending'
          AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
        RETURNING id
      `);
      if (claimed.length === 0) {
        const again = await tx.stockProposal.findUnique({ where: { id: proposalId } });
        if (again?.state === "confirmed") return confirmedResult(tx, again, listing);
        return { ok: false, code: "not_found" };
      }

      const updated = await writeStockChange(tx, storeId, listing, {
        kind,
        quantity,
        statusValue: proposal.statusValue,
      }, actor, `copilot:${proposalId}`, { proposalId }, now);

      const decided = await tx.stockProposal.findUniqueOrThrow({ where: { id: proposalId } });
      return {
        ok: true,
        proposal: cardFor(decided, listing, "confirmed"),
        listing: { qty: updated.qty, status: updated.status },
      };
    }, WRITE_TRANSACTION);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const again = await storeScoped(storeId).stockProposal.findUnique({ where: { id: proposalId } });
      if (again?.state === "confirmed") {
        const listing = await storeScoped(storeId).listing.findUnique({
          where: { id: again.listingId },
          include: { masterProduct: { select: { name: true } } },
        });
        if (listing) {
          return {
            ok: true,
            proposal: cardFor(again, listing, "confirmed"),
            listing: { qty: listing.qty, status: listing.status },
          };
        }
      }
    }
    throw error;
  }
}

/** Dismisses a pending proposal. The first of confirm and dismiss to claim the row wins. */
export async function rejectProposal(storeId: string, proposalId: string, actor: CopilotActor): Promise<RejectResult> {
  const peek = await storeScoped(storeId).stockProposal.findUnique({
    where: { id: proposalId },
    select: { listingId: true, state: true },
  });
  if (!peek || peek.state !== "pending") return { ok: false, code: "not_found" };

  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockListingRow(tx, peek.listingId);
    const now = new Date();
    const proposal = await tx.stockProposal.findUnique({ where: { id: proposalId } });
    if (!proposal || proposal.state !== "pending") return { ok: false, code: "not_found" };
    const claimed = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
      UPDATE stock_proposals
      SET state = 'rejected', decided_by_id = ${actor.id}, decided_at = ${now}
      WHERE id = ${proposalId} AND state = 'pending'
      RETURNING id
    `);
    if (claimed.length === 0) return { ok: false, code: "not_found" };
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "copilot.stock_rejected",
        entityType: "stock_proposal",
        entityId: proposalId,
        before: { state: "pending" },
        after: { kind: proposal.kind, quantity: proposal.quantity, status: proposal.statusValue },
      },
    });
    return { ok: true };
  }, WRITE_TRANSACTION);
}

export type AlertAnswer = { answer: "still_have"; qty: number } | { answer: "sold_out" } | { answer: "in_stock" };

export type AnswerResult =
  | { ok: true; listing: { qty: number | null; status: string | null } }
  | { ok: false; code: "not_found" | "stale" };

/** "Still have N" and "Sold out" recount a counted listing; "Sold out" and "In stock" set a status listing. */
function changeFor(answer: AlertAnswer, stockMode: string): { kind: ProposalKind; quantity: number; statusValue: string | null } | null {
  if (stockMode === "counted") {
    if (answer.answer === "still_have") return { kind: "recount", quantity: answer.qty, statusValue: null };
    if (answer.answer === "sold_out") return { kind: "recount", quantity: 0, statusValue: null };
    return null;
  }
  if (answer.answer === "sold_out") return { kind: "set_status", quantity: 0, statusValue: "out_of_stock" };
  if (answer.answer === "in_stock") return { kind: "set_status", quantity: 0, statusValue: "in_stock" };
  return null;
}

/**
 * The owner's one-tap answer to an open alert. Writes through the same locked stock write as a
 * proposal, with no StockProposal, then resolves this alert and every open alert on the listing.
 * Callers authenticate the owner before this.
 */
export async function answerAlert(storeId: string, alertId: string, answer: AlertAnswer, actor: CopilotActor): Promise<AnswerResult> {
  const peek = await storeScoped(storeId).copilotAlert.findUnique({
    where: { id: alertId },
    select: { listingId: true, state: true },
  });
  if (!peek || peek.state !== "open") return { ok: false, code: "not_found" };

  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockListingRow(tx, peek.listingId);
    const now = new Date();
    const listing = await tx.listing.findUnique({
      where: { id: peek.listingId },
      include: { masterProduct: { select: { name: true } } },
    });
    if (!listing) return { ok: false, code: "not_found" };
    const change = changeFor(answer, listing.stockMode);
    if (!change) return { ok: false, code: "stale" };

    const claimed = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
      UPDATE copilot_alerts
      SET state = 'resolved', resolved_by_id = ${actor.id}, resolved_at = ${now}
      WHERE id = ${alertId} AND state = 'open'
      RETURNING id
    `);
    if (claimed.length === 0) return { ok: false, code: "not_found" };

    const updated = await writeStockChange(tx, storeId, listing, change, actor, `copilot-alert:${alertId}`, { alertId }, now);
    await tx.copilotAlert.updateMany({
      where: { listingId: listing.id, state: "open" },
      data: { state: "resolved", resolvedById: actor.id, resolvedAt: now },
    });
    return { ok: true, listing: { qty: updated.qty, status: updated.status } };
  }, WRITE_TRANSACTION);
}
