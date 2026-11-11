import { Prisma } from "@prisma/client";
import { storeScoped, storeScopedTransaction, lockStoreRow, findOrderByPaymentIntent } from "../db";
import { getStripeProvider, stripeProviderKind } from "../stripe";
import { isIdempotencyKeyInUse, isRetryableProviderError } from "../stripe/errors";
import { applyProviderRefund, coveredRefundCents, evaluateOrderRefundState, findOpenRefundRequest, openRefundRequest, reconcileAbandonedRefundRequests, reconcileOpenRefundRequests, submitRefund } from "./refund-requests";
import { ProviderStateError, type RefundResult } from "../stripe/types";
import { systemAuditData } from "../system-actor";
import { RESOLVED_LINE_STATUSES, type OrderLineStatus, type StoreCancelReason } from "./constants";
import { applicationFeeForCapture, platformFeeCentsForCapture } from "./platform-fee";
import { releaseOrderStock, settleCapturedStock, settleShortLine } from "./stock-ledger";
import { recordOrderNotification } from "../notifications/record";
import { scheduleOrderNotification } from "../inngest/notify";
import { deleteDeliveryProof, deliveryProofBucket, deliveryProofKey, uploadDeliveryProof } from "../r2";
import { prepareProofPhoto, PROOF_STORAGE_NOT_SET_UP, STORE_DELIVERY_ONLY } from "./delivery-proof";
export type { OrderLineStatus } from "./constants";

export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "CANCELLING"
  | "CAPTURING"
  | "READY"
  | "AWAITING_PICKUP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUND_FAILED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

// Stripe USD minimum capture: $0.50 (50 cents).
// https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const STRIPE_USD_MINIMUM_CENTS = 50;
const MAX_CAPTURE_ATTEMPTS = 5;

type TransitionalStatus = "CAPTURING" | "CANCELLING";

const CAPTURE_STATUS_CHANGED = "Order status changed during capture";

/** Stock writes wait on listing locks, so these transactions cannot use Prisma's 5-second default. */
const LEDGER_TRANSACTION = { timeout: 20_000, maxWait: 8_000 };

/** A capture result may report this amount only when the order row already stored it. */
function storedCaptureAmount(
  capturedAmountCents: number | null,
): { ok: true; capturedAmountCents: number } | { ok: false; error: typeof CAPTURE_STATUS_CHANGED } {
  if (capturedAmountCents == null) return { ok: false, error: CAPTURE_STATUS_CHANGED };
  return { ok: true, capturedAmountCents };
}

export function fulfilledStatus(fulfillment: string): "AWAITING_PICKUP" | "READY" {
  return fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";
}

function orderAuditWhere(entityId: string, action: string) {
  return { entityId, action, entityType: "order" as const };
}

/**
 * Label for a CANCELLING order with no cause row: markReady's below-minimum void
 * (acceptedAt is set) or a claim made before cause rows existed (acceptedAt is null).
 */
function cancellationAuditAction(acceptedAt: Date | null): "void_zero_amount" | "auto_cancel" {
  return acceptedAt == null ? "auto_cancel" : "void_zero_amount";
}

export type CancelCause =
  | { action: "auto_cancel" }
  | { action: "pick_timeout" }
  | { action: "provider_canceled"; stripeEventId: string | null; cancellationReason: string | null }
  | {
      action: "store_cancel";
      actor: { id: string; email: string };
      reason: StoreCancelReason;
      note: string | null;
    };

const CANCEL_CAUSE_ACTIONS: CancelCause["action"][] = ["store_cancel", "provider_canceled", "auto_cancel", "pick_timeout"];

const CANCELLABLE_FROM: Record<CancelCause["action"], OrderStatus[]> = {
  auto_cancel: ["AUTHORIZED"],
  pick_timeout: ["ACCEPTED", "PICKING"],
  store_cancel: ["AUTHORIZED", "ACCEPTED", "PICKING"],
  provider_canceled: ["AUTHORIZED", "ACCEPTED", "PICKING"],
};

/** Stripe ended the hold itself: `expired` on API 2025-03-31.basil and later, `automatic` before. */
export function stripeEndedHold(cancellationReason: string | null): boolean {
  return cancellationReason === "expired" || cancellationReason === "automatic";
}

function causeAuditData(storeId: string, orderId: string, cause: CancelCause) {
  if (cause.action === "store_cancel") {
    return {
      storeId,
      actorId: cause.actor.id,
      actorEmail: cause.actor.email,
      action: cause.action,
      entityType: "order" as const,
      entityId: orderId,
      after: { reason: cause.reason, note: cause.note },
    };
  }
  if (cause.action === "provider_canceled") {
    return systemAuditData(storeId, orderId, cause.action, {
      stripeEventId: cause.stripeEventId,
      cancellationReason: cause.cancellationReason,
      holdEnded: stripeEndedHold(cause.cancellationReason),
    });
  }
  return systemAuditData(storeId, orderId, cause.action, {});
}

async function finalizeCancelledOrder(
  storeId: string,
  orderId: string,
  action: string,
  options?: {
    from?: TransitionalStatus[];
    refundId?: string | null;
    after?: Prisma.InputJsonValue;
  },
): Promise<{ wrote: boolean }> {
  const from = options?.from ?? ["CAPTURING", "CANCELLING"];
  const outcome = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status === "CANCELLED" || !from.includes(current.status as TransitionalStatus)) {
      return { wrote: false, notify: false };
    }
    if (await openRefundRequest(tx, orderId)) return { wrote: false, notify: false };
    const existing = await tx.auditLog.findFirst({ where: orderAuditWhere(orderId, action) });
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "CANCELLED",
        cancelledAt: current.cancelledAt ?? new Date(),
        capturedAmountCents: null,
        ...(options?.refundId ? { refundId: options.refundId } : {}),
      },
    });
    if (!existing) {
      await tx.auditLog.create({
        data: systemAuditData(storeId, orderId, action, options?.after ?? {}),
      });
    }
    await releaseOrderStock(tx, storeId, orderId);
    const notify = await recordOrderNotification(tx, storeId, orderId, "cancelled");
    return { wrote: true, notify };
  }, LEDGER_TRANSACTION);
  if (outcome.notify) scheduleOrderNotification(storeId, orderId, "cancelled");
  return { wrote: outcome.wrote };
}

/** Refund whatever of a captured charge is still unrefunded. The request ledger owns the attempt. */
async function refundCapturedBalance(
  paymentIntentId: string,
  orderId: string,
  storeId: string,
): Promise<RefundResult | { inFlight: true } | { blocked: true }> {
  return submitRefund(storeId, orderId, paymentIntentId);
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
  action: "capture_retry" | "cancel_retry",
  extra: Record<string, unknown> = {},
): Promise<{ ok: true; attempt: number } | { ok: false; waitMs: number; exhausted?: boolean }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const prior = await tx.auditLog.findMany({
      where: orderAuditWhere(orderId, action),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const newestAfter = prior[0]?.after as { attempt?: number; inFlight?: boolean } | null;
    if (newestAfter?.inFlight === true && typeof newestAfter.attempt === "number") {
      if (action === "capture_retry") {
        const waitMs = captureBackoffMs(newestAfter.attempt) - (Date.now() - prior[0].createdAt.getTime());
        if (waitMs > 0) return { ok: false, waitMs };
      }
      return { ok: true, attempt: newestAfter.attempt };
    }
    const reservations = prior.filter((row) => {
      const after = row.after as { inFlight?: boolean } | null;
      return typeof after?.inFlight !== "boolean";
    });
    if (action === "capture_retry" && reservations.length >= MAX_CAPTURE_ATTEMPTS) {
      return { ok: false, waitMs: 0, exhausted: true };
    }
    if (action === "capture_retry" && reservations.length > 0) {
      const latest = reservations[0];
      const after = latest.after as { attempt?: number } | null;
      const previous = typeof after?.attempt === "number" ? after.attempt : reservations.length;
      const waitMs = captureBackoffMs(previous) - (Date.now() - latest.createdAt.getTime());
      if (waitMs > 0) return { ok: false, waitMs };
    }
    const attempt = reservations.length + 1;
    await tx.auditLog.create({
      data: systemAuditData(storeId, orderId, action, { attempt, ...extra } as Prisma.InputJsonValue),
    });
    if (action === "cancel_retry") {
      await tx.auditLog.create({
        data: systemAuditData(storeId, orderId, action, { attempt, inFlight: true }),
      });
    }
    return { ok: true, attempt };
  });
}

/** The same key stays in use until Stripe finishes the request that owns it. */
async function noteAttemptInFlight(
  storeId: string,
  orderId: string,
  action: "capture_retry" | "cancel_retry",
  attempt: number,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await tx.auditLog.create({
      data: systemAuditData(storeId, orderId, action, { attempt, inFlight: true }),
    });
  });
}

function refundInFlight(value: RefundResult | { inFlight: true } | { blocked: true }): value is { inFlight: true } {
  return "inFlight" in value;
}

function refundBlocked(value: RefundResult | { inFlight: true } | { blocked: true }): value is { blocked: true } {
  return "blocked" in value;
}

/** A stored 500 is pinned to its key. The next attempt has to be a new number. */
async function noteAttemptReleased(
  storeId: string,
  orderId: string,
  action: "capture_retry" | "cancel_retry",
  attempt: number,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const prior = await tx.auditLog.findMany({
      where: orderAuditWhere(orderId, action),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
    });
    const after = prior[0]?.after as { attempt?: number; inFlight?: boolean } | null;
    if (after?.inFlight === true && after.attempt === attempt) {
      await tx.auditLog.create({
        data: systemAuditData(storeId, orderId, action, { attempt, inFlight: false }),
      });
    }
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
  "OUT_FOR_DELIVERY",
  "REFUND_FAILED",
];

const ORDER_WITH_LINES = {
  customer: { select: { name: true, phone: true, userId: true, claimedByCustomerId: true } },
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
  const orders = await storeScopedTransaction(storeId, async (tx) => {
    const resolved = await tx.auditLog.findMany({
      where: { action: "refund_resolved_manually", entityType: "order" },
      select: { entityId: true },
    });
    const resolvedIds = resolved.map((row) => row.entityId);
    return tx.order.findMany({
      where: {
        OR: [
          { status: { in: ACTIVE_STATUSES } },
          ...(resolvedIds.length > 0
            ? [{ id: { in: resolvedIds }, status: "CANCELLED" as const }]
            : []),
        ],
      },
      include: ORDER_WITH_LINES,
      orderBy: { createdAt: "desc" },
    });
  });
  // This payload reaches a client component. A user id is the same at every store, so it
  // would let two stores' admins match one person: send only whether an account is linked.
  return orders.map(({ customer: { userId, claimedByCustomerId, ...customer }, ...order }) => ({
    ...order,
    customer,
    hasAccount: userId !== null || claimedByCustomerId !== null,
  }));
}

export type StoreOrderRow = Awaited<ReturnType<typeof getStoreOrders>>[number];

export async function acceptOrder(
  storeId: string,
  orderId: string,
  prepEstimateMinutes: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clamped = Math.max(1, Math.min(120, Math.round(prepEstimateMinutes)));
  const result = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found", notify: false };
    if (order.status !== "AUTHORIZED") {
      return { ok: false as const, error: `Cannot accept order in status ${order.status}`, notify: false };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "ACCEPTED",
        prepEstimateMinutes: clamped,
        acceptedAt: new Date(),
      },
    });

    const notify = await recordOrderNotification(tx, storeId, orderId, "accepted");
    return { ok: true as const, notify };
  });
  if (result.ok && result.notify) scheduleOrderNotification(storeId, orderId, "accepted");
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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

/**
 * A picker found fewer than ordered. Service only until #13 adds the staff action:
 * `short` is not a resolved line status, so nothing can capture such an order yet.
 */
export async function markLineShort(
  storeId: string,
  lineId: string,
  qtyFound: number,
): Promise<{ ok: true; orderStatus: OrderStatus } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);

    const line = await tx.orderLine.findUnique({ where: { id: lineId } });
    if (!line) return { ok: false, error: "Order line not found" };
    if (line.status !== "pending") {
      return { ok: false, error: `Line already resolved (${line.status})` };
    }
    if (!Number.isInteger(qtyFound) || qtyFound < 0 || qtyFound >= line.qtyOrdered) {
      return { ok: false, error: "Quantity found must be a whole number below the quantity ordered" };
    }

    const order = await tx.order.findUnique({ where: { id: line.orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "ACCEPTED" && order.status !== "PICKING") {
      return { ok: false, error: `Cannot mark lines short for order in status ${order.status}` };
    }

    await tx.orderLine.update({
      where: { id: lineId },
      data: { status: "short", qtyPicked: qtyFound },
    });
    if (order.status === "ACCEPTED") {
      await tx.order.update({ where: { id: order.id }, data: { status: "PICKING" } });
    }
    await settleShortLine(tx, storeId, lineId, line.qtyOrdered - qtyFound);

    return { ok: true, orderStatus: "PICKING" };
  }, LEDGER_TRANSACTION);
}

type CaptureRetryResult =
  | { ok: true; capturedAmountCents: number }
  | { ok: false; error: string; resolved: "cancelled" | "waiting" };

async function noteCaptureServerError(
  storeId: string,
  orderId: string,
  attempt: number,
): Promise<CaptureRetryResult> {
  if (attempt >= MAX_CAPTURE_ATTEMPTS) {
    return settleUnconfirmedCapture(storeId, orderId);
  }
  return { ok: false, error: "Card capture failed temporarily; we'll retry", resolved: "waiting" };
}

async function settleUnconfirmedCapture(
  storeId: string,
  orderId: string,
): Promise<CaptureRetryResult> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({ where: { id: orderId } });
  });
  if (!order || !order.paymentIntentId) {
    return { ok: false, error: "Order status changed during capture", resolved: "waiting" };
  }
  if (order.status === "CANCELLED") {
    return {
      ok: false,
      error: "Payment authorization was released — order cancelled; contact the customer",
      resolved: "cancelled",
    };
  }
  if (order.status === fulfilledStatus(order.fulfillment) || order.status === "COMPLETED") {
    const stored = storedCaptureAmount(order.capturedAmountCents);
    if (!stored.ok) return { ...stored, resolved: "waiting" };
    return stored;
  }
  if (order.status !== "CAPTURING") {
    return { ok: false, error: "Order status changed during capture", resolved: "waiting" };
  }

  const stripe = getStripeProvider();
  let pi;
  try {
    pi = await stripe.retrievePaymentIntent(order.paymentIntentId);
  } catch (err) {
    if (isRetryableProviderError(err)) {
      return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
    }
    throw err;
  }

  const settled = await settlePaymentStatus(storeId, order, order.paymentIntentId, pi);
  if (settled.outcome === "captured") {
    return { ok: true, capturedAmountCents: settled.capturedAmountCents };
  }
  if (settled.outcome === "cancelled") {
    return {
      ok: false,
      error: "Payment authorization was released — order cancelled; contact the customer",
      resolved: "cancelled",
    };
  }

  if (settled.outcome === "authorized") {
    const reservedRelease = await reserveAttempt(storeId, orderId, "cancel_retry", { releaseHold: true });
    if (!reservedRelease.ok) {
      return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
    }
    const releaseAttempt = reservedRelease.attempt;
    try {
      await stripe.cancelPaymentIntent(order.paymentIntentId, cancelKey(orderId, releaseAttempt));
      await noteAttemptReleased(storeId, orderId, "cancel_retry", releaseAttempt);
    } catch (err) {
      if (isIdempotencyKeyInUse(err)) {
        await noteAttemptInFlight(storeId, orderId, "cancel_retry", releaseAttempt);
        return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
      }
      if (isRetryableProviderError(err)) {
        const freshAttempt = await stripe.retrievePaymentIntent(order.paymentIntentId);
        if (freshAttempt.status !== "canceled") {
          await noteAttemptReleased(storeId, orderId, "cancel_retry", releaseAttempt);
        }
        return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
      }
      if (err instanceof ProviderStateError) {
        let fresh;
        try {
          fresh = await stripe.retrievePaymentIntent(order.paymentIntentId);
        } catch (retrieveErr) {
          if (isRetryableProviderError(retrieveErr)) {
            return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
          }
          throw retrieveErr;
        }
        if (fresh.status === "succeeded") {
          await finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, fresh.amountReceived);
          return { ok: true, capturedAmountCents: fresh.amountReceived };
        }
        if (fresh.status !== "canceled") {
          return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
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

  return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
}

async function registerE2EPayment(paymentIntentId: string, authorizedCents: number): Promise<void> {
  if (stripeProviderKind() !== "fake") return;
  // pi_seed_ is an order fixture. pi_fake_ is the checkout harness intent.
  if (!paymentIntentId.startsWith("pi_seed_") && !paymentIntentId.startsWith("pi_fake_")) return;
  const { ensureAuthorizedAmount } = await import("../stripe/fake");
  ensureAuthorizedAmount(paymentIntentId, authorizedCents);
}

async function persistRefundFailure(
  storeId: string,
  orderId: string,
  refundId: string,
  refundStatus: string,
): Promise<void> {
  const preview = await storeScoped(storeId).order.findUnique({ where: { id: orderId } });
  let restoredCapture: number | undefined;
  if (preview && preview.capturedAmountCents == null && preview.paymentIntentId) {
    const pi = await getStripeProvider().retrievePaymentIntent(preview.paymentIntentId);
    if (pi.amountReceived > 0) restoredCapture = pi.amountReceived;
  }
  let alreadyResolved = false;
  let wrote = false;
  let recordedFailure = false;
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CANCELLING" && current.status !== "CANCELLED")) return;
    const manual = await tx.auditLog.findFirst({
      where: orderAuditWhere(orderId, "refund_resolved_manually"),
    });
    if (manual) {
      alreadyResolved = true;
      return;
    }
    wrote = true;
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "REFUND_FAILED",
        refundId,
        ...(restoredCapture != null && current.capturedAmountCents == null
          ? { capturedAmountCents: restoredCapture }
          : {}),
      },
    });
    const prior = await tx.auditLog.findMany({
      where: orderAuditWhere(orderId, "refund_failed"),
    });
    const duplicate = prior.some((log) => {
      const after = log.after as { refundId?: string } | null;
      return after?.refundId === refundId;
    });
    if (duplicate) return;
    recordedFailure = true;
    await tx.auditLog.create({
      data: systemAuditData(storeId, orderId, "refund_failed", {
        refundId,
        refundStatus,
        alert: "store_and_platform",
      }),
    });
  });
  if ((wrote || alreadyResolved) && preview?.paymentIntentId) {
    await syncProviderRefund(preview.paymentIntentId, refundId, refundStatus);
  }
  if (alreadyResolved || !recordedFailure) return;
  console.error(
    `Refund ${refundStatus} for order ${orderId} (${refundId}). Customer is still charged. Store and platform alerted.`,
  );
}

async function settleCapturedRefund(
  storeId: string,
  orderId: string,
  paymentIntentId: string,
  refund: RefundResult,
): Promise<{ outcome: "refunded" } | { outcome: "failed" | "pending" | "waiting" | "blocked"; error: string }> {
  const decision = await refundReadyToSettle(paymentIntentId, orderId, storeId, refund);
  if (refundBlocked(decision)) {
    return { outcome: "blocked", error: "Refund was resolved while the bank was working" };
  }
  if (refundInFlight(decision)) {
    return { outcome: "waiting", error: "Refund is still confirming with the bank" };
  }
  if (decision.status === "succeeded" || isTerminalRefundStatus(decision.status)) {
    await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      const request = await tx.refundRequest.findFirst({
        where: { orderId, providerRefundId: decision.refundId },
      });
      if (!request) return;
      await tx.refundRequest.update({
        where: { id: request.id },
        data: { state: "CREATED", providerStatus: decision.status, lastCheckedAt: new Date() },
      });
    });
  }
  if (decision.status === "succeeded") {
    if (await findOpenRefundRequest(storeId, orderId)) {
      return { outcome: "waiting", error: "Refund is still confirming with the bank" };
    }
    await evaluateOrderRefundState(orderId);
    await finalizeCancelledOrder(storeId, orderId, "anomaly_refund", {
      from: ["CANCELLING"],
      refundId: decision.refundId,
      after: { refundId: decision.refundId, amountRefunded: decision.amountRefunded },
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
): Promise<RefundResult | { inFlight: true } | { blocked: true }> {
  if (refund.status !== "succeeded") return refund;
  const stripe = getStripeProvider();
  const open = (items: RefundResult[]) =>
    items.find((item) => item.status === "pending" || item.status === "requires_action");

  const listed = await stripe.listRefunds(paymentIntentId);
  const pending = open(listed);
  if (pending) return pending;
  const captured = await stripe.retrievePaymentIntent(paymentIntentId);
  const settled = canonicalSucceededSettlement(listed, captured.amountReceived);
  if (settled) return settled;

  const gap = await refundCapturedBalance(paymentIntentId, orderId, storeId);
  if (refundInFlight(gap) || refundBlocked(gap)) return gap;
  if (gap.status !== "succeeded") return gap;
  const again = await stripe.listRefunds(paymentIntentId);
  const stillPending = open(again);
  if (stillPending) return stillPending;
  const after = await stripe.retrievePaymentIntent(paymentIntentId);
  const settledAgain = canonicalSucceededSettlement(again, after.amountReceived);
  if (settledAgain) return settledAgain;
  return { ...gap, status: "pending" };
}

/** Newest succeeded refund id, with the sum of every succeeded refund on the charge. */
function canonicalSucceededSettlement(listed: RefundResult[], amountReceived: number): RefundResult | null {
  const succeeded = listed.filter((refund) => refund.status === "succeeded");
  const covered = succeeded.reduce((sum, refund) => sum + refund.amountRefunded, 0);
  if (succeeded.length === 0 || covered < amountReceived) return null;
  return { ...succeeded[0], amountRefunded: covered };
}

async function syncProviderRefund(paymentIntentId: string, refundId: string, status: string): Promise<void> {
  let amountRefunded = 0;
  let reservationKey: string | undefined;
  try {
    const listed = await getStripeProvider().listRefunds(paymentIntentId);
    const match = listed.find((item) => item.refundId === refundId);
    if (match) {
      amountRefunded = match.amountRefunded;
      reservationKey = match.reservationKey;
    }
  } catch {
    // The status the caller already observed still has to be applied.
  }
  await applyProviderRefund({
    refundId,
    amountRefunded,
    status,
    paymentIntentId,
    ...(reservationKey ? { reservationKey } : {}),
  });
}

function refundStillCovers(refunds: RefundResult[], capturedCents: number): boolean {
  if (capturedCents <= 0) return false;
  return coveredRefundCents(refunds) >= capturedCents;
}

/** One failure record per refund. A repeat of the same refund does not alert again. */
async function recordDistinctRefundFailure(
  storeId: string,
  orderId: string,
  refundId: string,
  refundStatus: string,
): Promise<void> {
  let recorded = false;
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const prior = await tx.auditLog.findMany({
      where: orderAuditWhere(orderId, "refund_failed"),
    });
    const duplicate = prior.some((log) => {
      const after = log.after as { refundId?: string } | null;
      return after?.refundId === refundId;
    });
    if (duplicate) return;
    recorded = true;
    await tx.auditLog.create({
      data: systemAuditData(storeId, orderId, "refund_failed", {
        refundId,
        refundStatus,
        alert: "store_and_platform",
      }),
    });
  });
  if (!recorded) return;
  console.error(
    `Refund ${refundStatus} for order ${orderId} (${refundId}). Customer is still charged. Store and platform alerted.`,
  );
}

export async function markTerminalRefundFailure(input: {
  paymentIntentId: string;
  refundId: string;
  refundStatus: string;
}): Promise<{ ok: true; action: string } | { ok: false; error: string; retry?: boolean }> {
  if (!isTerminalRefundStatus(input.refundStatus)) return { ok: true, action: "ignored" };
  const order = await findOrderByPaymentIntent(input.paymentIntentId);
  if (!order) {
    console.warn(`refund.failed for unknown PaymentIntent ${input.paymentIntentId}`);
    return { ok: false, error: "Order not found" };
  }
  if (order.status === "REFUND_FAILED") {
    await syncProviderRefund(input.paymentIntentId, input.refundId, input.refundStatus);
    await recordDistinctRefundFailure(order.storeId, order.id, input.refundId, input.refundStatus);
    return { ok: true, action: "already_recorded" };
  }
  if (order.status !== "CANCELLING" && order.status !== "CANCELLED") {
    console.warn(`refund.failed ignored for order ${order.id} in status ${order.status}`);
    return { ok: true, action: "ignored" };
  }

  const current = await storeScoped(order.storeId).order.findUnique({ where: { id: order.id } });
  if (!current) return { ok: false, error: "Order not found" };
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
    if (isRetryableProviderError(err)) {
      return { ok: false, error: "Refund coverage could not be read", retry: true };
    }
    throw err;
  }
  if (amountReceived === 0) return { ok: true, action: "ignored" };
  const captured = amountReceived;
  const covered = refundStillCovers(listed, captured);
  const action = covered ? "refund_failed_while_covered" : "refund_failed";

  let wrote = false;
  let alreadyResolved = false;
  await storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const row = await tx.order.findUnique({ where: { id: order.id } });
    if (!row || (row.status !== "CANCELLING" && row.status !== "CANCELLED")) return;
    const manual = await tx.auditLog.findFirst({
      where: orderAuditWhere(order.id, "refund_resolved_manually"),
    });
    if (manual) {
      alreadyResolved = true;
      return;
    }
    const prior = await tx.auditLog.findMany({ where: orderAuditWhere(order.id, action) });
    const duplicate = prior.some((log) => {
      const after = log.after as { refundId?: string } | null;
      return after?.refundId === input.refundId;
    });
    if (duplicate) return;
    if (!covered) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "REFUND_FAILED",
          refundId: input.refundId,
          capturedAmountCents: row.capturedAmountCents ?? captured,
        },
      });
    }
    await tx.auditLog.create({
      data: systemAuditData(order.storeId, order.id, action, {
        refundId: input.refundId,
        refundStatus: input.refundStatus,
        alert: covered ? "store" : "store_and_platform",
      }),
    });
    wrote = true;
  });

  if (wrote || alreadyResolved) {
    await syncProviderRefund(input.paymentIntentId, input.refundId, input.refundStatus);
  }
  if (alreadyResolved) return { ok: true, action: "already_resolved" };
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
      const stored = storedCaptureAmount(order.capturedAmountCents);
      if (!stored.ok) return stored;
      const amount = stored.capturedAmountCents;
      const fee = applicationFeeForCapture(amount, {
        fulfillment: order.fulfillment,
        deliveryFeeCents: order.deliveryFeeCents,
      });
      return {
        ok: true as const,
        capturedAmountCents: amount,
        applicationFeeAmount: fee > 0 ? fee : undefined,
        paymentIntentId: order.paymentIntentId!,
        totalAuthorizedCents: order.totalAuthorizedCents,
        newStatus: fulfilledStatus(order.fulfillment),
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

    // Nothing picked: release the whole hold, including the delivery fee and tip.
    const capturedAmountCents = lineTotalCents === 0
      ? 0
      : lineTotalCents + order.tipCents + order.deliveryFeeCents;

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

    const newStatus: OrderStatus = fulfilledStatus(order.fulfillment);

    const fee = applicationFeeForCapture(capturedAmountCents, {
      fulfillment: order.fulfillment,
      deliveryFeeCents: order.deliveryFeeCents,
    });

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
      voidInsteadOfCapture: false,
      orderId: order.id,
      storeId,
    };
  });

  if (!validation.ok) return validation;

  // K3: below-minimum amount — void the authorization instead of capturing
  if (validation.voidInsteadOfCapture) {
    const stripe = getStripeProvider();
    let cancelAttempt: number | undefined;
    try {
      const reservedCancel = await reserveAttempt(storeId, orderId, "cancel_retry");
      if (!reservedCancel.ok) return { ok: false, error: "Cancellation is still confirming with the bank" };
      cancelAttempt = reservedCancel.attempt;
      await registerE2EPayment(validation.paymentIntentId, validation.totalAuthorizedCents);
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        cancelKey(orderId, reservedCancel.attempt),
      );
      await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
    } catch (err) {
      if (isIdempotencyKeyInUse(err) && cancelAttempt !== undefined) {
        await noteAttemptInFlight(storeId, orderId, "cancel_retry", cancelAttempt);
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (isRetryableProviderError(err) && cancelAttempt !== undefined) {
        const fresh = await stripe.retrievePaymentIntent(validation.paymentIntentId);
        if (fresh.status !== "canceled") {
          await noteAttemptReleased(storeId, orderId, "cancel_retry", cancelAttempt);
        }
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        if (cancelAttempt !== undefined) {
          await noteAttemptReleased(storeId, orderId, "cancel_retry", cancelAttempt);
        }
        const refund = await refundCapturedBalance(validation.paymentIntentId, orderId, storeId);
        if (refundBlocked(refund)) return { ok: false, error: "Order status changed during cancellation" };
        if (refundInFlight(refund)) return { ok: false, error: "Refund is still confirming with the bank" };
        const settled = await settleCapturedRefund(storeId, orderId, validation.paymentIntentId, refund);
        if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
        return { ok: true, capturedAmountCents: 0, voided: true };
      }
      throw err;
    }
    await finalizeCancelledOrder(storeId, orderId, "void_zero_amount", { from: ["CANCELLING"] });
    return { ok: true, capturedAmountCents: 0, voided: true };
  }

  // Phase 2: reserve the attempt, then call Stripe outside the lock.
  // A stored 5xx is pinned to its key, so the next attempt is a new row.
  const stripe = getStripeProvider();
  const reservedCapture = await reserveAttempt(storeId, orderId, "capture_retry", {
    alert: "store_and_platform",
  });
  if (!reservedCapture.ok) {
    if (reservedCapture.exhausted) {
      const settled = await settleUnconfirmedCapture(storeId, orderId);
      if (settled.ok) return { ok: true, capturedAmountCents: settled.capturedAmountCents };
      return { ok: false, error: settled.error };
    }
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
      await noteAttemptInFlight(storeId, orderId, "capture_retry", captureAttempt);
      return { ok: false, error: "Card capture is still confirming with the bank" };
    }
    if (isRetryableProviderError(err)) {
      const fresh = await stripe.retrievePaymentIntent(validation.paymentIntentId);
      if (fresh.status !== "succeeded") {
        await noteAttemptReleased(storeId, orderId, "capture_retry", captureAttempt);
      }
      const settled = await noteCaptureServerError(storeId, orderId, captureAttempt);
      if (settled.ok) return { ok: true, capturedAmountCents: settled.capturedAmountCents };
      return { ok: false, error: settled.error };
    }
    if (err instanceof ProviderStateError) {
      await finalizeCancelledOrder(storeId, orderId, "capture_on_canceled_pi", {
        from: ["CAPTURING"],
        after: { actualStatus: err.actualStatus },
      });
      return { ok: false, error: "Payment authorization expired or was voided — order cancelled; contact the customer" };
    }
    throw err;
  }

  // Phase 3: finalize in transaction (verify still CAPTURING)
  // Persist Stripe's amount_received, not the requested amount (M2)
  let notifyReady = false;
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    notifyReady = false;
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CAPTURING") {
      if (order && (order.status === validation.newStatus || order.status === "COMPLETED")) {
        const stored = storedCaptureAmount(order.capturedAmountCents);
        if (stored.ok) return stored;
      }
      if (order?.status === "CANCELLED") {
        return {
          ok: false as const,
          error: "Payment authorization was released — order cancelled; contact the customer",
        };
      }
      return { ok: false as const, error: CAPTURE_STATUS_CHANGED };
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: validation.newStatus,
        readyAt: new Date(),
        capturedAmountCents: captureResult.amountCaptured,
      },
    });
    await settleCapturedStock(tx, storeId, orderId);
    notifyReady = await recordOrderNotification(tx, storeId, orderId, "ready");
    return { ok: true as const, capturedAmountCents: captureResult.amountCaptured };
  }, LEDGER_TRANSACTION);

  if (!finalize.ok) return finalize;
  if (notifyReady) scheduleOrderNotification(storeId, orderId, "ready");

  return { ok: true, capturedAmountCents: finalize.capturedAmountCents };
}

export async function completePickup(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found", notify: false };
    if (order.status !== "AWAITING_PICKUP") {
      if (order.fulfillment === "delivery" || order.fulfillment === "store-delivery" || order.fulfillment === "courier") {
        return { ok: false as const, error: "Cannot complete pickup for delivery order — use courier dispatch", notify: false };
      }
      return { ok: false as const, error: "Order is not awaiting pickup", notify: false };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    const notify = await recordOrderNotification(tx, storeId, orderId, "completed");
    return { ok: true as const, notify };
  });
  if (result.ok && result.notify) scheduleOrderNotification(storeId, orderId, "completed");
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Store delivery only: the store's own driver has left with a packed order. */
export async function markOutForDelivery(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found", notify: false };
    if (order.fulfillment !== "store-delivery") {
      return { ok: false as const, error: STORE_DELIVERY_ONLY, notify: false };
    }
    if (order.status !== "READY") {
      return { ok: false as const, error: `Cannot send out for delivery in status ${order.status}`, notify: false };
    }
    const now = new Date();
    await tx.order.update({
      where: { id: orderId },
      data: { status: "OUT_FOR_DELIVERY", outForDeliveryAt: now },
    });
    await tx.deliveryEvent.create({
      data: { storeId, orderId, type: "out_for_delivery", payload: {} },
    });
    const notify = await recordOrderNotification(tx, storeId, orderId, "out_for_delivery");
    return { ok: true as const, notify };
  });
  if (result.ok && result.notify) scheduleOrderNotification(storeId, orderId, "out_for_delivery");
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function deliveredRejection(order: { status: string; fulfillment: string } | null): string | null {
  if (!order) return "Order not found";
  if (order.fulfillment !== "store-delivery") return STORE_DELIVERY_ONLY;
  if (order.status !== "OUT_FOR_DELIVERY") return `Cannot mark delivered in status ${order.status}`;
  return null;
}

/**
 * Store delivery only, and only with a photo. The photo is uploaded first; if the
 * transition is then rejected, the order is unchanged and the photo is deleted. A thrown
 * transaction keeps it: the commit may have landed, and a lost proof is worse than an orphan.
 */
export async function markDelivered(
  storeId: string,
  orderId: string,
  photo: Uint8Array | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deliveryProofBucket()) return { ok: false, error: PROOF_STORAGE_NOT_SET_UP };
  const prepared = await prepareProofPhoto(photo);
  if (!prepared.ok) return prepared;
  const current = await storeScoped(storeId).order.findUnique({
    where: { id: orderId },
    select: { status: true, fulfillment: true },
  });
  const early = deliveredRejection(current);
  if (early) return { ok: false, error: early };

  const uploadedAt = new Date();
  const key = deliveryProofKey(orderId, uploadedAt.getTime());
  await uploadDeliveryProof(key, prepared.jpeg);

  const result = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    const rejected = deliveredRejection(order);
    if (rejected) return { ok: false as const, error: rejected, notify: false };
    const now = new Date();
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "DELIVERED",
        deliveredAt: now,
        completedAt: now,
        deliveryProofKey: key,
        deliveryProofUploadedAt: uploadedAt,
      },
    });
    await tx.deliveryEvent.create({
      data: { storeId, orderId, type: "delivered", payload: { proofKey: key } },
    });
    const notify = await recordOrderNotification(tx, storeId, orderId, "delivered");
    return { ok: true as const, notify };
  });
  if (!result.ok) {
    await deleteDeliveryProof(key).catch((err: unknown) => {
      console.error(JSON.stringify({ event: "delivery_proof_orphaned", orderId, key, message: err instanceof Error ? err.message : "unknown" }));
    });
    return { ok: false, error: result.error };
  }
  if (result.notify) scheduleOrderNotification(storeId, orderId, "delivered");
  return { ok: true };
}

export async function autoCancelOrder(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return cancelOrder(storeId, orderId, { action: "auto_cancel" });
}

/**
 * Every cancel before capture. A resumed CANCELLING order keeps the cause it was
 * claimed with, so a second caller never relabels it.
 */
export async function cancelOrder(
  storeId: string,
  orderId: string,
  cause: CancelCause,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Phase 1: claim with CANCELLING and write the cause row, under the store lock.
  const validation = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found" };
    if (order.status === "CANCELLING") {
      const causeRow = await tx.auditLog.findFirst({
        where: { entityId: orderId, entityType: "order", action: { in: CANCEL_CAUSE_ACTIONS } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return {
        ok: true as const,
        paymentIntentId: order.paymentIntentId,
        totalAuthorizedCents: order.totalAuthorizedCents,
        refundId: order.refundId,
        action: causeRow?.action ?? cancellationAuditAction(order.acceptedAt),
      };
    }
    if (!CANCELLABLE_FROM[cause.action].includes(order.status as OrderStatus)) {
      return { ok: false as const, error: `Cannot cancel order in status ${order.status}` };
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLING" } });
    await tx.auditLog.create({ data: causeAuditData(storeId, orderId, cause) });
    return {
      ok: true as const,
      paymentIntentId: order.paymentIntentId,
      totalAuthorizedCents: order.totalAuthorizedCents,
      refundId: null,
      action: cause.action,
    };
  });

  if (!validation.ok) return validation;

  // Phase 2: Stripe cancel outside transaction (idempotency key makes retry safe)
  if (validation.paymentIntentId) {
    const stripe = getStripeProvider();
    const reservedCancel = await reserveAttempt(storeId, orderId, "cancel_retry");
    if (!reservedCancel.ok) return { ok: false, error: "Cancellation is still confirming with the bank" };
    try {
      await registerE2EPayment(validation.paymentIntentId, validation.totalAuthorizedCents);
      await stripe.cancelPaymentIntent(
        validation.paymentIntentId,
        cancelKey(orderId, reservedCancel.attempt),
      );
      await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
    } catch (err) {
      if (isIdempotencyKeyInUse(err)) {
        await noteAttemptInFlight(storeId, orderId, "cancel_retry", reservedCancel.attempt);
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (isRetryableProviderError(err)) {
        const fresh = await stripe.retrievePaymentIntent(validation.paymentIntentId);
        if (fresh.status !== "canceled") {
          await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
        }
        return { ok: false, error: "Cancellation is still confirming with the bank" };
      }
      if (err instanceof ProviderStateError) {
        // PI was captured externally — refund and cancel
        await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
        const refund = validation.refundId
          ? await stripe.retrieveRefund(validation.refundId)
          : await refundCapturedBalance(validation.paymentIntentId, orderId, storeId);
        if (refundBlocked(refund)) return { ok: false, error: "Order status changed during cancellation" };
        if (refundInFlight(refund)) return { ok: false, error: "Refund is still confirming with the bank" };
        const settled = await settleCapturedRefund(storeId, orderId, validation.paymentIntentId, refund);
        if (settled.outcome !== "refunded") return { ok: false, error: settled.error };
        return { ok: true };
      }
      throw err;
    }
  }

  // Phase 3: one cancellation write, which also returns the order's reserved stock.
  const finalize = await finalizeCancelledOrder(storeId, orderId, validation.action, { from: ["CANCELLING"] });
  if (!finalize.wrote) return { ok: false, error: "Order status changed during cancellation" };

  return { ok: true };
}

/** Every outcome the stuck-order sweep can report. */
export type ReconcileAction =
  | "already_resolved"
  | "anomaly_refund"
  | "finalized_capture"
  | "finalized_cancel"
  | "unknown_stripe_status";

export type ReconcileResult =
  | { ok: true; action: ReconcileAction }
  | { ok: false; error: string; waiting?: boolean };

export async function reconcileStuckOrder(
  storeId: string,
  orderId: string,
): Promise<ReconcileResult> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({
      where: { id: orderId },
      include: { lines: true },
    });
  });

  if (order?.paymentIntentId) {
    await registerE2EPayment(order.paymentIntentId, order.totalAuthorizedCents);
    await reconcileOpenRefundRequests(storeId, orderId);
    await reconcileAbandonedRefundRequests(storeId, orderId);
  }

  if (!order || (order.status !== "CAPTURING" && order.status !== "CANCELLING")) {
    if (order?.paymentIntentId) await evaluateOrderRefundState(orderId);
    return { ok: true, action: "already_resolved" };
  }

  if (!order.paymentIntentId) {
    return { ok: false, error: "Order has no payment intent" };
  }

  const stripe = getStripeProvider();
  const pi = await stripe.retrievePaymentIntent(order.paymentIntentId);

  const settledStatus = await settlePaymentStatus(storeId, order, order.paymentIntentId, pi);
  if (settledStatus.outcome === "captured") return { ok: true, action: "finalized_capture" };
  if (settledStatus.outcome === "cancelled") return { ok: true, action: "finalized_cancel" };
  if (settledStatus.outcome === "refund") return settledStatus.result;

  if (settledStatus.outcome === "authorized") {
    if (order.status === "CAPTURING") {
      const stored = storedCaptureAmount(order.capturedAmountCents);
      if (!stored.ok) return { ...stored, waiting: true };
      const amount = stored.capturedAmountCents;
      const reservedCapture = await reserveAttempt(storeId, orderId, "capture_retry", {
        alert: "store_and_platform",
      });
      if (!reservedCapture.ok) {
        if (reservedCapture.exhausted) {
          const settled = await settleUnconfirmedCapture(storeId, orderId);
          if (settled.ok) return { ok: true, action: "finalized_capture" };
          if (settled.resolved === "cancelled") return { ok: true, action: "finalized_cancel" };
          return { ok: false, error: settled.error, waiting: true };
        }
        return { ok: false, error: "capture_backoff", waiting: true };
      }
      const attempt = reservedCapture.attempt;
      const sweepFee = applicationFeeForCapture(amount, {
        fulfillment: order.fulfillment,
        deliveryFeeCents: order.deliveryFeeCents,
      });
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
          await noteAttemptInFlight(storeId, orderId, "capture_retry", attempt);
          return { ok: false, error: "Card capture is still confirming with the bank", waiting: true };
        }
        if (isRetryableProviderError(err)) {
          const fresh = await stripe.retrievePaymentIntent(order.paymentIntentId);
          if (fresh.status !== "succeeded") {
            await noteAttemptReleased(storeId, orderId, "capture_retry", attempt);
          }
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
          await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
        } catch (err) {
          if (isIdempotencyKeyInUse(err)) {
            await noteAttemptInFlight(storeId, orderId, "cancel_retry", reservedCancel.attempt);
            return { ok: false, error: "Cancellation is still confirming with the bank", waiting: true };
          }
          if (isRetryableProviderError(err)) {
            const fresh = await stripe.retrievePaymentIntent(order.paymentIntentId);
            if (fresh.status !== "canceled") {
              await noteAttemptReleased(storeId, orderId, "cancel_retry", reservedCancel.attempt);
            }
            return { ok: false, error: "Cancellation is still confirming with the bank", waiting: true };
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof ProviderStateError) {
          const freshPi = await stripe.retrievePaymentIntent(order.paymentIntentId);
          if (freshPi.status === "succeeded") {
            return refundCapturedCancellation(storeId, order, order.paymentIntentId);
          }
        }
        throw err;
      }
      return finalizeCancelFromSweep(storeId, orderId);
    }
  }

  return { ok: true, action: "unknown_stripe_status" };
}

type SettlingOrder = { id: string; status: string; fulfillment: string; refundId: string | null };

/** What a PaymentIntent status settles: `succeeded` and `canceled` finalize here; `authorized` and `pending` are left to the caller. */
type PaymentStatusSettlement =
  | { outcome: "captured"; capturedAmountCents: number }
  | { outcome: "cancelled" }
  | { outcome: "refund"; result: ReconcileResult }
  | { outcome: "authorized" }
  | { outcome: "pending" };

/** The one Stripe status ladder for the capture settle and the stuck-order sweep. Call it outside the store lock. */
async function settlePaymentStatus(
  storeId: string,
  order: SettlingOrder,
  paymentIntentId: string,
  pi: { status: string; amountReceived: number },
): Promise<PaymentStatusSettlement> {
  if (pi.status === "succeeded") {
    if (order.status === "CANCELLING") {
      return { outcome: "refund", result: await refundCapturedCancellation(storeId, order, paymentIntentId) };
    }
    await finalizeCaptureFromSweep(storeId, order.id, order.fulfillment, pi.amountReceived);
    return { outcome: "captured", capturedAmountCents: pi.amountReceived };
  }
  if (pi.status === "canceled") {
    await finalizeCancelFromSweep(storeId, order.id, await canceledHoldAction(storeId, order.id));
    return { outcome: "cancelled" };
  }
  if (pi.status === "requires_capture") return { outcome: "authorized" };
  return { outcome: "pending" };
}

/** A cancelling order whose payment was captured anyway: refund the captured balance. */
async function refundCapturedCancellation(
  storeId: string,
  order: SettlingOrder,
  paymentIntentId: string,
): Promise<ReconcileResult> {
  let refund;
  if (order.refundId) {
    refund = await getStripeProvider().retrieveRefund(order.refundId);
  } else {
    refund = await refundCapturedBalance(paymentIntentId, order.id, storeId);
    if (refundBlocked(refund)) return { ok: true, action: "already_resolved" };
    if (refundInFlight(refund)) {
      return { ok: false, error: "Refund is still confirming with the bank", waiting: true };
    }
  }
  const settled = await settleCapturedRefund(storeId, order.id, paymentIntentId, refund);
  if (settled.outcome === "blocked") return { ok: true, action: "already_resolved" };
  if (settled.outcome !== "refunded") {
    return {
      ok: false,
      error: settled.error,
      waiting: settled.outcome === "pending" || settled.outcome === "waiting",
    };
  }
  return { ok: true, action: "anomaly_refund" };
}

async function finalizeCaptureFromSweep(
  storeId: string,
  orderId: string,
  fulfillment: string,
  capturedAmountCents: number,
): Promise<{ ok: true; action: ReconcileAction }> {
  const newStatus: OrderStatus = fulfilledStatus(fulfillment);

  let notifyReady = false;
  await storeScopedTransaction(storeId, async (tx) => {
    notifyReady = false;
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
      data: systemAuditData(storeId, orderId, "reconcile_capture", {}),
    });
    await settleCapturedStock(tx, storeId, orderId);
    notifyReady = await recordOrderNotification(tx, storeId, orderId, "ready");
  }, LEDGER_TRANSACTION);
  if (notifyReady) scheduleOrderNotification(storeId, orderId, "ready");

  return { ok: true, action: "finalized_capture" };
}

/** A canceled hold we asked to release keeps its release audit and alert, even if the cancel's response was lost. */
async function canceledHoldAction(storeId: string, orderId: string): Promise<"reconcile_cancel" | "capture_released"> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.auditLog.findMany({ where: orderAuditWhere(orderId, "cancel_retry") }),
  );
  const released = rows.some((row) => (row.after as { releaseHold?: unknown } | null)?.releaseHold === true);
  return released ? "capture_released" : "reconcile_cancel";
}

async function finalizeCancelFromSweep(
  storeId: string,
  orderId: string,
  action: "reconcile_cancel" | "capture_released" = "reconcile_cancel",
): Promise<{ ok: true; action: ReconcileAction }> {
  await finalizeCancelledOrder(storeId, orderId, action, {
    after: action === "capture_released" ? { alert: "store_and_platform" } : {},
  });
  return { ok: true, action: "finalized_cancel" };
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
