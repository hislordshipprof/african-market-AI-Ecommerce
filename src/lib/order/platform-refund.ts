import { platformAdminTransaction, storeScoped } from "../db";
import { money } from "../format";
import {
  evaluateOrderRefundStateAfterCommit,
  PLATFORM_REFUNDABLE_FROM,
  platformRefundKey,
  remainingCaptureCents,
  submitRefund,
} from "./refund-requests";
import { redactedErrorMessage } from "./staff-copy";

export const PLATFORM_REFUND_REASON_MAX = 500;

export const PLATFORM_REFUND_NOT_FOUND = "Order not found.";
export const PLATFORM_REFUND_WRONG_STATUS = "Only a delivered, completed or partly refunded order can be refunded here.";
export const PLATFORM_REFUND_REASON_MISSING = `Write why you are refunding, up to ${PLATFORM_REFUND_REASON_MAX} characters.`;
export const PLATFORM_REFUND_AMOUNT_INVALID = "Enter an amount of at least $0.01.";
export const PLATFORM_REFUND_ABOVE_REMAINING_PREFIX = "That is more than is left to refund on this order";
export const PLATFORM_REFUND_NOT_STARTED = "The refund was not started: another refund on this order is still confirming, or the order changed. Reload and try again.";
export const PLATFORM_REFUND_REFUSED = "Stripe refused the refund. Nothing was refunded.";
export const PLATFORM_REFUND_FAILED = "The refund failed at Stripe. The customer is not refunded.";

export type PlatformRefundInput = { amountCents: number; reason: string; submissionId: string };
export type PlatformRefundResult =
  | { ok: true; amountCents: number; pending: boolean }
  | { ok: false; error: string };

/**
 * A platform admin refunds a delivered order through the refund ledger (#538). The amount is checked
 * against Stripe before anything is written; the request and its `platform_refund` audit row are
 * reserved together under the store lock, keyed by the form's submission id.
 */
export async function refundOrderAsPlatform(
  orderId: string,
  input: PlatformRefundInput,
  actor: { id: string; email: string },
): Promise<PlatformRefundResult> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > PLATFORM_REFUND_REASON_MAX) return { ok: false, error: PLATFORM_REFUND_REASON_MISSING };
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) return { ok: false, error: PLATFORM_REFUND_AMOUNT_INVALID };

  const order = await platformAdminTransaction((tx) =>
    tx.order.findUnique({ where: { id: orderId }, select: { storeId: true, status: true, paymentIntentId: true } }));
  if (!order) return { ok: false, error: PLATFORM_REFUND_NOT_FOUND };
  const key = platformRefundKey(orderId, input.submissionId);
  const already = await storeScoped(order.storeId).refundRequest.findUnique({ where: { key } });
  if (already) return outcome(already);
  if (!order.paymentIntentId || !(PLATFORM_REFUNDABLE_FROM as readonly string[]).includes(order.status)) {
    return { ok: false, error: PLATFORM_REFUND_WRONG_STATUS };
  }
  // Read Stripe outside the store lock (ADR-0014); submitRefund re-reads it and refuses again if it moved.
  const remaining = await remainingCaptureCents(order.paymentIntentId);
  if (input.amountCents > remaining) return { ok: false, error: `${PLATFORM_REFUND_ABOVE_REMAINING_PREFIX} (${money(remaining)}).` };

  try {
    await submitRefund(order.storeId, orderId, order.paymentIntentId, {
      cause: "platform",
      amountCents: input.amountCents,
      submissionId: input.submissionId,
      reason,
      actor,
    });
  } catch (err) {
    // A reserved request is replayed by the ledger sweep; the row read below says where it stands.
    console.error(`Platform refund for order ${orderId} did not finish: ${redactedErrorMessage(err)}`);
  }
  const reserved = await storeScoped(order.storeId).refundRequest.findUnique({ where: { key } });
  if (!reserved) return { ok: false, error: PLATFORM_REFUND_NOT_STARTED };
  await evaluateOrderRefundStateAfterCommit(orderId);
  return outcome(reserved);
}

function outcome(row: { state: string; providerStatus: string | null; amountCents: number }): PlatformRefundResult {
  if (row.state === "NOT_CREATED") return { ok: false, error: PLATFORM_REFUND_REFUSED };
  if (row.providerStatus === "failed" || row.providerStatus === "canceled") return { ok: false, error: PLATFORM_REFUND_FAILED };
  return { ok: true, amountCents: row.amountCents, pending: row.providerStatus !== "succeeded" };
}
