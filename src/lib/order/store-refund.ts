import { storeScoped } from "../db";
import { money } from "../format";
import { refundOfGoodsCents, serviceFeeRefundCents, taxRefundCents } from "./platform-fee";
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
/** What the owner's refund would return, shown before they confirm (#806): the same figures the refund then uses. */
export type StoreRefundPreview =
  | { ok: true; whole: true; amountCents: number }
  | { ok: true; whole: false; itemsCents: number; couponShareCents: number; serviceFeeCents: number; taxCents: number; amountCents: number }
  | { ok: false; error: string };
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
  const order = await refundableOrder(storeId, orderId);
  if (!order) return { ok: false, error: STORE_REFUND_NOT_FOUND };
  const key = storeRefundKey(orderId, input.submissionId);
  const already = await scoped.refundRequest.findUnique({ where: { key } });
  if (already) return outcome(already);
  if (!order.paymentIntentId || !(STORE_REFUNDABLE_FROM as readonly string[]).includes(order.status)) {
    return { ok: false, error: STORE_REFUND_WRONG_STATUS };
  }

  if (input.picks === "whole_order") {
    if (order.fulfillment === "ship" && order.status === "READY") return cancelled(await cancelShipment(storeId, orderId, actor, {}, reason));
    if ((CANCELLABLE_AFTER_CAPTURE as readonly string[]).includes(order.status)) {
      const result = await cancelCapturedOrder(storeId, orderId, { action: "store_cancel", actor, reason: "other", note: reason }, { from: CANCELLABLE_AFTER_CAPTURE });
      return cancelled(result === "not_claimed" ? { ok: false, error: STORE_REFUND_NOT_STARTED } : result);
    }
  }

  // Read Stripe outside the store lock (ADR-0014); submitRefund re-reads it and refuses again if it moved.
  const amount = refundAmount(order, input.picks, await remainingCaptureCents(order.paymentIntentId));
  if (!amount.ok) return amount;
  const amountCents = amount.amountCents;
  // A whole-order refund names the units left, so the receipt lists them; none left (fee rounding) stores no lines.
  let picks: RefundLinePick[] | null = input.picks === "whole_order" ? unitsLeft(order.lines, order.refundRequests) : input.picks;
  if (picks?.length === 0) picks = null;

  try {
    await submitRefund(storeId, orderId, order.paymentIntentId, {
      cause: "store",
      amountCents,
      picks,
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

/** The owner's refund before they confirm it (#806): what the customer gets back, from the same figures as the refund. */
export async function previewStoreRefund(storeId: string, orderId: string, picks: StoreRefundInput["picks"]): Promise<StoreRefundPreview> {
  const order = await refundableOrder(storeId, orderId);
  if (!order) return { ok: false, error: STORE_REFUND_NOT_FOUND };
  if (!order.paymentIntentId || !(STORE_REFUNDABLE_FROM as readonly string[]).includes(order.status)) {
    return { ok: false, error: STORE_REFUND_WRONG_STATUS };
  }
  return refundAmount(order, picks, await remainingCaptureCents(order.paymentIntentId));
}

function refundableOrder(storeId: string, orderId: string) {
  return storeScoped(storeId).order.findUnique({
    where: { id: orderId },
    include: { lines: true, refundRequests: { select: { state: true, providerStatus: true, taxShareCents: true, lines: true } } },
  });
}

/**
 * The one calculation of a store refund: a whole order returns what is left of the capture; lines return their goods
 * less their coupon share, with those goods' service fee share and tax. Refused above what is left.
 */
function refundAmount(
  order: NonNullable<Awaited<ReturnType<typeof refundableOrder>>>,
  picks: StoreRefundInput["picks"],
  remaining: number,
): StoreRefundPreview {
  const above = { ok: false as const, error: `${STORE_REFUND_ABOVE_REMAINING_PREFIX} (${money(remaining)}).` };
  if (picks === "whole_order") return remaining < 1 ? above : { ok: true, whole: true, amountCents: remaining };
  const lines = refundedLines(order, picks, refundedQtyByLine(order.refundRequests));
  if (!lines || lines.goodsCents <= 0) return { ok: false, error: STORE_REFUND_LINES_INVALID };
  const taxBefore = taxRefundedCents(order.refundRequests);
  const amountCents = refundOfGoodsCents(lines.goodsCents, order, taxBefore, lines.lineTax);
  if (amountCents < 1 || amountCents > remaining) return above;
  const unitPrice = new Map(order.lines.map((line) => [line.id, line.unitPriceCents]));
  const itemsCents = picks.reduce((sum, pick) => sum + pick.qty * (unitPrice.get(pick.lineId) ?? 0), 0);
  return {
    ok: true,
    whole: false,
    itemsCents,
    couponShareCents: itemsCents - lines.goodsCents,
    serviceFeeCents: serviceFeeRefundCents(lines.goodsCents, order),
    taxCents: taxRefundCents(lines.goodsCents, order, taxBefore, lines.lineTax),
    amountCents,
  };
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

function unitsLeft(lines: Array<{ id: string; qtyPicked: number }>, refunds: Parameters<typeof refundedQtyByLine>[0]): RefundLinePick[] {
  const refunded = refundedQtyByLine(refunds);
  return lines
    .map((line) => ({ lineId: line.id, qty: line.qtyPicked - (refunded.get(line.id) ?? 0) }))
    .filter((pick) => pick.qty > 0);
}

function cancelled(result: { ok: true } | { ok: false; error: string }): StoreRefundResult {
  return result.ok ? { ok: true, cancelled: true } : result;
}

function outcome(row: { state: string; providerStatus: string | null; amountCents: number }): StoreRefundResult {
  if (row.state === "NOT_CREATED") return { ok: false, error: STORE_REFUND_REFUSED };
  if (row.providerStatus === "failed" || row.providerStatus === "canceled") return { ok: false, error: STORE_REFUND_FAILED };
  return { ok: true, amountCents: row.amountCents, pending: row.providerStatus !== "succeeded", cancelled: false };
}
