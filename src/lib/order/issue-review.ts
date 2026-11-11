import { lockStoreRow, storeScoped, storeScopedTransaction } from "../db";
import { money } from "../format";
import { evaluateOrderRefundState, remainingCaptureCents, submitRefund } from "./refund-requests";
import { redactedErrorMessage } from "./staff-copy";

export const ISSUE_NOT_FOUND = "Problem not found";
export const ISSUE_ALREADY_HANDLED = "This problem was already handled";
export const ISSUE_DECLINE_REASON_MISSING = "Write why you are declining";
export const ISSUE_REFUND_NOT_STARTED = "The refund could not be started. Try again.";
export const ISSUE_AMOUNT_ABOVE_ISSUE = "Enter an amount from $0.01 up to the reported amount.";
export const ISSUE_AMOUNT_ABOVE_CAPTURE_PREFIX = "That is more than is left to refund on this order";

type Actor = { id: string; email: string };
type ReviewResult = { ok: true } | { ok: false; error: string };

/** The in-review issues for the store's "Problems to review" list, oldest first. */
export async function issuesToReview(storeId: string) {
  const issues = await storeScoped(storeId).issueReport.findMany({
    where: { state: "in_review" },
    orderBy: { createdAt: "asc" },
    include: {
      order: {
        select: {
          number: true,
          fulfillment: true,
          customer: { select: { name: true } },
          lines: {
            select: {
              id: true,
              unitPriceCents: true,
              listingVariant: {
                select: { label: true, listing: { select: { customName: true, masterProduct: { select: { name: true } } } } },
              },
            },
          },
        },
      },
    },
  });
  return issues.map((issue) => {
    const byId = new Map(issue.order.lines.map((line) => [line.id, line]));
    const chosen = Array.isArray(issue.lines) ? (issue.lines as Array<{ lineId: string; qty: number }>) : [];
    return {
      id: issue.id,
      type: issue.type,
      note: issue.note,
      hasPhoto: !!issue.photoKey,
      amountCents: issue.amountCents,
      createdAt: issue.createdAt,
      orderNumber: issue.order.number,
      fulfillment: issue.order.fulfillment,
      customerName: issue.order.customer.name,
      lines: chosen.flatMap((pick) => {
        const line = byId.get(pick.lineId);
        if (!line) return [];
        const listing = line.listingVariant.listing;
        const name = listing.customName ?? listing.masterProduct?.name ?? "Item";
        return [{ name, variant: line.listingVariant.label, qty: pick.qty, cents: pick.qty * line.unitPriceCents }];
      }),
    };
  });
}

export type IssueToReview = Awaited<ReturnType<typeof issuesToReview>>[number];

/**
 * A store member approves an in-review issue for its full amount or a partial one, through the
 * refund ledger. The issue row is claimed under the store lock, so a second click refunds nothing.
 */
export async function approveIssue(storeId: string, issueId: string, actor: Actor, amountCents?: number): Promise<ReviewResult> {
  const issue = await storeScoped(storeId).issueReport.findUnique({
    where: { id: issueId },
    include: { order: { select: { paymentIntentId: true } } },
  });
  if (!issue) return { ok: false, error: ISSUE_NOT_FOUND };
  if (issue.state !== "in_review" || issue.refundRequestId) return { ok: false, error: ISSUE_ALREADY_HANDLED };
  const paymentIntentId = issue.order.paymentIntentId;
  if (!paymentIntentId) return { ok: false, error: ISSUE_REFUND_NOT_STARTED };
  const amount = amountCents ?? issue.amountCents;
  if (!Number.isInteger(amount) || amount < 1 || amount > issue.amountCents) return { ok: false, error: ISSUE_AMOUNT_ABOVE_ISSUE };
  const remaining = await remainingCaptureCents(paymentIntentId);
  if (amount > remaining) return { ok: false, error: `${ISSUE_AMOUNT_ABOVE_CAPTURE_PREFIX} (${money(remaining)}).` };

  const claimed = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const won = await tx.issueReport.updateMany({
      where: { id: issueId, state: "in_review", refundRequestId: null },
      data: { state: "approved", amountCents: amount },
    });
    if (won.count !== 1) return false;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "issue_approved",
        entityType: "order",
        entityId: issue.orderId,
        before: { state: "in_review", amountCents: issue.amountCents },
        after: { issueReportId: issueId, amountCents: amount },
      },
    });
    return true;
  });
  if (!claimed) return { ok: false, error: ISSUE_ALREADY_HANDLED };

  try {
    const refund = await submitRefund(storeId, issue.orderId, paymentIntentId, { cause: "issue", amountCents: amount, issueReportId: issueId });
    if ("amountRefunded" in refund && refund.amountRefunded < amount) {
      await storeScoped(storeId).issueReport.update({ where: { id: issueId }, data: { amountCents: refund.amountRefunded } });
    }
  } catch (err) {
    // An open request is replayed by the ledger sweep; one Stripe refused is marked refund_failed by the evaluation below.
    console.error(`Issue approval refund for order ${issue.orderId} did not finish: ${redactedErrorMessage(err)}`);
  }
  const reserved = await storeScoped(storeId).issueReport.findUniqueOrThrow({ where: { id: issueId }, select: { refundRequestId: true } });
  if (!reserved.refundRequestId) {
    // No request was reserved (blocked, or another refund is open): back to the queue, with the attempt on record.
    await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      await tx.issueReport.updateMany({
        where: { id: issueId, state: "approved", refundRequestId: null },
        data: { state: "in_review", amountCents: issue.amountCents },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: actor.id,
          actorEmail: actor.email,
          action: "issue_approval_not_started",
          entityType: "order",
          entityId: issue.orderId,
          after: { issueReportId: issueId, amountCents: amount },
        },
      });
    });
    return { ok: false, error: ISSUE_REFUND_NOT_STARTED };
  }
  await evaluateOrderRefundState(issue.orderId);
  return { ok: true };
}

/** A store member declines an in-review issue with a reason. No money moves and the order is untouched. */
export async function declineIssue(storeId: string, issueId: string, actor: Actor, reason: string): Promise<ReviewResult> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const issue = await tx.issueReport.findUnique({ where: { id: issueId } });
    if (!issue) return { ok: false as const, error: ISSUE_NOT_FOUND };
    if (issue.state !== "in_review" || issue.refundRequestId) return { ok: false as const, error: ISSUE_ALREADY_HANDLED };
    await tx.issueReport.update({ where: { id: issueId }, data: { state: "declined" } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "issue_declined",
        entityType: "order",
        entityId: issue.orderId,
        before: { state: "in_review" },
        after: { issueReportId: issueId, reason },
      },
    });
    return { ok: true as const };
  });
}
