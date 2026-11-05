import { Prisma } from "@prisma/client";
import { storeScoped, storeScopedTransaction, lockStoreRow, findOrderByPaymentIntent } from "../db";
import { getStripeProvider, stripeProviderKind } from "../stripe";
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

type TransitionalStatus = "CAPTURING" | "CANCELLING";

export function fulfilledStatus(fulfillment: string): "AWAITING_PICKUP" | "READY" {
  return fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";
}

function systemAuditData(
  storeId: string,
  orderId: string,
  action: string,
  after: Prisma.InputJsonValue = {},
) {
  return {
    storeId,
    actorId: SYSTEM_ACTOR_ID,
    actorEmail: SYSTEM_ACTOR_EMAIL,
    action,
    entityType: "order" as const,
    entityId: orderId,
    after,
  };
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
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status === "CANCELLED" || !from.includes(current.status as TransitionalStatus)) {
      return { wrote: false };
    }
    const existing = await tx.auditLog.findFirst({ where: { entityId: orderId, action } });
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
    return { wrote: true };
  });
}

function greaterThanUnrefunded(err: unknown): boolean {
  return err instanceof OverRefundError;
}

/** Refund whatever of a captured charge is still unrefunded. A concurrent refund is re-read once. */
async function refundCapturedBalance(
  paymentIntentId: string,
  orderId: string,
  storeId: string,
): Promise<RefundResult | { inFlight: true } | { blocked: true }> {
  const stripe = getStripeProvider();
  let pi = await stripe.retrievePaymentIntent(paymentIntentId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const already = pi.amountRefunded ?? 0;
    const remaining = Math.max(0, pi.amountReceived - already);
    if (remaining === 0) {
      return refundRecordedOnCharge(paymentIntentId, pi.amountReceived);
    }
    const uncovered = await failedRefundLeavingCaptureUncovered(paymentIntentId, pi.amountReceived);
    if (uncovered) return uncovered;
    const reservedRefund = await reserveAttempt(storeId, orderId, "refund_retry", {
      alreadyRefundedCents: already,
    });
    if (!reservedRefund.ok) {
      if (reservedRefund.blocked) return { blocked: true };
      throw new Error("Refund attempt is still in backoff");
    }
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
        await noteAttemptReleased(storeId, orderId, "refund_retry", refundAttempt);
        pi = after;
        continue;
      }
      await noteAttemptReleased(storeId, orderId, "refund_retry", refundAttempt);
      return refund;
    } catch (err) {
      if (isIdempotencyKeyInUse(err)) {
        return { inFlight: true };
      }
      if (isRetryableProviderError(err)) {
        const fresh = await stripe.retrievePaymentIntent(paymentIntentId);
        if ((fresh.amountRefunded ?? 0) <= already) {
          await noteAttemptReleased(storeId, orderId, "refund_retry", refundAttempt);
        }
        throw err;
      }
      if (attempt === 0 && greaterThanUnrefunded(err)) {
        await noteAttemptReleased(storeId, orderId, "refund_retry", refundAttempt);
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
): Promise<{ ok: true; attempt: number } | { ok: false; waitMs: number; exhausted?: boolean; blocked?: boolean }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    if (action === "refund_retry") {
      const current = await tx.order.findUnique({ where: { id: orderId } });
      const manual = await tx.auditLog.findFirst({
        where: { entityId: orderId, action: "refund_resolved_manually" },
      });
      if (manual || !current || current.status !== "CANCELLING") {
        return { ok: false, waitMs: 0, blocked: true };
      }
    }
    const prior = await tx.auditLog.findMany({
      where: { entityId: orderId, action },
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
    if (action === "refund_retry" || action === "cancel_retry") {
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
  action: "capture_retry" | "cancel_retry" | "refund_retry",
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
  action: "capture_retry" | "cancel_retry" | "refund_retry",
  attempt: number,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const prior = await tx.auditLog.findMany({
      where: { entityId: orderId, action },
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
    return { ok: true, capturedAmountCents: order.capturedAmountCents ?? 0 };
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

  if (pi.status === "succeeded") {
    await finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, pi.amountReceived);
    return { ok: true, capturedAmountCents: pi.amountReceived };
  }

  if (pi.status === "requires_capture") {
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

  if (pi.status === "canceled") {
    await finalizeCancelFromSweep(storeId, orderId, "reconcile_cancel");
    return {
      ok: false,
      error: "Payment authorization was released — order cancelled; contact the customer",
      resolved: "cancelled",
    };
  }

  return { ok: false, error: "Card capture is still confirming with the bank", resolved: "waiting" };
}

async function registerE2EPayment(paymentIntentId: string, authorizedCents: number): Promise<void> {
  if (stripeProviderKind() !== "fake" || !paymentIntentId.startsWith("pi_seed_")) return;
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
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CANCELLING" && current.status !== "CANCELLED")) return;
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    if (manual) {
      alreadyResolved = true;
      return;
    }
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
    const existing = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_failed" },
    });
    if (existing) return;
    await tx.auditLog.create({
      data: systemAuditData(storeId, orderId, "refund_failed", {
        refundId,
        refundStatus,
        alert: "store_and_platform",
      }),
    });
  });
  if (alreadyResolved) return;
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
  if (decision.status === "succeeded") {
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

/** A failed refund that leaves the capture uncovered is resolved by hand. Never start another. */
async function failedRefundLeavingCaptureUncovered(
  paymentIntentId: string,
  amountReceived: number,
): Promise<RefundResult | null> {
  const listed = await getStripeProvider().listRefunds(paymentIntentId);
  const covering = listed
    .filter((refund) => refund.status === "succeeded" || refund.status === "pending" || refund.status === "requires_action")
    .reduce((sum, refund) => sum + refund.amountRefunded, 0);
  if (covering >= amountReceived) return null;
  return listed.find((refund) => isTerminalRefundStatus(refund.status)) ?? null;
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
}): Promise<{ ok: true; action: string } | { ok: false; error: string; retry?: boolean }> {
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
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    if (manual) {
      alreadyResolved = true;
      return;
    }
    const prior = await tx.auditLog.findMany({ where: { entityId: order.id, action } });
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
      const amount = order.capturedAmountCents ?? 0;
      const fee = applicationFeeForCapture(amount, order.deliveryFeeCents);
      return {
        ok: true as const,
        capturedAmountCents: amount,
        applicationFeeAmount: fee > 0 ? fee : undefined,
        paymentIntentId: order.paymentIntentId!,
        totalAuthorizedCents: order.totalAuthorizedCents,
        newStatus: fulfilledStatus(order.fulfillment),
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

    const newStatus: OrderStatus = fulfilledStatus(order.fulfillment);

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
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CAPTURING") {
      if (order?.status === validation.newStatus && order.capturedAmountCents != null) {
        return { ok: true as const, capturedAmountCents: order.capturedAmountCents };
      }
      if (order?.status === "CANCELLED") {
        return {
          ok: false as const,
          error: "Payment authorization was released — order cancelled; contact the customer",
        };
      }
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
    return { ok: true as const, capturedAmountCents: captureResult.amountCaptured };
  });

  if (!finalize.ok) return finalize;

  return { ok: true, capturedAmountCents: finalize.capturedAmountCents };
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
        totalAuthorizedCents: order.totalAuthorizedCents,
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
      totalAuthorizedCents: order.totalAuthorizedCents,
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

  // Phase 3: one cancellation write. Stock restore stays deferred to #141.
  const finalize = await finalizeCancelledOrder(storeId, orderId, "auto_cancel", { from: ["CANCELLING"] });
  if (!finalize.wrote) return { ok: false, error: "Order status changed during cancellation" };

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

  await registerE2EPayment(order.paymentIntentId, order.totalAuthorizedCents);
  const stripe = getStripeProvider();
  const pi = await stripe.retrievePaymentIntent(order.paymentIntentId);

  if (pi.status === "succeeded") {
    if (order.status === "CANCELLING") {
      let refund;
      if (order.refundId) {
        refund = await stripe.retrieveRefund(order.refundId);
      } else {
        refund = await refundCapturedBalance(order.paymentIntentId, orderId, storeId);
        if (refundBlocked(refund)) return { ok: true, action: "already_resolved" };
        if (refundInFlight(refund)) {
          return { ok: false, error: "Refund is still confirming with the bank", waiting: true };
        }
      }
      const settled = await settleCapturedRefund(storeId, orderId, order.paymentIntentId, refund);
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
        if (reservedCapture.exhausted) {
          const settled = await settleUnconfirmedCapture(storeId, orderId);
          if (settled.ok) return { ok: true, action: "finalized_capture" };
          if (settled.resolved === "cancelled") return { ok: true, action: "finalized_cancel" };
          return { ok: false, error: settled.error, waiting: true };
        }
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
            let refund;
            if (order.refundId) {
              refund = await stripe.retrieveRefund(order.refundId);
            } else {
              refund = await refundCapturedBalance(order.paymentIntentId, orderId, storeId);
              if (refundBlocked(refund)) return { ok: true, action: "already_resolved" };
              if (refundInFlight(refund)) {
                return { ok: false, error: "Refund is still confirming with the bank", waiting: true };
              }
            }
            const settled = await settleCapturedRefund(storeId, orderId, order.paymentIntentId, refund);
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
  const newStatus: OrderStatus = fulfilledStatus(fulfillment);

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
      data: systemAuditData(storeId, orderId, "reconcile_capture"),
    });
  });

  return { ok: true, action: "finalized_capture" };
}

async function finalizeCancelFromSweep(
  storeId: string,
  orderId: string,
  action: "reconcile_cancel" | "capture_released" = "reconcile_cancel",
): Promise<{ ok: true; action: string }> {
  await finalizeCancelledOrder(storeId, orderId, action, {
    after: action === "capture_released" ? { alert: "store_and_platform" } : {},
  });
  return { ok: true, action: "finalized_cancel" };
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
