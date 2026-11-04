import { storeScoped, storeScopedTransaction, lockStoreRow, findOrderByPaymentIntent } from "../db";
import { getStripeProvider } from "../stripe";
import { isIdempotencyKeyInUse, isRetryableProviderError, OverRefundError } from "../stripe/errors";
import { ProviderStateError, type RefundResult } from "../stripe/types";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";
import { RESOLVED_LINE_STATUSES, type OrderLineStatus } from "./constants";
import { applicationFeeForCapture, platformFeeCentsForCapture } from "./platform-fee";
export type { OrderLineStatus } from "./constants";

export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "CANCELLING"
  | "CAPTURING"
  | "READY"
  | "AWAITING_PICKUP"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUND_FAILED";

// Stripe USD minimum capture: $0.50 (50 cents).
// https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const STRIPE_USD_MINIMUM_CENTS = 50;
const MAX_CAPTURE_ATTEMPTS = 5;
const REFUND_APPLICATION_FEE = { refundApplicationFee: true } as const;

function greaterThanUnrefunded(err: unknown): boolean {
  return err instanceof OverRefundError;
}

/** Refund whatever of a captured charge is still unrefunded. A concurrent refund is re-read once. */
async function refundCapturedBalance(
  paymentIntentId: string,
  orderId: string,
  storeId: string,
): Promise<RefundResult> {
  const stripe = getStripeProvider();
  let pi = await stripe.retrievePaymentIntent(paymentIntentId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const already = pi.amountRefunded ?? 0;
    const remaining = Math.max(0, pi.amountReceived - already);
    if (remaining === 0) {
      return refundRecordedOnCharge(paymentIntentId, pi.amountReceived);
    }
    const reservedRefund = await reserveAttempt(storeId, orderId, "refund_retry", {
      alreadyRefundedCents: already,
    });
    if (!reservedRefund.ok) throw new Error("Refund attempt is still in backoff");
    const refundAttempt = reservedRefund.attempt;
    try {
      const refund = await stripe.refundPayment(
        paymentIntentId,
        remaining,
        `refund:${orderId}:${already}:${refundAttempt}`,
        REFUND_APPLICATION_FEE,
      );
      const after = await stripe.retrievePaymentIntent(paymentIntentId);
      const covered = after.amountRefunded ?? already + refund.amountRefunded;
      if (refund.status === "succeeded" && covered < after.amountReceived) {
        pi = after;
        continue;
      }
      return refund;
    } catch (err) {
      if (attempt === 0 && greaterThanUnrefunded(err)) {
        pi = await stripe.retrievePaymentIntent(paymentIntentId);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Refund did not cover the captured amount");
}

/** A zero balance is not settlement. Pending refunds count toward amount_refunded. */
async function refundRecordedOnCharge(
  paymentIntentId: string,
  amountReceived: number,
): Promise<RefundResult> {
  const listed = await getStripeProvider().listRefunds(paymentIntentId);
  const pending = listed.find((refund) => refund.status === "pending" || refund.status === "requires_action");
  if (pending) return pending;
  const succeeded = listed.filter((refund) => refund.status === "succeeded");
  const covered = succeeded.reduce((sum, refund) => sum + refund.amountRefunded, 0);
  if (covered >= amountReceived && succeeded.length > 0) {
    // listRefunds is newest first. The audit records the sum, and the order keeps the newest id.
    return { ...succeeded[0], amountRefunded: covered };
  }
  const failed = listed.find((refund) => isTerminalRefundStatus(refund.status));
  if (failed) return failed;
  throw new Error("Captured amount is marked refunded but no refund covers it");
}

function captureKey(orderId: string, attempt: number): string {
  return `capture:${orderId}:${attempt}`;
}

function cancelKey(orderId: string, attempt: number): string {
  return `cancel:${orderId}:${attempt}`;
}

async function reserveAttempt(
  storeId: string,
  orderId: string,
  action: "capture_retry" | "cancel_retry" | "refund_retry",
  extra: Record<string, unknown> = {},
): Promise<{ ok: true; attempt: number } | { ok: false; waitMs: number }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const prior = await tx.auditLog.findMany({
      where: { entityId: orderId, action },
      orderBy: { createdAt: "desc" },
    });
    if (action === "capture_retry" && prior.length > 0) {
      const latest = prior[0];
      const after = latest.after as { attempt?: number } | null;
      const previous = typeof after?.attempt === "number" ? after.attempt : prior.length;
      const waitMs = captureBackoffMs(previous) - (Date.now() - latest.createdAt.getTime());
      if (waitMs > 0) return { ok: false, waitMs };
    }
    const attempt = prior.length + 1;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action,
        entityType: "order",
        entityId: orderId,
        after: { attempt, ...extra },
      },
    });
    return { ok: true, attempt };
  });
}

function captureBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

function isTerminalRefundStatus(status: string): boolean {
  return status === "failed" || status === "canceled";
}

const ACTIVE_STATUSES: OrderStatus[] = [
  "AUTHORIZED",
  "ACCEPTED",
  "PICKING",
  "CAPTURING",
  "CANCELLING",
  "READY",
  "AWAITING_PICKUP",
  "REFUND_FAILED",
];

const ORDER_WITH_LINES = {
  customer: { select: { name: true, phone: true } },
  lines: {
    include: {
      listingVariant: {
        include: {
          listing: {
            select: {
              id: true,
              customName: true,
              frozen: true,
              perishable: true,
              masterProduct: { select: { name: true } },
            },
          },
        },
      },
    },
  },
} as const;

export async function getStoreOrders(storeId: string) {
  return storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      include: ORDER_WITH_LINES,
      orderBy: { createdAt: "desc" },
    });
  });
}

export type StoreOrderRow = Awaited<ReturnType<typeof getStoreOrders>>[number];

export async function acceptOrder(
  storeId: string,
  orderId: string,
  prepEstimateMinutes: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clamped = Math.max(1, Math.min(120, Math.round(prepEstimateMinutes)));
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AUTHORIZED") {
      return { ok: false, error: `Cannot accept order in status ${order.status}` };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "ACCEPTED",
        prepEstimateMinutes: clamped,
        acceptedAt: new Date(),
      },
    });

    return { ok: true };
  });
}

export async function markLinePicked(
  storeId: string,
  lineId: string,
): Promise<{ ok: true; orderStatus: OrderStatus } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);

    const lines = await tx.orderLine.findMany({ where: { id: lineId } });
    const line = lines[0];
    if (!line) return { ok: false, error: "Order line not found" };
    if (line.status !== "pending") {
      return { ok: false, error: `Line already resolved (${line.status})` };
    }

    const order = await tx.order.findUnique({ where: { id: line.orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "ACCEPTED" && order.status !== "PICKING") {
      return { ok: false, error: `Cannot pick lines for order in status ${order.status}` };
    }

    await tx.orderLine.update({
      where: { id: lineId },
      data: { status: "picked", qtyPicked: line.qtyOrdered },
    });

    if (order.status === "ACCEPTED") {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "PICKING" },
      });
    }

    return { ok: true, orderStatus: "PICKING" };
  });
}

type CaptureRetryResult =
  | { ok: true; capturedAmountCents: number }
  | { ok: false; error: string; resolved: "cancelled" | "pending" };

async function noteCaptureServerError(
  storeId: string,
  orderId: string,
  attempt: number,
): Promise<CaptureRetryResult> {
  if (attempt >= MAX_CAPTURE_ATTEMPTS) {
    return settleUnconfirmedCapture(storeId, orderId);
  }
  return { ok: false, error: "Card capture failed temporarily; we'll retry", resolved: "pending" };
}

async function settleUnconfirmedCapture(
  storeId: string,
  orderId: string,
): Promise<CaptureRetryResult> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({ where: { id: orderId } });
  });
  if (!order || order.status !== "CAPTURING" || !order.paymentIntentId) {
    return { ok: false, error: "Order status changed during capture", resolved: "pending" };
  }

  const stripe = getStripeProvider();
  let pi;
  try {
    pi = await stripe.retrievePaymentIntent(order.paymentIntentId);
  } catch (err) {
    if (isRetryableProviderError(err)) {
      return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
    }
    throw err;
  }

  if (pi.status === "succeeded") {
    await finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, pi.amountReceived);
    return { ok: true, capturedAmountCents: pi.amountReceived };
  }

  if (pi.status === "requires_capture") {
    const reservedRelease = await reserveAttempt(storeId, orderId, "cancel_retry", { releaseHold: true });
    if (!reservedRelease.ok) {
      return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
    }
    const releaseAttempt = reservedRelease.attempt;
    try {
      await stripe.cancelPaymentIntent(order.paymentIntentId, cancelKey(orderId, releaseAttempt));
    } catch (err) {
      if (isRetryableProviderError(err)) {
        return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
      }
      if (err instanceof ProviderStateError) {
        let fresh;
        try {
          fresh = await stripe.retrievePaymentIntent(order.paymentIntentId);
        } catch (retrieveErr) {
          if (isRetryableProviderError(retrieveErr)) {
            return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
          }
          throw retrieveErr;
        }
        if (fresh.status === "succeeded") {
          await finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, fresh.amountReceived);
          return { ok: true, capturedAmountCents: fresh.amountReceived };
        }
        if (fresh.status !== "canceled") {
          return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
        }
      } else {
        throw err;
      }
    }
    await finalizeCancelFromSweep(storeId, orderId, "capture_released");
    return {
      ok: false,
      error: "Payment authorization was released — order cancelled; contact the customer",
      resolved: "cancelled",
    };
  }

  if (pi.status === "canceled") {
    await finalizeCancelFromSweep(storeId, orderId, "reconcile_cancel");
    return {
      ok: false,
      error: "Payment authorization was released — order cancelled; contact the customer",
      resolved: "cancelled",
    };
  }

  return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
}

async function registerE2EPayment(paymentIntentId: string, authorizedCents: number): Promise<void> {
  // `next start` is NODE_ENV=production. The e2e flag still selects the fake locally.
  // Vercel must never register seed PaymentIntents on the fake.
  if (process.env.E2E_FAKE_STRIPE !== "1" || process.env.VERCEL) {
    return;
  }
  const { ensureAuthorizedAmount } = await import("../stripe/fake");
  ensureAuthorizedAmount(paymentIntentId, authorizedCents);
}

async function persistRefundFailure(
  storeId: string,
  orderId: string,
  refundId: string,
  refundStatus: string,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CANCELLING" && current.status !== "CANCELLED")) return;
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REFUND_FAILED", refundId },
    });
    const existing = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_failed" },
    });
    if (existing) return;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "refund_failed",
        entityType: "order",
        entityId: orderId,
        after: { refundId, refundStatus, alert: "store_and_platform" },
      },
    });
  });
  console.error(
    `Refund ${refundStatus} for order ${orderId} (${refundId}). Customer is still charged. Store and platform alerted.`,
  );
}

async function settleCapturedRefund(
  storeId: string,
  orderId: string,
  paymentIntentId: string,
  refund: RefundResult,
): Promise<{ outcome: "refunded" } | { outcome: "failed" | "pending"; error: string }> {
  const decision = await refundReadyToSettle(paymentIntentId, orderId, storeId, refund);
  if (decision.status === "succeeded") {
    await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current || current.status !== "CANCELLING") return;
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          capturedAmountCents: null,
          refundId: decision.refundId,
        },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "anomaly_refund",
          entityType: "order",
          entityId: orderId,
          after: { refundId: decision.refundId, amountRefunded: decision.amountRefunded },
        },
      });
    });
    return { outcome: "refunded" };
  }

  if (isTerminalRefundStatus(decision.status)) {
    await persistRefundFailure(storeId, orderId, decision.refundId, decision.status);
    return { outcome: "failed", error: `Refund ${decision.status} — customer is still charged` };
  }

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await tx.order.update({ where: { id: orderId }, data: { refundId: decision.refundId } });
  });
  return { outcome: "pending", error: `Refund ${decision.status} — order stays in CANCELLING for retry` };
}

/** One succeeded slice is not coverage while another refund is still pending. */
async function refundReadyToSettle(
  paymentIntentId: string,
  orderId: string,
  storeId: string,
  refund: RefundResult,
): Promise<RefundResult> {
  if (refund.status !== "succeeded") return refund;
  const stripe = getStripeProvider();
  const open = (items: RefundResult[]) =>
    items.find((item) => item.status === "pending" || item.status === "requires_action");
  const succeededTotal = (items: RefundResult[]) =>
    items.filter((item) => item.status === "succeeded").reduce((sum, item) => sum + item.amountRefunded, 0);

  const listed = await stripe.listRefunds(paymentIntentId);
  const pending = open(listed);
  if (pending) return pending;
  const captured = await stripe.retrievePaymentIntent(paymentIntentId);
  if (succeededTotal(listed) >= captured.amountReceived) return refund;

  const gap = await refundCapturedBalance(paymentIntentId, orderId, storeId);
  if (gap.status !== "succeeded") return gap;
  const again = await stripe.listRefunds(paymentIntentId);
  const stillPending = open(again);
  if (stillPending) return stillPending;
  const after = await stripe.retrievePaymentIntent(paymentIntentId);
  if (succeededTotal(again) >= after.amountReceived) return gap;
  return { ...gap, status: "pending" };
}

function refundStillCovers(refunds: RefundResult[], capturedCents: number): boolean {
  if (capturedCents <= 0) return false;
  const covering = refunds
    .filter((refund) => refund.status === "succeeded" || refund.status === "pending" || refund.status === "requires_action")
    .reduce((sum, refund) => sum + refund.amountRefunded, 0);
  return covering >= capturedCents;
}

export async function markTerminalRefundFailure(input: {
  paymentIntentId: string;
  refundId: string;
  refundStatus: string;
}): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  if (!isTerminalRefundStatus(input.refundStatus)) return { ok: true, action: "ignored" };
  const order = await findOrderByPaymentIntent(input.paymentIntentId);
  if (!order) {
    console.warn(`refund.failed for unknown PaymentIntent ${input.paymentIntentId}`);
    return { ok: false, error: "Order not found" };
  }
  if (order.status === "REFUND_FAILED") return { ok: true, action: "already_recorded" };
  if (order.status !== "CANCELLING" && order.status !== "CANCELLED") {
    console.warn(`refund.failed ignored for order ${order.id} in status ${order.status}`);
    return { ok: true, action: "ignored" };
  }

  const current = await storeScoped(order.storeId).order.findUnique({ where: { id: order.id } });
  if (!current) return { ok: false, error: "Order not found" };
  if (current.status === "CANCELLED" && (current.capturedAmountCents ?? 0) === 0) {
    return { ok: true, action: "ignored" };
  }

  let listed: RefundResult[] = [];
  let amountReceived = 0;
  try {
    const stripe = getStripeProvider();
    const [refunds, pi] = await Promise.all([
      stripe.listRefunds(input.paymentIntentId),
      stripe.retrievePaymentIntent(input.paymentIntentId),
    ]);
    listed = refunds;
    amountReceived = pi.amountReceived;
  } catch (err) {
    console.warn(`refund.failed could not read Stripe for ${input.paymentIntentId}`, err);
  }
  const captured = amountReceived > 0 ? amountReceived : (current.capturedAmountCents ?? 0);
  const covered = refundStillCovers(listed, captured);
  const action = covered ? "refund_failed_while_covered" : "refund_failed";

  let wrote = false;
  await storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const row = await tx.order.findUnique({ where: { id: order.id } });
    if (!row || (row.status !== "CANCELLING" && row.status !== "CANCELLED")) return;
    const prior = await tx.auditLog.findMany({ where: { entityId: order.id, action } });
    const duplicate = prior.some((log) => {
      const after = log.after as { refundId?: string } | null;
      return after?.refundId === input.refundId;
    });
    if (duplicate) return;
    if (!covered) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "REFUND_FAILED", refundId: input.refundId },
      });
    }
    await tx.auditLog.create({
      data: {
        storeId: order.storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action,
        entityType: "order",
        entityId: order.id,
        after: {
          refundId: input.refundId,
          refundStatus: input.refundStatus,
          alert: covered ? "store" : "store_and_platform",
        },
      },
    });
    wrote = true;
  });

  if (!covered && wrote) {
    console.error(
      `Refund ${input.refundStatus} for order ${order.id} (${input.refundId}). Customer is still charged. Store and platform alerted.`,
    );
  }
  return { ok: true, action: covered ? "covered" : "refund_failed" };
}

export async function markReady(
  storeId: string,
  orderId: string,
): Promise<{ ok: true; capturedAmountCents: number; voided?: boolean } | { ok: false; error: string }> {
  // Phase 1: claim with CAPTURING inside transaction (blocks concurrent changes)
  const validation = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found" };
    if (order.status === "CAPTURING") {
      const amount = order.capturedAmountCents ?? 0;
      const fee = applicationFeeForCapture(amount, order.deliveryFeeCents);
      return {
        ok: true as const,
        capturedAmountCents: amount,
        applicationFeeAmount: fee > 0 ? fee : undefined,
        paymentIntentId: order.paymentIntentId!,
        totalAuthorizedCents: order.totalAuthorizedCents,
        newStatus: (order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY") as OrderStatus,
        alreadyClaiming: true,
      };
    }
    if (order.status !== "PICKING") {
      return { ok: false as const, error: `Cannot mark ready for order in status ${order.status}` };
    }

    const lines = await tx.orderLine.findMany({ where: { orderId } });

    const unresolvedLines = lines.filter(
      (l: { status: string }) => !RESOLVED_LINE_STATUSES.includes(l.status as OrderLineStatus),
    );
    if (unresolvedLines.length > 0) {
      return { ok: false as const, error: "Cannot mark ready: unresolved order lines remain" };
    }

    const lineTotalCents = lines.reduce((sum: number, l: { status: string; qtyPicked: number; unitPriceCents: number }) => {
      if (l.status === "refunded") return sum;
      return sum + l.qtyPicked * l.unitPriceCents;
    }, 0);

    const capturedAmountCents = lineTotalCents + order.tipCents + order.deliveryFeeCents;

    if (!order.paymentIntentId) {
      return { ok: false as const, error: "Order has no payment intent" };
    }

    // Stripe USD minimum capture is 50 cents ($0.50).
    // https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
    if (capturedAmountCents < STRIPE_USD_MINIMUM_CENTS) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLING" },
      });
      return {
        ok: true as const,
        capturedAmountCents,
        paymentIntentId: order.paymentIntentId,
        newStatus: "CANCELLED" as OrderStatus,
        alreadyClaiming: false,
        voidInsteadOfCapture: true,
        orderId: order.id,
        storeId,
        totalAuthorizedCents: order.totalAuthorizedCents,
      };
    }

    if (capturedAmountCents > order.totalAuthorizedCents) {
      return {
        ok: false as const,
        error: `Capture amount ${capturedAmountCents} exceeds authorized amount ${order.totalAuthorizedCents}`,
      };
    }

    const newStatus: OrderStatus =
      order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";

    const fee = applicationFeeForCapture(capturedAmountCents, order.deliveryFeeCents);

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "CAPTURING",
        capturedAmountCents,
        platformFeeCents: platformFeeCentsForCapture(capturedAmountCents),
      },
    });

    return {
      ok: true as const,
      capturedAmountCents,
      applicationFeeAmount: fee > 0 ? fee : undefined,
      paymentIntentId: order.paymentIntentId,
      totalAuthorizedCents: order.totalAuthorizedCents,
      newStatus,
      alreadyClaiming: false,
      voidInsteadOfCapture: false,
      orderId: order.id,
      storeId,
    };
  });

  if (!validation.ok) return validation;

  // K3: below-minimum amount — void the authorization instead of capturing
  if (validation.voidInsteadOfCapture) {
    const stripe = getStripeProvider();
    try {
      const reservedCancel = await reserveAttempt(storeId, orderId, "cancel_retry");
      if (!reservedCancel.ok) return { ok: false, error: "Cancellation is still confirming with the bank" };
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        cancelKey(orderId, reservedCancel.attempt),
      );
    } catch (err) {
      if (isRetryableProviderError(err)) {
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        const refund = await refundCapturedBalance(validation.paymentIntentId, orderId, storeId);
        const settled = await settleCapturedRefund(storeId, orderId, validation.paymentIntentId, refund);
        if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
        return { ok: true, capturedAmountCents: 0, voided: true };
      }
      throw err;
    }
    await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current || current.status !== "CANCELLING") {
        return;
      }
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          capturedAmountCents: 0,
        },
      });

      // Stock restore deferred to #141 (order-triggered reservation as a matched pair)

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "void_zero_amount",
          entityType: "order",
          entityId: orderId,
        },
      });
    });
    return { ok: true, capturedAmountCents: 0, voided: true };
  }

  // Phase 2: reserve the attempt, then call Stripe outside the lock.
  // A stored 5xx is pinned to its key, so the next attempt is a new row.
  const stripe = getStripeProvider();
  const reservedCapture = await reserveAttempt(storeId, orderId, "capture_retry", {
    alert: "store_and_platform",
  });
  if (!reservedCapture.ok) {
    const minutes = Math.max(1, Math.ceil(reservedCapture.waitMs / 60_000));
    return { ok: false, error: `Retrying in ${minutes} min` };
  }
  const captureAttempt = reservedCapture.attempt;
  let captureResult;
  try {
    await registerE2EPayment(validation.paymentIntentId, validation.totalAuthorizedCents);
    captureResult = await stripe.capturePaymentIntent(
      validation.paymentIntentId,
      validation.capturedAmountCents,
      captureKey(orderId, captureAttempt),
      validation.applicationFeeAmount,
    );
  } catch (err) {
    if (isIdempotencyKeyInUse(err)) {
      return { ok: false, error: "Card capture is still confirming with the bank" };
    }
    if (isRetryableProviderError(err)) {
      const settled = await noteCaptureServerError(storeId, orderId, captureAttempt);
      if (settled.ok) return { ok: true, capturedAmountCents: settled.capturedAmountCents };
      return { ok: false, error: settled.error };
    }
    if (err instanceof ProviderStateError) {
      await storeScopedTransaction(storeId, async (tx) => {
        await lockStoreRow(tx, storeId);
        const current = await tx.order.findUnique({ where: { id: orderId } });
        if (!current || current.status !== "CAPTURING") return;
        await tx.order.update({
          where: { id: orderId },
          data: { status: "CANCELLED", cancelledAt: new Date(), capturedAmountCents: null },
        });
        await tx.auditLog.create({
          data: {
            storeId,
            actorId: SYSTEM_ACTOR_ID,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: "capture_on_canceled_pi",
            entityType: "order",
            entityId: orderId,
            after: { actualStatus: err.actualStatus },
          },
        });
      });
      return { ok: false, error: "Payment authorization expired or was voided — order cancelled; contact the customer" };
    }
    throw err;
  }

  // Phase 3: finalize in transaction (verify still CAPTURING)
  // Persist Stripe's amount_received, not the requested amount (M2)
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CAPTURING") {
      return { ok: false as const, error: "Order status changed during capture" };
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: validation.newStatus,
        readyAt: new Date(),
        capturedAmountCents: captureResult.amountCaptured,
      },
    });
    return { ok: true as const };
  });

  if (!finalize.ok) return finalize;

  return { ok: true, capturedAmountCents: captureResult.amountCaptured };
}

export async function completePickup(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AWAITING_PICKUP") {
      if (order.fulfillment === "delivery") {
        return { ok: false, error: "Cannot complete pickup for delivery order — use courier dispatch" };
      }
      return { ok: false, error: "Order is not awaiting pickup" };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    return { ok: true };
  });
}

export async function autoCancelOrder(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Phase 1: claim with CANCELLING inside transaction (blocks acceptOrder)
  const validation = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found" };
    if (order.status === "CANCELLING") {
      return {
        ok: true as const,
        paymentIntentId: order.paymentIntentId,
        alreadyClaiming: true,
        refundId: order.refundId,
      };
    }
    if (order.status !== "AUTHORIZED") {
      return { ok: false as const, error: `Order is in status ${order.status}, not AUTHORIZED` };
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLING" } });
    return {
      ok: true as const,
      paymentIntentId: order.paymentIntentId,
      alreadyClaiming: false,
      refundId: null,
    };
  });

  if (!validation.ok) return validation;

  // Phase 2: Stripe cancel outside transaction (idempotency key makes retry safe)
  if (validation.paymentIntentId) {
    const stripe = getStripeProvider();
    const reservedCancel = await reserveAttempt(storeId, orderId, "cancel_retry");
    if (!reservedCancel.ok) return { ok: false, error: "Cancellation is still confirming with the bank" };
    try {
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        cancelKey(orderId, reservedCancel.attempt),
      );
    } catch (err) {
      if (isRetryableProviderError(err)) {
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        const refund = validation.refundId
          ? await stripe.retrieveRefund(validation.refundId)
          : await refundCapturedBalance(validation.paymentIntentId, orderId, storeId);
        const settled = await settleCapturedRefund(storeId, orderId, validation.paymentIntentId, refund);
        if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
        return { ok: true };
      }
      throw err;
    }
  }

  // Phase 3: finalize in transaction (verify still CANCELLING)
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CANCELLING") {
      return { ok: false as const, error: "Order status changed during cancellation" };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        capturedAmountCents: null,
      },
    });

    // Stock restore deferred to #141 (order-triggered reservation as a matched pair)

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "auto_cancel",
        entityType: "order",
        entityId: orderId,
      },
    });

    return { ok: true as const };
  });

  if (!finalize.ok) return finalize;

  return { ok: true };
}

export async function reconcileStuckOrder(
  storeId: string,
  orderId: string,
): Promise<{ ok: true; action: string } | { ok: false; error: string; waiting?: boolean }> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({
      where: { id: orderId },
      include: { lines: true },
    });
  });

  if (!order || (order.status !== "CAPTURING" && order.status !== "CANCELLING")) {
    return { ok: true, action: "already_resolved" };
  }

  if (!order.paymentIntentId) {
    return { ok: false, error: "Order has no payment intent" };
  }

  const stripe = getStripeProvider();
  const pi = await stripe.retrievePaymentIntent(order.paymentIntentId);

  if (pi.status === "succeeded") {
    if (order.status === "CANCELLING") {
      let refund;
      if (order.refundId) {
        refund = await stripe.retrieveRefund(order.refundId);
      } else {
        refund = await refundCapturedBalance(order.paymentIntentId, orderId, storeId);
      }
      const settled = await settleCapturedRefund(storeId, orderId, order.paymentIntentId, refund);
      if (settled.outcome !== "refunded") {
        return { ok: false, error: settled.error, waiting: settled.outcome === "pending" };
      }
      return { ok: true, action: "anomaly_refund" };
    }
    return finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, pi.amountReceived);
  }

  if (pi.status === "canceled") {
    return finalizeCancelFromSweep(storeId, orderId);
  }

  if (pi.status === "requires_capture") {
    if (order.status === "CAPTURING") {
      const reservedCapture = await reserveAttempt(storeId, orderId, "capture_retry", {
        alert: "store_and_platform",
      });
      if (!reservedCapture.ok) {
        return { ok: false, error: "capture_backoff", waiting: true };
      }
      const attempt = reservedCapture.attempt;
      const amount = order.capturedAmountCents ?? 0;
      const sweepFee = applicationFeeForCapture(amount, order.deliveryFeeCents);
      try {
        await registerE2EPayment(order.paymentIntentId, order.totalAuthorizedCents);
        const retryCap = await stripe.capturePaymentIntent(
          order.paymentIntentId,
          amount,
          captureKey(orderId, attempt),
          sweepFee > 0 ? sweepFee : undefined,
        );
        return finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, retryCap.amountCaptured);
      } catch (err) {
        if (isIdempotencyKeyInUse(err)) {
          return { ok: false, error: "Card capture is still confirming with the bank", waiting: true };
        }
        if (isRetryableProviderError(err)) {
          const settled = await noteCaptureServerError(storeId, orderId, attempt);
          if (settled.ok) return { ok: true, action: "finalized_capture" };
          if (settled.resolved === "cancelled") return { ok: true, action: "finalized_cancel" };
          return { ok: false, error: settled.error, waiting: true };
        }
        if (err instanceof ProviderStateError) {
          return finalizeCancelFromSweep(storeId, orderId);
        }
        throw err;
      }
    } else {
      try {
        const reservedCancel = await reserveAttempt(storeId, orderId, "cancel_retry");
        if (!reservedCancel.ok) {
          return { ok: false, error: "Cancellation is still confirming with the bank", waiting: true };
        }
        try {
          await stripe.cancelPaymentIntent(order.paymentIntentId, cancelKey(orderId, reservedCancel.attempt));
        } catch (err) {
          if (isRetryableProviderError(err)) {
            return { ok: false, error: "Cancellation is still confirming with the bank", waiting: true };
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof ProviderStateError) {
          const freshPi = await stripe.retrievePaymentIntent(order.paymentIntentId);
          if (freshPi.status === "succeeded") {
            let refund;
            if (order.refundId) {
              refund = await stripe.retrieveRefund(order.refundId);
            } else {
              refund = await refundCapturedBalance(order.paymentIntentId, orderId, storeId);
            }
            const settled = await settleCapturedRefund(storeId, orderId, order.paymentIntentId, refund);
            if (settled.outcome !== "refunded") {
        return { ok: false, error: settled.error, waiting: settled.outcome === "pending" };
      }
            return { ok: true, action: "anomaly_refund" };
          }
        }
        throw err;
      }
      return finalizeCancelFromSweep(storeId, orderId);
    }
  }

  return { ok: true, action: "unknown_stripe_status" };
}

async function finalizeCaptureFromSweep(
  storeId: string,
  orderId: string,
  fulfillment: string,
  capturedAmountCents: number,
): Promise<{ ok: true; action: string }> {
  const newStatus: OrderStatus =
    fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status !== "CAPTURING") return;

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        readyAt: new Date(),
        capturedAmountCents,
      },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "reconcile_capture",
        entityType: "order",
        entityId: orderId,
      },
    });
  });

  return { ok: true, action: "finalized_capture" };
}

async function finalizeCancelFromSweep(
  storeId: string,
  orderId: string,
  action: "reconcile_cancel" | "capture_released" = "reconcile_cancel",
): Promise<{ ok: true; action: string }> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CAPTURING" && current.status !== "CANCELLING")) return;

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action,
        entityType: "order",
        entityId: orderId,
        after: action === "capture_released" ? { alert: "store_and_platform" } : {},
      },
    });

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date(), capturedAmountCents: null },
    });
  });

  return { ok: true, action: "finalized_cancel" };
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
