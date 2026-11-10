import { Prisma, platformAdminTransaction } from "../db";
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
const ROW_LIMIT = 200;

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

type Candidate = {
  id: string;
  store_name: string;
  number: number;
  status: string;
  created_at: Date;
  updated_at: Date;
  acceptance_clock_starts_at: Date | null;
  inngest_event_sent_at: Date | null;
  accepted_at: Date | null;
  prep_estimate_minutes: number | null;
  pickup_slot: string | null;
  ready_at: Date | null;
  out_for_delivery_at: Date | null;
  first_retry_at: Date | null;
  hours: unknown;
  timezone: string;
};

function slotStart(slot: string | null): number | null {
  if (!slot) return null;
  const at = Date.parse(slot);
  return Number.isNaN(at) ? null : at;
}

function stuckReason(order: Candidate, now: number): { reason: StuckReason; since: Date } | null {
  if (UNCAPTURED.includes(order.status) && order.created_at.getTime() < now - HOLD_EXPIRING_MS) {
    return { reason: "card hold expiring", since: order.created_at };
  }
  switch (order.status) {
    case "AUTHORIZED": {
      if (!order.inngest_event_sent_at && order.created_at.getTime() < now - TIMER_NOT_STARTED_MS) {
        return { reason: "timer not started", since: order.created_at };
      }
      const { deadline } = timerDeadline(
        { createdAt: order.created_at, acceptanceClockStartsAt: order.acceptance_clock_starts_at },
        { hours: order.hours, timezone: order.timezone },
        CANCEL_TIMER,
      );
      return deadline + TIMER_OVERDUE_MS < now ? { reason: "timer overdue", since: new Date(deadline) } : null;
    }
    case "CAPTURING":
    case "CANCELLING": {
      const since = order.first_retry_at ?? order.updated_at;
      return since.getTime() < now - RETRY_STALLED_MS ? { reason: "retry stalled", since } : null;
    }
    case "ACCEPTED":
    case "PICKING": {
      if (!order.accepted_at) return null;
      const start = Math.max(order.accepted_at.getTime(), slotStart(order.pickup_slot) ?? 0);
      const due = start + ((order.prep_estimate_minutes ?? 0) + PICKING_GRACE_MINUTES) * MIN;
      return due < now ? { reason: "picking overdue", since: new Date(start) } : null;
    }
    case "READY":
      return order.ready_at && order.ready_at.getTime() < now - READY_MS ? { reason: "ready too long", since: order.ready_at } : null;
    case "AWAITING_PICKUP":
      return order.ready_at && order.ready_at.getTime() < now - AWAITING_PICKUP_MS
        ? { reason: "waiting for pickup too long", since: order.ready_at }
        : null;
    case "OUT_FOR_DELIVERY":
      return order.out_for_delivery_at && order.out_for_delivery_at.getTime() < now - OUT_FOR_DELIVERY_MS
        ? { reason: "out for delivery too long", since: order.out_for_delivery_at }
        : null;
    default:
      return null;
  }
}

/**
 * Stuck orders and unread alert rows, read straight from the database: a broken Inngest is one of
 * the things this shows. SQL bounds each candidate set; the per-state limits are applied here.
 * `storeIds` narrows the read for tests.
 */
export async function findOrdersToCheck(opts?: {
  now?: Date;
  storeIds?: readonly string[];
}): Promise<{ stuck: StuckOrderRow[]; alerts: OrderAlertRow[] }> {
  const now = (opts?.now ?? new Date()).getTime();
  const at = (ms: number) => new Date(now - ms);
  const inStores = (column: Prisma.Sql) =>
    opts?.storeIds ? Prisma.sql`AND ${column} IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  if (opts?.storeIds && opts.storeIds.length === 0) return { stuck: [], alerts: [] };

  const columns = Prisma.sql`
    o.id, s.name AS store_name, o.number, o.status, o.created_at, o.updated_at,
    o.acceptance_clock_starts_at, o.inngest_event_sent_at, o.accepted_at, o.prep_estimate_minutes,
    o.pickup_slot, o.ready_at, o.out_for_delivery_at, s.hours, s.timezone,
    CASE WHEN o.status IN ('CAPTURING', 'CANCELLING') THEN (
      SELECT MIN(a.created_at) FROM audit_logs a
      WHERE a.entity_type = 'order' AND a.entity_id = o.id
        AND a.action = CASE o.status WHEN 'CAPTURING' THEN 'capture_retry' ELSE 'cancel_retry' END
    ) END AS first_retry_at`;

  const { authorized, others, alerts } = await platformAdminTransaction(async (tx) => {
    // The open-minutes deadline is computed per row, so this set is capped on its own.
    const authorized = await tx.$queryRaw<Candidate[]>`
      SELECT ${columns}
      FROM orders o JOIN stores s ON s.id = o.store_id
      WHERE o.status = 'AUTHORIZED' AND o.created_at < ${at(TIMER_NOT_STARTED_MS)} ${inStores(Prisma.sql`o.store_id`)}
      ORDER BY o.created_at ASC
      LIMIT ${ROW_LIMIT}
    `;
    const others = await tx.$queryRaw<Candidate[]>`
      SELECT * FROM (
        SELECT ${columns}
        FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE o.status IN ('ACCEPTED', 'PICKING', 'CAPTURING', 'CANCELLING', 'READY', 'AWAITING_PICKUP', 'OUT_FOR_DELIVERY')
          ${inStores(Prisma.sql`o.store_id`)}
          AND (
            o.created_at < ${at(HOLD_EXPIRING_MS)}
            OR (o.status IN ('ACCEPTED', 'PICKING')
              AND o.accepted_at + make_interval(mins => COALESCE(o.prep_estimate_minutes, 0) + ${PICKING_GRACE_MINUTES}) < ${at(0)})
            OR o.status IN ('CAPTURING', 'CANCELLING')
            OR (o.status = 'READY' AND o.ready_at < ${at(READY_MS)})
            OR (o.status = 'AWAITING_PICKUP' AND o.ready_at < ${at(AWAITING_PICKUP_MS)})
            OR (o.status = 'OUT_FOR_DELIVERY' AND o.out_for_delivery_at < ${at(OUT_FOR_DELIVERY_MS)})
          )
      ) candidates
      WHERE status NOT IN ('CAPTURING', 'CANCELLING')
        OR COALESCE(first_retry_at, updated_at) < ${at(RETRY_STALLED_MS)}
        OR created_at < ${at(HOLD_EXPIRING_MS)}
      ORDER BY created_at ASC
      LIMIT ${ROW_LIMIT}
    `;
    // Past the window, an alert stays while its order is not final: it may be the only record.
    const alerts = await tx.$queryRaw<Array<{
      entity_id: string;
      action: OrderAlertRow["action"];
      created_at: Date;
      number: number;
      status: string;
      store_name: string;
    }>>`
      SELECT * FROM (
        SELECT DISTINCT ON (a.entity_id, a.action)
          a.entity_id, a.action, a.created_at, o.number, o.status, s.name AS store_name
        FROM audit_logs a
        JOIN orders o ON o.id = a.entity_id AND o.store_id = a.store_id
        JOIN stores s ON s.id = o.store_id
        WHERE a.entity_type = 'order'
          AND a.action IN (${Prisma.join([...ALERT_ACTIONS])})
          AND (a.created_at >= ${at(ALERT_WINDOW_MS)} OR o.status NOT IN (${Prisma.join(FINAL)}))
          ${inStores(Prisma.sql`a.store_id`)}
        ORDER BY a.entity_id, a.action, a.created_at DESC
      ) latest
      ORDER BY created_at DESC
      LIMIT ${ROW_LIMIT}
    `;
    return { authorized, others, alerts };
  });

  const stuck: StuckOrderRow[] = [];
  for (const order of [...authorized, ...others]) {
    const found = stuckReason(order, now);
    if (!found) continue;
    stuck.push({
      orderId: order.id,
      storeName: order.store_name,
      orderNumber: order.number,
      status: order.status,
      ...found,
    });
  }
  stuck.sort((a, b) => a.since.getTime() - b.since.getTime());

  return {
    stuck,
    alerts: alerts.map((row) => ({
      orderId: row.entity_id,
      storeName: row.store_name,
      orderNumber: row.number,
      orderStatus: row.status,
      action: row.action,
      createdAt: row.created_at,
    })),
  };
}
