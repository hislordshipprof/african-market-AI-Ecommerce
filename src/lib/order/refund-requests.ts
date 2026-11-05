import type { Prisma, RefundRequest } from "@prisma/client";
import { findOrderByPaymentIntent, lockStoreRow, platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { getStripeProvider } from "../stripe";
import {
  isIdempotencyKeyInUse,
  isRetryableProviderError,
  OverRefundError,
  RefundNotCreatedError,
} from "../stripe/errors";
import type { RefundResult } from "../stripe/types";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";

/** Inside Stripe's 24h idempotency window. Coordinator default, pending owner confirmation. */
export const REFUND_REQUEST_ABANDON_MS = 23 * 60 * 60 * 1000;

/** Keys whose refundPayment call has not returned in this process. A sweep must not replay them. */
const callsInFlight = new Set<string>();

const TERMINAL_PROVIDER_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export type RefundRequestRow = RefundRequest;

export function requestIsOpen(row: {
  state: string;
  providerStatus: string | null;
}): boolean {
  if (row.state === "RESERVED" || row.state === "UNKNOWN") return true;
  if (row.state !== "CREATED") return false;
  return !row.providerStatus || !TERMINAL_PROVIDER_STATUSES.has(row.providerStatus);
}

type Tx = Pick<Prisma.TransactionClient, "refundRequest" | "auditLog" | "order">;

/** The single check for an open refund request on this order. */
export async function openRefundRequest(tx: Tx, orderId: string): Promise<RefundRequestRow | null> {
  const rows = await tx.refundRequest.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.find((row) => requestIsOpen(row)) ?? null;
}

export async function findOpenRefundRequest(storeId: string, orderId: string): Promise<RefundRequestRow | null> {
  return storeScopedTransaction(storeId, (tx) => openRefundRequest(tx, orderId));
}

function countedCents(listed: RefundResult[], statuses: string[]): number {
  return listed
    .filter((refund) => statuses.includes(refund.status))
    .reduce((sum, refund) => sum + refund.amountRefunded, 0);
}

function systemAudit(
  storeId: string,
  orderId: string,
  action: string,
  after: Prisma.InputJsonValue,
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

async function writeAuditOnce(
  tx: Tx,
  storeId: string,
  orderId: string,
  action: string,
  refundId: string,
  after: Prisma.InputJsonValue,
): Promise<void> {
  const prior = await tx.auditLog.findMany({ where: { entityId: orderId, action } });
  const duplicate = prior.some((row) => {
    const body = row.after as { refundId?: string } | null;
    return body?.refundId === refundId;
  });
  if (duplicate) return;
  await tx.auditLog.create({ data: systemAudit(storeId, orderId, action, after) });
}

function isNotCreated(err: unknown): boolean {
  if (err instanceof RefundNotCreatedError || err instanceof OverRefundError) return true;
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: number; code?: string; type?: string };
  if (candidate.code === "charge_already_refunded" || candidate.code === "amount_too_large") return true;
  return candidate.type === "StripeInvalidRequestError" && candidate.statusCode === 400;
}

async function saveRequest(
  storeId: string,
  id: string,
  data: Prisma.RefundRequestUpdateInput,
): Promise<RefundRequestRow> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    return tx.refundRequest.update({ where: { id }, data: { ...data, lastCheckedAt: new Date() } });
  });
}

/** Map a provider result onto the reserved request. A re-read never closes it by itself. */
export async function classifyRefundRequest(
  row: RefundRequestRow,
  outcome: { refund: RefundResult } | { error: unknown },
): Promise<RefundRequestRow> {
  if ("refund" in outcome) {
    return saveRequest(row.storeId, row.id, {
      state: "CREATED",
      providerRefundId: outcome.refund.refundId,
      providerStatus: outcome.refund.status,
    });
  }
  const err = outcome.error;
  if (isIdempotencyKeyInUse(err) || isRetryableProviderError(err)) {
    return saveRequest(row.storeId, row.id, { state: "UNKNOWN" });
  }
  if (isNotCreated(err)) {
    return saveRequest(row.storeId, row.id, { state: "NOT_CREATED", providerStatus: null });
  }
  return row;
}

async function alertAbandoned(storeId: string, orderId: string, key: string): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await writeAuditOnce(tx, storeId, orderId, "refund_request_unknown", key, {
      key,
      alert: "platform",
    });
  });
  console.error(`Refund request ${key} for order ${orderId} is still unknown. Platform alerted.`);
}

/**
 * List, then replay the stored key, then abandon after 23h.
 * A refund that appears for an abandoned request becomes CREATED.
 */
export async function reconcileRefundRequest(row: RefundRequestRow): Promise<RefundRequestRow> {
  const stripe = getStripeProvider();
  let listed: RefundResult[] = [];
  try {
    listed = await stripe.listRefunds(row.paymentIntentId);
  } catch (err) {
    if (isRetryableProviderError(err)) return row;
    throw err;
  }
  const match = listed.find((refund) => refund.reservationKey === row.key);
  if (match) {
    const updated = await saveRequest(row.storeId, row.id, {
      state: "CREATED",
      providerRefundId: match.refundId,
      providerStatus: match.status,
    });
    await evaluateOrderRefundState(row.orderId);
    return updated;
  }
  if (callsInFlight.has(row.key)) return row;
  const age = Date.now() - row.createdAt.getTime();
  if (age < REFUND_REQUEST_ABANDON_MS && (row.state === "RESERVED" || row.state === "UNKNOWN")) {
    try {
      const refund = await stripe.refundPayment(row.paymentIntentId, row.amountCents, row.key, {
        refundApplicationFee: row.refundApplicationFee,
        reservationKey: row.key,
        orderId: row.orderId,
      });
      const saved = await classifyRefundRequest(row, { refund });
      await evaluateOrderRefundState(row.orderId);
      return saved;
    } catch (err) {
      const saved = await classifyRefundRequest(row, { error: err });
      await evaluateOrderRefundState(row.orderId);
      return saved;
    }
  }
  if (row.state === "ABANDONED" || row.state === "NOT_CREATED" || row.state === "CREATED") return row;
  const abandoned = await saveRequest(row.storeId, row.id, { state: "ABANDONED" });
  await alertAbandoned(row.storeId, row.orderId, row.key);
  await evaluateOrderRefundState(row.orderId);
  return abandoned;
}

export async function reconcileOpenRefundRequests(storeId: string, orderId: string): Promise<void> {
  const rows = await storeScoped(storeId).refundRequest.findMany({ where: { orderId } });
  for (const row of rows) {
    if (requestIsOpen(row)) await reconcileRefundRequest(row);
  }
}

/** Match a closed request to a refund Stripe already has. Never replay the key. */
export async function reconcileAbandonedRefundRequests(storeId: string, orderId: string): Promise<void> {
  const rows = await storeScoped(storeId).refundRequest.findMany({
    where: { orderId, state: "ABANDONED" },
  });
  for (const row of rows) await reconcileRefundRequest(row);
}

async function uncoveredFailure(listed: RefundResult[], captured: number): Promise<RefundResult | null> {
  const covering = countedCents(listed, ["succeeded", "pending", "requires_action"]);
  if (covering >= captured) return null;
  return listed.find((refund) => refund.status === "failed" || refund.status === "canceled") ?? null;
}

/**
 * One app refund. An open request is reconciled instead of starting another.
 * The stored amount is what gets replayed.
 */
export async function submitRefund(
  storeId: string,
  orderId: string,
  paymentIntentId: string,
  depth = 0,
): Promise<RefundResult | { inFlight: true } | { blocked: true }> {
  const gate = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    if (manual || !order || order.status !== "CANCELLING") return { blocked: true as const, open: null };
    return { blocked: false as const, open: await openRefundRequest(tx, orderId) };
  });
  if (gate.blocked) return { blocked: true };
  if (gate.open) {
    const reconciled = await reconcileRefundRequest(gate.open);
    if (reconciled.state === "CREATED" && reconciled.providerRefundId && requestIsOpen(reconciled)) {
      const listed = await getStripeProvider().listRefunds(reconciled.paymentIntentId);
      const match = listed.find((refund) => refund.refundId === reconciled.providerRefundId);
      if (match) return match;
    }
    if (requestIsOpen(reconciled)) return { inFlight: true };
  }

  const stripe = getStripeProvider();
  const [pi, listed] = await Promise.all([
    stripe.retrievePaymentIntent(paymentIntentId),
    stripe.listRefunds(paymentIntentId),
  ]);
  const captured = pi.amountReceived;
  const stillOpen = await findOpenRefundRequest(storeId, orderId);
  if (stillOpen) return { inFlight: true };
  const failed = await uncoveredFailure(listed, captured);
  if (failed) return failed;
  const succeeded = countedCents(listed, ["succeeded"]);
  const pending = countedCents(listed, ["pending", "requires_action"]);
  const remaining = Math.max(0, captured - succeeded - pending);
  if (remaining === 0) {
    const pendingRefund = listed.find((refund) => refund.status === "pending" || refund.status === "requires_action");
    if (pendingRefund) return pendingRefund;
    const succeededRows = listed.filter((refund) => refund.status === "succeeded");
    if (succeededRows.length > 0) {
      return { ...succeededRows[0], amountRefunded: succeeded };
    }
    throw new Error("Captured amount is marked refunded but no refund covers it");
  }

  const created = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    if (manual || !current || current.status !== "CANCELLING") return { blocked: true as const, open: null, row: null };
    const again = await openRefundRequest(tx, orderId);
    if (again) return { open: again, row: null };
    const count = await tx.refundRequest.count({ where: { orderId } });
    const key = `refund:${orderId}:${count + 1}`;
    const row = await tx.refundRequest.create({
      data: {
        storeId,
        orderId,
        paymentIntentId,
        key,
        amountCents: remaining,
        refundApplicationFee: true,
        state: "RESERVED",
      },
    });
    return { open: null, row };
  });
  if ("blocked" in created && created.blocked) return { blocked: true };
  if (created.open) return { inFlight: true };
  const row = created.row!;
  callsInFlight.add(row.key);
  try {
    const refund = await stripe.refundPayment(paymentIntentId, row.amountCents, row.key, {
      refundApplicationFee: true,
      reservationKey: row.key,
      orderId,
    });
    const saved = await classifyRefundRequest(row, { refund });
    if (saved.state === "CREATED") return refund;
    if (requestIsOpen(saved)) return { inFlight: true };
    return refund;
  } catch (err) {
    const saved = await classifyRefundRequest(row, { error: err });
    if (saved.state === "NOT_CREATED" && depth < 1) {
      return submitRefund(storeId, orderId, paymentIntentId, depth + 1);
    }
    if (isRetryableProviderError(err)) throw err;
    if (requestIsOpen(saved)) return { inFlight: true };
    throw err;
  } finally {
    callsInFlight.delete(row.key);
  }
}

function succeededCents(listed: RefundResult[]): number {
  return countedCents(listed, ["succeeded"]);
}

function pendingCents(listed: RefundResult[]): number {
  return countedCents(listed, ["pending", "requires_action"]);
}

function baselineBody(after: Prisma.JsonValue): { refundedCents: number; countedRefundIds: string[]; raw: Record<string, unknown> } {
  const raw = after && typeof after === "object" && !Array.isArray(after) ? { ...(after as Record<string, unknown>) } : {};
  const countedRefundIds = Array.isArray(raw.countedRefundIds)
    ? raw.countedRefundIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    refundedCents: typeof raw.refundedCents === "number" ? raw.refundedCents : 0,
    countedRefundIds,
    raw,
  };
}

/**
 * The only place that changes an order's refund status or writes a post-resolution alert.
 * It compares the provider balance with the ledger under the store lock.
 */
export async function evaluateOrderRefundState(orderId: string): Promise<void> {
  const located = await platformAdminTransaction((tx) => tx.order.findUnique({ where: { id: orderId } }));
  if (!located?.paymentIntentId) return;
  await storeScopedTransaction(located.storeId, async (tx) => {
    await lockStoreRow(tx, located.storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order?.paymentIntentId) return;
    let listed: RefundResult[] = [];
    let captured = order.capturedAmountCents ?? 0;
    try {
      const stripe = getStripeProvider();
      const refunds = stripe.listRefunds(order.paymentIntentId);
      const pi = order.capturedAmountCents == null ? stripe.retrievePaymentIntent(order.paymentIntentId) : null;
      listed = await refunds;
      if (pi) captured = (await pi).amountReceived;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "resource_missing") {
        listed = [];
        captured = order.capturedAmountCents ?? 0;
      } else {
        throw err;
      }
    }
    const open = await openRefundRequest(tx, orderId);
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const succeeded = listed.filter((refund) => refund.status === "succeeded");
    const settled = succeededCents(listed);
    const pending = pendingCents(listed);
    if (manual) {
      // Store audit policies allow insert and select. The moving baseline is a new row.
      const baselineRow = await tx.auditLog.findFirst({
        where: { entityId: orderId, action: "refund_resolution_baseline" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const baseline = baselineBody(baselineRow?.after ?? manual.after);
      const ids = succeeded.map((refund) => refund.refundId);
      if (settled > baseline.refundedCents) {
        const refundId = ids.find((id) => !baseline.countedRefundIds.includes(id)) ?? ids.at(-1) ?? "";
        await tx.auditLog.create({
          data: systemAudit(order.storeId, orderId, "refund_after_manual_resolution", {
            refundId,
            overpaidCents: settled - baseline.refundedCents,
            alert: "store_and_platform",
          }),
        });
        console.error(`Refund ${refundId} succeeded after order ${orderId} was resolved. Store and platform alerted.`);
      } else if (settled < baseline.refundedCents) {
        const refundId = baseline.countedRefundIds.find((id) => !ids.includes(id))
          ?? listed.find((refund) => refund.status === "failed" || refund.status === "canceled")?.refundId
          ?? "";
        await tx.auditLog.create({
          data: systemAudit(order.storeId, orderId, "refund_reversed_after_resolution", {
            refundId,
            underpaidCents: baseline.refundedCents - settled,
            alert: "store_and_platform",
          }),
        });
        console.error(`Refund ${refundId} failed after order ${orderId} was resolved. Store and platform alerted.`);
      }
      const sameIds = ids.length === baseline.countedRefundIds.length && ids.every((id) => baseline.countedRefundIds.includes(id));
      if (settled !== baseline.refundedCents || !sameIds) {
        await tx.auditLog.create({
          data: systemAudit(order.storeId, orderId, "refund_resolution_baseline", {
            refundedCents: settled,
            countedRefundIds: ids,
          }),
        });
      }
      return;
    }
    if (open) return;
    // A Cancelling order is settled by the cancellation flow. Cancelling here would
    // skip that flow when a covered failure is observed. Refund failed is the stuck state.
    if (captured > 0 && settled === captured && pending === 0 && order.status === "REFUND_FAILED") {
      const refundId = succeeded[0]?.refundId ?? order.refundId;
      const existing = await tx.auditLog.findFirst({ where: { entityId: orderId, action: "anomaly_refund" } });
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          cancelledAt: order.cancelledAt ?? new Date(),
          capturedAmountCents: null,
          ...(refundId ? { refundId } : {}),
        },
      });
      if (!existing) {
        await tx.auditLog.create({
          data: systemAudit(order.storeId, orderId, "anomaly_refund", {
            refundId,
            amountRefunded: settled,
          }),
        });
      }
      return;
    }
    const failed = listed.find((refund) => refund.status === "failed" || refund.status === "canceled");
    if (failed && settled + pending < captured && (order.status === "CANCELLING" || order.status === "CANCELLED")) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "REFUND_FAILED",
          refundId: failed.refundId,
          ...(order.capturedAmountCents == null ? { capturedAmountCents: captured } : {}),
        },
      });
      const existing = await tx.auditLog.findFirst({ where: { entityId: orderId, action: "refund_failed" } });
      if (!existing) {
        await tx.auditLog.create({
          data: systemAudit(order.storeId, orderId, "refund_failed", {
            refundId: failed.refundId,
            refundStatus: failed.status,
            alert: "store_and_platform",
          }),
        });
      }
    }
  }, { timeout: 20_000 });
}

/** Match a provider refund to its request. The evaluator decides the order. */
export async function applyProviderRefund(refund: RefundResult & { paymentIntentId: string }): Promise<void> {
  const order = await findOrderByPaymentIntent(refund.paymentIntentId);
  if (!order) return;
  await storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const request = refund.reservationKey
      ? await tx.refundRequest.findUnique({ where: { key: refund.reservationKey } })
      : await tx.refundRequest.findFirst({ where: { providerRefundId: refund.refundId, orderId: order.id } });
    if (!request) return;
    await tx.refundRequest.update({
      where: { id: request.id },
      data: {
        state: "CREATED",
        providerRefundId: refund.refundId,
        providerStatus: refund.status,
        lastCheckedAt: new Date(),
      },
    });
  });
  await evaluateOrderRefundState(order.id);
}
