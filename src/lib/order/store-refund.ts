import { storeScoped } from "../db";
import { money } from "../format";
import { refundOfGoodsCents } from "./platform-fee";
import {
  evaluateOrderRefundStateAfterCommit,
  refundedLines,
  refundedQtyByLine,
  remainingCaptureCents,
  storeRefundKey,
  submitRefund,
  taxRefundedCents,
  type RefundLinePick,
} from "./refund-requests";
import { cancelCapturedOrder, cancelShipment } from "./service";
import { CANCELLABLE_AFTER_CAPTURE, STORE_REFUNDABLE_FROM } from "./constants";
import { redactedErrorMessage } from "./staff-copy";

export const STORE_REFUND_REASON_MAX = 500;

export const STORE_REFUND_NOT_FOUND = "Order not found.";
export const STORE_REFUND_WRONG_STATUS = "This order cannot be refunded now. Only a paid order from Ready onward can be refunded.";
export const STORE_REFUND_REASON_MISSING = `Write why you are refunding, up to ${STORE_REFUND_REASON_MAX} characters.`;
export const STORE_REFUND_LINES_INVALID = "Choose at least one item, and no more than is left to refund of it.";
export const STORE_REFUND_ABOVE_REMAINING_PREFIX = "That is more than is left to refund on this order";
export const STORE_REFUND_NOT_STARTED = "The refund was not started: another refund on this order is still confirming, or the order changed. Reload and try again.";
export const STORE_REFUND_REFUSED = "Stripe refused the refund. Nothing was refunded.";
export const STORE_REFUND_FAILED = "The refund failed at Stripe. The customer is not refunded.";
export const NO_SHOW_WRONG_STATUS = "Only a pickup order that is ready for pickup can be marked as not collected.";

export type StoreRefundInput = { picks: RefundLinePick[] | "whole_order"; reason: string; submissionId: string };
export type StoreRefundResult =
  | { ok: true; amountCents: number; pending: boolean; cancelled: false }
  | { ok: true; cancelled: true }
  | { ok: false; error: string };

type Actor = { id: string; email: string };

/**
 * The owner refunds lines or the whole order after capture (#798), through the refund ledger (ADR-0019). A whole
 * order the store still holds is cancelled instead: the capture is refunded in full and the order is Cancelled.
 */
export async function refundOrderAsStore(storeId: string, orderId: string, input: StoreRefundInput, actor: Actor): Promise<StoreRefundResult> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > STORE_REFUND_REASON_MAX) return { ok: false, error: STORE_REFUND_REASON_MISSING };

  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUnique({
    where: { id: orderId },
    include: { lines: true, refundRequests: { select: { state: true, providerStatus: true, taxShareCents: true, lines: true } } },
  });
  if (!order) return { ok: false, error: STORE_REFUND_NOT_FOUND };
  const key = storeRefundKey(orderId, input.submissionId);
  const already = await scoped.refundRequest.findUnique({ where: { key } });
  if (already) return outcome(already);
  if (!order.paymentIntentId || !(STORE_REFUNDABLE_FROM as readonly string[]).includes(order.status)) {
    return { ok: false, error: STORE_REFUND_WRONG_STATUS };
  }

  if (input.picks === "whole_order") {
    if (order.fulfillment === "ship" && order.status === "READY") return cancelled(await cancelShipment(storeId, orderId, actor));
    if ((CANCELLABLE_AFTER_CAPTURE as readonly string[]).includes(order.status)) {
      const result = await cancelCapturedOrder(storeId, orderId, { action: "store_cancel", actor, reason: "other", note: reason }, { from: CANCELLABLE_AFTER_CAPTURE });
      return cancelled(result === "not_claimed" ? { ok: false, error: STORE_REFUND_NOT_STARTED } : result);
    }
  }

  // Read Stripe outside the store lock (ADR-0014); submitRefund re-reads it and refuses again if it moved.
  const remaining = await remainingCaptureCents(order.paymentIntentId);
  let amountCents = remaining;
  if (input.picks !== "whole_order") {
    const lines = refundedLines(order, input.picks, refundedQtyByLine(order.refundRequests));
    if (!lines || lines.goodsCents <= 0) return { ok: false, error: STORE_REFUND_LINES_INVALID };
    amountCents = refundOfGoodsCents(lines.goodsCents, order, taxRefundedCents(order.refundRequests), lines.lineTax);
  }
  if (amountCents < 1) return { ok: false, error: `${STORE_REFUND_ABOVE_REMAINING_PREFIX} (${money(remaining)}).` };
  if (amountCents > remaining) return { ok: false, error: `${STORE_REFUND_ABOVE_REMAINING_PREFIX} (${money(remaining)}).` };

  try {
    await submitRefund(storeId, orderId, order.paymentIntentId, {
      cause: "store",
      amountCents,
      picks: input.picks === "whole_order" ? null : input.picks,
      submissionId: input.submissionId,
      reason,
      actor,
    });
  } catch (err) {
    // A reserved request is replayed by the ledger sweep; the row read below says where it stands.
    console.error(`Store refund for order ${orderId} did not finish: ${redactedErrorMessage(err)}`);
  }
  const reserved = await scoped.refundRequest.findUnique({ where: { key } });
  if (!reserved) return { ok: false, error: STORE_REFUND_NOT_STARTED };
  await evaluateOrderRefundStateAfterCommit(orderId);
  return outcome(reserved);
}

/**
 * A pickup order the customer never collected (#798): cancelled with the reason `no_show`, and the capture refunded
 * in full. A kept no-show fee is not built: no store policy for one exists yet.
 */
export async function markNoShow(storeId: string, orderId: string, actor: Actor, note: string | null): Promise<StoreRefundResult> {
  const order = await storeScoped(storeId).order.findUnique({ where: { id: orderId }, select: { status: true, fulfillment: true } });
  if (!order) return { ok: false, error: STORE_REFUND_NOT_FOUND };
  if (order.fulfillment !== "pickup" || order.status !== "AWAITING_PICKUP") return { ok: false, error: NO_SHOW_WRONG_STATUS };
  const result = await cancelCapturedOrder(
    storeId,
    orderId,
    { action: "store_cancel", actor, reason: "no_show", note: note?.trim().slice(0, STORE_REFUND_REASON_MAX) || null },
    { from: ["AWAITING_PICKUP"], fulfillment: "pickup" },
  );
  return cancelled(result === "not_claimed" ? { ok: false, error: NO_SHOW_WRONG_STATUS } : result);
}

function cancelled(result: { ok: true } | { ok: false; error: string }): StoreRefundResult {
  return result.ok ? { ok: true, cancelled: true } : result;
}

function outcome(row: { state: string; providerStatus: string | null; amountCents: number }): StoreRefundResult {
  if (row.state === "NOT_CREATED") return { ok: false, error: STORE_REFUND_REFUSED };
  if (row.providerStatus === "failed" || row.providerStatus === "canceled") return { ok: false, error: STORE_REFUND_FAILED };
  return { ok: true, amountCents: row.amountCents, pending: row.providerStatus !== "succeeded", cancelled: false };
}
