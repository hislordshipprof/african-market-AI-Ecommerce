import { findOrderAlertRows, findOrderRecoveryCandidates, type OrderRecoveryCandidate, type OrderRecoveryGroup } from "../db";
import { CANCEL_TIMER, timerDeadline } from "../inngest/functions";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Orphan sweep runs every 15 min (functions.ts). */
const TIMER_NOT_STARTED_MS = 15 * MIN;
/** Grace after the cancel timer's deadline before the order counts as missed. */
const TIMER_OVERDUE_MS = 30 * MIN;
/** Reconcile picks after 5 min and runs every 15 min. */
const RETRY_STALLED_MS = 30 * MIN;
const PICKING_GRACE_MINUTES = 60;
/** The card hold lasts 7 days (store-queue.ts). */
const HOLD_EXPIRING_MS = 5 * DAY;
const READY_MS = 4 * HOUR;
const OUT_FOR_DELIVERY_MS = 4 * HOUR;
const AWAITING_PICKUP_MS = 48 * HOUR;
const ALERT_WINDOW_MS = 7 * DAY;
export const ROW_LIMIT = 200;

const UNCAPTURED = ["AUTHORIZED", "ACCEPTED", "PICKING", "CAPTURING", "CANCELLING"];
const FINAL = ["DELIVERED", "COMPLETED", "CANCELLED"];
export const ALERT_ACTIONS = ["acceptance_alert", "reconcile_failed", "capture_released", "refund_request_unknown"] as const;

export type StuckReason =
  | "card hold expiring"
  | "timer not started"
  | "timer overdue"
  | "retry stalled"
  | "picking overdue"
  | "ready too long"
  | "waiting for pickup too long"
  | "out for delivery too long";

export type StuckOrderRow = {
  orderId: string;
  storeName: string;
  orderNumber: number;
  status: string;
  reason: StuckReason;
  /** When the clock behind the reason started. */
  since: Date;
};

export type OrderAlertRow = {
  orderId: string;
  storeName: string;
  orderNumber: number;
  orderStatus: string;
  action: (typeof ALERT_ACTIONS)[number];
  createdAt: Date;
};

function slotStart(slot: string | null): number | null {
  if (!slot) return null;
  const at = Date.parse(slot);
  return Number.isNaN(at) ? null : at;
}

function stuckReason(order: OrderRecoveryCandidate, now: number): { reason: StuckReason; since: Date } | null {
  if (UNCAPTURED.includes(order.status) && order.createdAt.getTime() < now - HOLD_EXPIRING_MS) {
    return { reason: "card hold expiring", since: order.createdAt };
  }
  switch (order.status) {
    case "AUTHORIZED": {
      if (!order.inngestEventSentAt && order.createdAt.getTime() < now - TIMER_NOT_STARTED_MS) {
        return { reason: "timer not started", since: order.createdAt };
      }
      const { deadline } = timerDeadline(
        { createdAt: order.createdAt, acceptanceClockStartsAt: order.acceptanceClockStartsAt },
        { hours: order.hours, timezone: order.timezone },
        CANCEL_TIMER,
      );
      return deadline + TIMER_OVERDUE_MS < now ? { reason: "timer overdue", since: new Date(deadline) } : null;
    }
    case "CAPTURING":
    case "CANCELLING": {
      const since = order.firstRetryAt ?? order.updatedAt;
      return since.getTime() < now - RETRY_STALLED_MS ? { reason: "retry stalled", since } : null;
    }
    case "ACCEPTED":
    case "PICKING": {
      if (!order.acceptedAt) return null;
      const start = Math.max(order.acceptedAt.getTime(), slotStart(order.pickupSlot) ?? 0);
      const due = start + ((order.prepEstimateMinutes ?? 0) + PICKING_GRACE_MINUTES) * MIN;
      return due < now ? { reason: "picking overdue", since: new Date(start) } : null;
    }
    case "READY":
      return order.readyAt && order.readyAt.getTime() < now - READY_MS ? { reason: "ready too long", since: order.readyAt } : null;
    case "AWAITING_PICKUP":
      return order.readyAt && order.readyAt.getTime() < now - AWAITING_PICKUP_MS
        ? { reason: "waiting for pickup too long", since: order.readyAt }
        : null;
    case "OUT_FOR_DELIVERY":
      return order.outForDeliveryAt && order.outForDeliveryAt.getTime() < now - OUT_FOR_DELIVERY_MS
        ? { reason: "out for delivery too long", since: order.outForDeliveryAt }
        : null;
    default:
      return null;
  }
}

/**
 * Stuck orders and unread alert rows, read straight from the database: a broken Inngest is one of
 * the things this shows. `storeIds` narrows the read for tests.
 */
export async function findOrdersToCheck(opts?: {
  now?: Date;
  storeIds?: readonly string[];
}): Promise<{ checkedAt: Date; stuck: StuckOrderRow[]; cappedGroups: OrderRecoveryGroup[]; alerts: OrderAlertRow[] }> {
  const checkedAt = opts?.now ?? new Date();
  const now = checkedAt.getTime();
  const at = (ms: number) => new Date(now - ms);
  const [{ candidates, capped }, alertRows] = await Promise.all([
    findOrderRecoveryCandidates({
      authorizedBefore: at(TIMER_NOT_STARTED_MS),
      holdBefore: at(HOLD_EXPIRING_MS),
      retryBefore: at(RETRY_STALLED_MS),
      pickingDueBy: checkedAt,
      pickingGraceMinutes: PICKING_GRACE_MINUTES,
      readyBefore: at(READY_MS),
      awaitingPickupBefore: at(AWAITING_PICKUP_MS),
      outForDeliveryBefore: at(OUT_FOR_DELIVERY_MS),
      limit: ROW_LIMIT,
      storeIds: opts?.storeIds,
    }),
    findOrderAlertRows({
      actions: ALERT_ACTIONS,
      since: at(ALERT_WINDOW_MS),
      finalStatuses: FINAL,
      limit: ROW_LIMIT,
      storeIds: opts?.storeIds,
    }),
  ]);

  const stuck: StuckOrderRow[] = [];
  for (const order of candidates) {
    const found = stuckReason(order, now);
    if (!found) continue;
    stuck.push({ orderId: order.id, storeName: order.storeName, orderNumber: order.number, status: order.status, ...found });
  }
  stuck.sort((a, b) => a.since.getTime() - b.since.getTime());

  return {
    checkedAt,
    stuck,
    cappedGroups: (Object.keys(capped) as OrderRecoveryGroup[]).filter((group) => capped[group]),
    alerts: alertRows.map((row) => ({ ...row, action: row.action as OrderAlertRow["action"] })),
  };
}
