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
import { releaseOrderStock } from "./stock-ledger";
import { recordOrderNotification } from "../notifications/record";
import { scheduleOrderNotification } from "../inngest/notify";

/** Inside Stripe's 24h idempotency window. Coordinator default, pending owner confirmation. */
export const REFUND_REQUEST_ABANDON_MS = 23 * 60 * 60 * 1000;

/** How long a replay stays reserved after the process that started it stops answering. */
export const REPLAY_LEASE_MS = 2 * 60 * 1000;

/** Keys whose refundPayment call has not returned in this process. A sweep must not replay them. */
const callsInFlight = new Set<string>();

/** Another server does not share this process's set. Tests use this to stand in for that server. */
export function clearReplayCallsForTests(): void {
  callsInFlight.clear();
}

const TERMINAL_PROVIDER_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export type RefundRequestRow = RefundRequest;

export function requestIsOpen(row: {
  state: string;
  providerStatus: string | null;
}): boolean {
  if (row.state === "RESERVED" || row.state === "UNKNOWN" || row.state === "REPLAYING") return true;
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
): Promise<boolean> {
  const prior = await tx.auditLog.findMany({ where: { entityId: orderId, action } });
  const duplicate = prior.some((row) => {
    const body = row.after as { refundId?: string; key?: string } | null;
    return body?.refundId === refundId || body?.key === refundId;
  });
  if (duplicate) return false;
  await tx.auditLog.create({ data: systemAudit(storeId, orderId, action, after) });
  return true;
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

function logAbandoned(orderId: string, key: string): void {
  console.error(`Refund request ${key} for order ${orderId} is still unknown. Platform alerted.`);
}

function replayLeaseFresh(row: { state: string; lastCheckedAt: Date }, now = Date.now()): boolean {
  return row.state === "REPLAYING" && now - row.lastCheckedAt.getTime() < REPLAY_LEASE_MS;
}

/**
 * Abandonment decides from the current row, under the store lock.
 * A stale snapshot must not overwrite a live replay or a finished request.
 */
async function abandonIfIdle(
  row: RefundRequestRow,
): Promise<{ row: RefundRequestRow; changed: boolean; alerted: boolean }> {
  return storeScopedTransaction(row.storeId, async (tx) => {
    await lockStoreRow(tx, row.storeId);
    const current = await tx.refundRequest.findUnique({ where: { id: row.id } });
    if (!current) return { row, changed: false, alerted: false };
    if (
      current.state === "CREATED"
      || current.state === "ABANDONED"
      || current.state === "NOT_CREATED"
      || replayLeaseFresh(current)
    ) {
      return { row: current, changed: false, alerted: false };
    }
    const age = Date.now() - current.createdAt.getTime();
    if (age < REFUND_REQUEST_ABANDON_MS) return { row: current, changed: false, alerted: false };
    const updated = await tx.refundRequest.updateMany({
      where: { id: current.id, state: current.state, lastCheckedAt: current.lastCheckedAt },
      data: { state: "ABANDONED", lastCheckedAt: new Date(Date.now()) },
    });
    if (updated.count !== 1) {
      const again = await tx.refundRequest.findUnique({ where: { id: current.id } });
      return { row: again ?? current, changed: false, alerted: false };
    }
    const alerted = await writeAuditOnce(tx, row.storeId, row.orderId, "refund_request_unknown", row.key, {
      key: row.key,
      alert: "platform",
    });
    const abandoned = await tx.refundRequest.findUnique({ where: { id: current.id } });
    return { row: abandoned ?? current, changed: true, alerted };
  });
}

/** One server reserves the replay. Another server sees the reservation and does not send it again. */
async function claimReplay(row: RefundRequestRow): Promise<RefundRequestRow | null> {
  return storeScopedTransaction(row.storeId, async (tx) => {
    await lockStoreRow(tx, row.storeId);
    const current = await tx.refundRequest.findUnique({ where: { id: row.id } });
    if (!current) return null;
    if (current.state === "CREATED" || current.state === "ABANDONED" || current.state === "NOT_CREATED") return null;
    if (replayLeaseFresh(current)) return null;
    return tx.refundRequest.update({
      where: { id: row.id },
      data: { state: "REPLAYING", lastCheckedAt: new Date(Date.now()) },
    });
  });
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
  if (callsInFlight.has(row.key) || replayLeaseFresh(row)) return row;
  const age = Date.now() - row.createdAt.getTime();
  const canReplay = row.state === "RESERVED" || row.state === "UNKNOWN" || row.state === "REPLAYING";
  if (age < REFUND_REQUEST_ABANDON_MS && canReplay) {
    const claimed = await claimReplay(row);
    if (!claimed) {
      const current = await storeScoped(row.storeId).refundRequest.findUnique({ where: { id: row.id } });
      return current ?? row;
    }
    callsInFlight.add(claimed.key);
    try {
      const refund = await stripe.refundPayment(claimed.paymentIntentId, claimed.amountCents, claimed.key, {
        refundApplicationFee: claimed.refundApplicationFee,
        reservationKey: claimed.key,
        orderId: claimed.orderId,
      });
      const saved = await classifyRefundRequest(claimed, { refund });
      await evaluateOrderRefundState(claimed.orderId);
      return saved;
    } catch (err) {
      const saved = await classifyRefundRequest(claimed, { error: err });
      await evaluateOrderRefundState(claimed.orderId);
      return saved;
    } finally {
      callsInFlight.delete(claimed.key);
    }
  }
  if (row.state === "ABANDONED" || row.state === "NOT_CREATED" || row.state === "CREATED") return row;
  const decision = await abandonIfIdle(row);
  if (decision.alerted) logAbandoned(row.orderId, row.key);
  if (!decision.changed) return decision.row;
  await evaluateOrderRefundState(row.orderId);
  return decision.row;
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

/** Captured minus succeeded and pending refunds: the most any new refund can be. */
function unrefundedCents(captured: number, listed: RefundResult[]): number {
  return Math.max(0, captured - countedCents(listed, ["succeeded", "pending", "requires_action"]));
}

/** What is still refundable on a payment, read from Stripe. */
export async function remainingCaptureCents(paymentIntentId: string): Promise<number> {
  const stripe = getStripeProvider();
  const [pi, listed] = await Promise.all([
    stripe.retrievePaymentIntent(paymentIntentId),
    stripe.listRefunds(paymentIntentId),
  ]);
  return unrefundedCents(pi.amountReceived, listed);
}

/** `cancel` refunds the whole remaining capture. `issue` refunds an amount after delivery (#428). */
export type RefundCause =
  | { cause: "cancel" }
  | { cause: "issue"; amountCents: number; issueReportId?: string };

const REFUNDABLE_FROM: Record<RefundCause["cause"], readonly string[]> = {
  cancel: ["CANCELLING"],
  issue: ["DELIVERED", "COMPLETED", "PARTIALLY_REFUNDED"],
};

/** Courier recovery is kept on a courier order (spec §10, owner decision 3). */
function refundsApplicationFee(cause: RefundCause, fulfillment: string): boolean {
  return cause.cause === "cancel" || fulfillment !== "courier";
}

/**
 * One app refund. An open request is reconciled instead of starting another.
 * The stored amount is what gets replayed.
 */
export async function submitRefund(
  storeId: string,
  orderId: string,
  paymentIntentId: string,
  cause: RefundCause = { cause: "cancel" },
  depth = 0,
): Promise<RefundResult | { inFlight: true } | { blocked: true }> {
  const allowed = REFUNDABLE_FROM[cause.cause];
  const gate = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    if (manual || !order || !allowed.includes(order.status)) return { blocked: true as const, open: null };
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
  if (cause.cause === "cancel") {
    const failed = await uncoveredFailure(listed, captured);
    if (failed) return failed;
  }
  const succeeded = countedCents(listed, ["succeeded"]);
  const remaining = unrefundedCents(captured, listed);
  // ADR-0019: an issue refund never exceeds what is still unrefunded.
  const amount = cause.cause === "issue" ? Math.min(cause.amountCents, remaining) : remaining;
  if (cause.cause === "issue" && amount <= 0) return { blocked: true };
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
    if (manual || !current || !allowed.includes(current.status)) return { blocked: true as const, open: null, row: null };
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
        amountCents: amount,
        refundApplicationFee: refundsApplicationFee(cause, current.fulfillment),
        state: "RESERVED",
      },
    });
    if (cause.cause === "issue" && cause.issueReportId) {
      await tx.issueReport.update({ where: { id: cause.issueReportId }, data: { refundRequestId: row.id } });
    }
    return { open: null, row };
  });
  if ("blocked" in created && created.blocked) return { blocked: true };
  if (created.open) return { inFlight: true };
  const row = created.row!;
  callsInFlight.add(row.key);
  try {
    const refund = await stripe.refundPayment(paymentIntentId, row.amountCents, row.key, {
      refundApplicationFee: row.refundApplicationFee,
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
      return submitRefund(storeId, orderId, paymentIntentId, cause, depth + 1);
    }
    if (isRetryableProviderError(err)) throw err;
    if (requestIsOpen(saved)) return { inFlight: true };
    throw err;
  } finally {
    callsInFlight.delete(row.key);
  }
}

/** Statuses after the customer has the goods. Only money moves them (owner decision 4). */
const AFTER_DELIVERY = new Set(["DELIVERED", "COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);

type IssueTx = Pick<Prisma.TransactionClient, "refundRequest" | "auditLog" | "order" | "issueReport">;

/**
 * A failed issue refund marks the issue, not the order: Refund failed resolves to Cancelled,
 * which is wrong for a delivered order. One alert per refund.
 */
async function recordIssueRefundFailure(
  tx: IssueTx,
  storeId: string,
  orderId: string,
  listed: RefundResult[],
): Promise<string | null> {
  const issue = await tx.issueReport.findUnique({ where: { orderId } });
  if (!issue?.refundRequestId) return null;
  const request = await tx.refundRequest.findUnique({ where: { id: issue.refundRequestId } });
  if (!request) return null;
  const failed = listed.find((refund) =>
    (refund.status === "failed" || refund.status === "canceled")
    && (refund.reservationKey === request.key || refund.refundId === request.providerRefundId));
  // Stripe refused the create, so no refund exists and nothing will replay it. Not ABANDONED: that can still become a refund.
  const refused = request.state === "NOT_CREATED";
  if (!failed && !refused) return null;
  if (issue.state !== "refund_failed") {
    await tx.issueReport.update({ where: { id: issue.id }, data: { state: "refund_failed" } });
  }
  const alertKey = failed ? failed.refundId : request.key;
  const wrote = await writeAuditOnce(tx, storeId, orderId, "issue_refund_failed", alertKey, failed
    ? { refundId: failed.refundId, refundStatus: failed.status, issueReportId: issue.id, alert: "store_and_platform" }
    : { key: request.key, refundStatus: "not_created", issueReportId: issue.id, alert: "store_and_platform" });
  return wrote ? alertKey : null;
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
  let notifyCancel = false;
  let notifyRefunded = false;
  let issueFailure: string | null = null;
  const recorded = await storeScopedTransaction(located.storeId, async (tx) => {
    notifyCancel = false;
    notifyRefunded = false;
    issueFailure = null;
    const fresh: string[] = [];
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
      await releaseOrderStock(tx, order.storeId, orderId);
      notifyCancel = await recordOrderNotification(tx, order.storeId, orderId, "cancelled");
      return;
    }
    const failedRefunds = listed.filter((refund) => refund.status === "failed" || refund.status === "canceled");
    const failed = failedRefunds[0];
    if (
      failed
      && settled + pending < captured
      && (order.status === "CANCELLING" || order.status === "CANCELLED" || order.status === "REFUND_FAILED")
    ) {
      const data: Prisma.OrderUpdateInput = {};
      if (order.status !== "REFUND_FAILED") data.status = "REFUND_FAILED";
      if (order.refundId !== failed.refundId) data.refundId = failed.refundId;
      if (order.capturedAmountCents == null) data.capturedAmountCents = captured;
      if (Object.keys(data).length > 0) {
        await tx.order.update({ where: { id: orderId }, data });
      }
      for (const item of failedRefunds) {
        const wrote = await writeAuditOnce(tx, order.storeId, orderId, "refund_failed", item.refundId, {
          refundId: item.refundId,
          refundStatus: item.status,
          alert: "store_and_platform",
        });
        if (wrote) fresh.push(item.refundId);
      }
    }
    if (AFTER_DELIVERY.has(order.status)) {
      issueFailure = await recordIssueRefundFailure(tx, order.storeId, orderId, listed);
      // A refund can fail after it succeeded: with nothing refunded the order is back to fulfilled.
      const refundedState = order.status === "REFUNDED" || order.status === "PARTIALLY_REFUNDED";
      const fulfilled = order.deliveredAt ? "DELIVERED" : "COMPLETED";
      const next = settled === 0 ? (refundedState ? fulfilled : null) : settled >= captured ? "REFUNDED" : "PARTIALLY_REFUNDED";
      if (next && next !== order.status) {
        await tx.order.update({ where: { id: orderId }, data: { status: next } });
        if (next === "REFUNDED" || next === "PARTIALLY_REFUNDED") {
          notifyRefunded = await recordOrderNotification(tx, order.storeId, orderId, "refunded");
        }
      }
    }
    return fresh;
  }, { timeout: 20_000 });
  if (notifyCancel) scheduleOrderNotification(located.storeId, orderId, "cancelled");
  if (notifyRefunded) scheduleOrderNotification(located.storeId, orderId, "refunded");
  if (issueFailure) {
    console.error(`Issue refund ${issueFailure} failed for order ${orderId}. Customer is not refunded. Store and platform alerted.`);
  }
  for (const refundId of recorded ?? []) {
    console.error(
      `Refund failed for order ${orderId} (${refundId}). Customer is still charged. Store and platform alerted.`,
    );
  }
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
