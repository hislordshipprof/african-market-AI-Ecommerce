import { storeScopedTransaction, lockStoreRow, findOrderByPaymentIntent } from "../db";
import { getStripeProvider } from "../stripe";
import { isRetryableProviderError } from "../stripe/errors";
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
  | "REFUND_FAILED"
  | "CAPTURE_FAILED";

// Stripe USD minimum capture: $0.50 (50 cents).
// https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const STRIPE_USD_MINIMUM_CENTS = 50;
const MAX_CAPTURE_ATTEMPTS = 5;
const REFUND_APPLICATION_FEE = { refundApplicationFee: true } as const;

function captureKey(orderId: string, attempt: number): string {
  return `capture:${orderId}:${attempt}`;
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
  "CAPTURE_FAILED",
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

async function captureAttemptNumber(storeId: string, orderId: string): Promise<number> {
  const prior = await storeScopedTransaction(storeId, async (tx) => {
    return tx.auditLog.count({
      where: { entityId: orderId, action: "capture_retry" },
    });
  });
  return prior + 1;
}

async function captureRetryWaitMs(storeId: string, orderId: string): Promise<number> {
  const latest = await storeScopedTransaction(storeId, async (tx) => {
    return tx.auditLog.findFirst({
      where: { entityId: orderId, action: "capture_retry" },
      orderBy: { createdAt: "desc" },
    });
  });
  if (!latest) return 0;
  const after = latest.after as { attempt?: number } | null;
  const attempt = typeof after?.attempt === "number" ? after.attempt : 1;
  const remaining = captureBackoffMs(attempt) - (Date.now() - latest.createdAt.getTime());
  return remaining > 0 ? remaining : 0;
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

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "capture_retry",
        entityType: "order",
        entityId: orderId,
        after: { attempt, alert: "store_and_platform" },
      },
    });
  });
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
    try {
      await stripe.cancelPaymentIntent(order.paymentIntentId, `cancel:${orderId}:release-hold`);
    } catch (err) {
      if (err instanceof ProviderStateError) {
        const fresh = await stripe.retrievePaymentIntent(order.paymentIntentId);
        if (fresh.status === "succeeded") {
          await finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, fresh.amountReceived);
          return { ok: true, capturedAmountCents: fresh.amountReceived };
        }
      } else if (isRetryableProviderError(err)) {
        return { ok: false, error: "Card capture is still confirming with the bank", resolved: "pending" };
      } else {
        throw err;
      }
    }
  }

  if (pi.status === "canceled" || pi.status === "requires_capture") {
    await finalizeCancelFromSweep(storeId, orderId);
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
  refund: RefundResult,
): Promise<{ outcome: "refunded" } | { outcome: "failed" | "pending"; error: string }> {
  if (refund.status === "succeeded") {
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
          refundId: refund.refundId,
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
          after: { refundId: refund.refundId, amountRefunded: refund.amountRefunded },
        },
      });
    });
    return { outcome: "refunded" };
  }

  if (isTerminalRefundStatus(refund.status)) {
    await persistRefundFailure(storeId, orderId, refund.refundId, refund.status);
    return { outcome: "failed", error: `Refund ${refund.status} — customer is still charged` };
  }

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await tx.order.update({ where: { id: orderId }, data: { refundId: refund.refundId } });
  });
  return { outcome: "pending", error: `Refund ${refund.status} — order stays in CANCELLING for retry` };
}

export async function markTerminalRefundFailure(input: {
  paymentIntentId: string;
  refundId: string;
  refundStatus: string;
}): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  if (!isTerminalRefundStatus(input.refundStatus)) return { ok: true, action: "ignored" };
  const order = await findOrderByPaymentIntent(input.paymentIntentId);
  if (!order) return { ok: false, error: "Order not found" };
  if (order.status === "REFUND_FAILED") return { ok: true, action: "already_recorded" };
  if (order.status !== "CANCELLING" && order.status !== "CANCELLED") {
    return { ok: true, action: "ignored" };
  }
  await persistRefundFailure(order.storeId, order.id, input.refundId, input.refundStatus);
  return { ok: true, action: "refund_failed" };
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
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        `cancel:${orderId}`,
      );
    } catch (err) {
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        const pi = await stripe.retrievePaymentIntent(validation.paymentIntentId);
        const refund = await stripe.refundPayment(
          validation.paymentIntentId,
          pi.amountReceived,
          `refund:${orderId}`,
          REFUND_APPLICATION_FEE,
        );
        const settled = await settleCapturedRefund(storeId, orderId, refund);
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

  // A staff retry during the backoff would burn the remaining attempts in one tap.
  if (validation.alreadyClaiming) {
    const remaining = await captureRetryWaitMs(storeId, orderId);
    if (remaining > 0) {
      const minutes = Math.max(1, Math.ceil(remaining / 60_000));
      return { ok: false, error: `Retrying in ${minutes} min` };
    }
  }

  // Phase 2: Stripe capture outside the transaction. A 5xx uses a new attempt key
  // because Stripe replays a stored 5xx for the same idempotency key for about 24 hours.
  const stripe = getStripeProvider();
  let captureResult;
  let captureAttempt = 1;
  try {
    captureAttempt = await captureAttemptNumber(storeId, orderId);
    await registerE2EPayment(validation.paymentIntentId, validation.totalAuthorizedCents);
    captureResult = await stripe.capturePaymentIntent(
      validation.paymentIntentId,
      validation.capturedAmountCents,
      captureKey(orderId, captureAttempt),
      validation.applicationFeeAmount,
    );
  } catch (err) {
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
    if (order.status !== "AWAITING_PICKUP" && order.status !== "READY") {
      return { ok: false, error: `Cannot complete pickup for order in status ${order.status}` };
    }
    if (order.status === "READY" && order.fulfillment !== "pickup") {
      return { ok: false, error: `Cannot complete pickup for delivery order — use courier dispatch` };
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
      return { ok: true as const, paymentIntentId: order.paymentIntentId, alreadyClaiming: true };
    }
    if (order.status !== "AUTHORIZED") {
      return { ok: false as const, error: `Order is in status ${order.status}, not AUTHORIZED` };
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLING" } });
    return { ok: true as const, paymentIntentId: order.paymentIntentId, alreadyClaiming: false };
  });

  if (!validation.ok) return validation;

  // Phase 2: Stripe cancel outside transaction (idempotency key makes retry safe)
  if (validation.paymentIntentId) {
    const stripe = getStripeProvider();
    try {
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        `cancel:${orderId}`,
      );
    } catch (err) {
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        const pi = await stripe.retrievePaymentIntent(validation.paymentIntentId);
        const refund = await stripe.refundPayment(
          validation.paymentIntentId,
          pi.amountReceived,
          `refund:${orderId}`,
          REFUND_APPLICATION_FEE,
        );
        const settled = await settleCapturedRefund(storeId, orderId, refund);
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
): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
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
        refund = await stripe.refundPayment(
          order.paymentIntentId,
          pi.amountReceived,
          `refund:${orderId}`,
          REFUND_APPLICATION_FEE,
        );
      }
      const settled = await settleCapturedRefund(storeId, orderId, refund);
      if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
      return { ok: true, action: "anomaly_refund" };
    }
    return finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, pi.amountReceived);
  }

  if (pi.status === "canceled") {
    return finalizeCancelFromSweep(storeId, orderId);
  }

  if (pi.status === "requires_capture") {
    if (order.status === "CAPTURING") {
      if ((await captureRetryWaitMs(storeId, orderId)) > 0) {
        return { ok: false, error: "capture_backoff" };
      }
      const attempt = await captureAttemptNumber(storeId, orderId);
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
        if (isRetryableProviderError(err)) {
          const settled = await noteCaptureServerError(storeId, orderId, attempt);
          if (settled.ok) return { ok: true, action: "finalized_capture" };
          if (settled.resolved === "cancelled") return { ok: true, action: "finalized_cancel" };
          return { ok: false, error: settled.error };
        }
        if (err instanceof ProviderStateError) {
          return finalizeCancelFromSweep(storeId, orderId);
        }
        throw err;
      }
    } else {
      try {
        await stripe.cancelPaymentIntent(order.paymentIntentId, `cancel:${orderId}`);
      } catch (err) {
        if (err instanceof ProviderStateError) {
          const freshPi = await stripe.retrievePaymentIntent(order.paymentIntentId);
          if (freshPi.status === "succeeded") {
            let refund;
            if (order.refundId) {
              refund = await stripe.retrieveRefund(order.refundId);
            } else {
              refund = await stripe.refundPayment(
                order.paymentIntentId,
                freshPi.amountReceived,
                `refund:${orderId}`,
                REFUND_APPLICATION_FEE,
              );
            }
            const settled = await settleCapturedRefund(storeId, orderId, refund);
            if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
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
): Promise<{ ok: true; action: string }> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CAPTURING" && current.status !== "CANCELLING")) return;

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date(), capturedAmountCents: null },
    });

    // Stock restore deferred to #141 (order-triggered reservation as a matched pair)

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "reconcile_cancel",
        entityType: "order",
        entityId: orderId,
      },
    });
  });

  return { ok: true, action: "finalized_cancel" };
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
