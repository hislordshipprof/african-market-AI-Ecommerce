import { inngest } from "./client";
import { storeScopedTransaction, lockStoreRow, findOrphanedAuthorizedOrders, findStuckTransitionalOrders, findPendingOrderNotifications, expireStaleOrderNotifications, findPickTimeoutCandidates, findOrphanHoldCarts } from "../db";
import { platform } from "../db";
import { autoCancelOrder, cancelOrder, reconcileStuckOrder } from "../order/service";
import { releaseOrphanHolds } from "../checkout/service";
import { isValidTimezone, openMinutesDeadline } from "../order/store-hours";
import { sendOrderAuthorized } from "./send";
import { sendOrderNotification } from "./notify";
import { deliverOrderNotification, onNotificationFailure } from "../notifications/deliver";
import { isOrderNotifyEvent } from "../notifications/record";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";
import { runAssistantRetention } from "../assistant/retention";
import { recomputeConfidenceBatch, type ConfidenceBatchResult } from "../listing/confidence-job";
import { sendNewOrderPush } from "../push/new-order";
import { slotStart } from "../admin/orders-to-check-query";
import { supportSlaEscalation } from "../support/escalation";
import { copilotOrderStockAlerts } from "../copilot/alert-functions";

const RECONCILE_FAILED_COOLDOWN_MS = 3600_000;

function orderAuditWhere(entityId: string, action: string) {
  return { entityId, action, entityType: "order" as const };
}

export async function recordReconcileResult(storeId: string, orderId: string): Promise<void> {
  let failReason: string | undefined;
  try {
    const result = await reconcileStuckOrder(storeId, orderId);
    if (!result.ok && !result.waiting) {
      failReason = result.error;
    } else if (result.ok && result.action === "unknown_stripe_status") {
      failReason = "unknown_stripe_status";
    }
  } catch (err) {
    failReason = err instanceof Error ? err.message : String(err);
    console.error(`reconcileStuckOrder failed for order ${orderId}:`, err);
  }
  if (failReason) {
    const recent = await storeScopedTransaction(storeId, async (tx) => {
      return tx.auditLog.findFirst({
        where: {
          ...orderAuditWhere(orderId, "reconcile_failed"),
          createdAt: { gte: new Date(Date.now() - RECONCILE_FAILED_COOLDOWN_MS) },
        },
      });
    });
    if (!recent) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.auditLog.create({
          data: {
            storeId,
            actorId: SYSTEM_ACTOR_ID,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: "reconcile_failed",
            entityType: "order",
            entityId: orderId,
            after: { error: failReason },
          },
        });
      });
    }
  }
  try {
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { updatedAt: new Date() },
      });
    });
  } catch { /* best effort — order may have been resolved */ }
}

const ALERT_OPEN_MINUTES = 15;
const CANCEL_OPEN_MINUTES = 30;
/** Inside the 7-day card hold and Inngest's 7-day Free-plan run limit. Normal queued orders cancel by 6 d 30 min. */
const HOLD_SAFETY_CAP_MS = (6 * 24 + 12) * 60 * 60_000;
/** Re-sleeps after the first sleep when edited hours push the deadline later. Then the cap applies. */
const MAX_RESLEEPS = 10;

/** JSON-safe: Inngest serializes step.run results, so no Date crosses a step. */
type TimerPlan =
  | { kind: "done" }
  | { kind: "act" }
  | { kind: "sleep"; deadlineIso: string; zoneFallbackLogged: boolean };

interface TimerSpec {
  name: "alert" | "cancel";
  openMinutes: number;
  statuses: readonly string[];
}

const ALERT_TIMER: TimerSpec = { name: "alert", openMinutes: ALERT_OPEN_MINUTES, statuses: ["AUTHORIZED"] };
export const CANCEL_TIMER: TimerSpec = { name: "cancel", openMinutes: CANCEL_OPEN_MINUTES, statuses: ["AUTHORIZED", "CANCELLING"] };

/**
 * The timer's deadline from the order row and the store's current hours:
 * `openMinutes` open minutes after the acceptance clock (created_at for orders
 * placed before #167), never later than created_at + HOLD_SAFETY_CAP_MS.
 * An invalid zone falls back to wall-clock minutes from the clock.
 */
export function timerDeadline(
  order: { createdAt: Date; acceptanceClockStartsAt: Date | null },
  store: { hours: unknown; timezone: string } | null,
  spec: TimerSpec,
): { deadline: number; zoneInvalid: boolean } {
  const clockStart = order.acceptanceClockStartsAt ?? order.createdAt;
  const cap = order.createdAt.getTime() + HOLD_SAFETY_CAP_MS;
  if (!store || !isValidTimezone(store.timezone)) {
    return { deadline: Math.min(clockStart.getTime() + spec.openMinutes * 60_000, cap), zoneInvalid: true };
  }
  const open = openMinutesDeadline(store.hours, store.timezone, clockStart, spec.openMinutes)?.getTime() ?? cap;
  return { deadline: Math.min(open, cap), zoneInvalid: false };
}

async function planTimer(
  storeId: string,
  orderId: string,
  spec: TimerSpec,
  previousIso: string | null,
  iteration: number,
  zoneFallbackLogged: boolean,
): Promise<TimerPlan> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, createdAt: true, acceptanceClockStartsAt: true },
    });
  });
  if (!order || !spec.statuses.includes(order.status)) return { kind: "done" };

  const store = await platform.store.findUnique({
    where: { id: storeId },
    select: { hours: true, timezone: true },
  });
  const planned = timerDeadline(order, store, spec);
  let deadline = planned.deadline;
  // Once per timer run, whichever plan first finds the zone invalid.
  if (planned.zoneInvalid && !zoneFallbackLogged) {
    console.error(JSON.stringify({ event: "acceptance_timer_invalid_timezone", timer: spec.name, storeId, orderId }));
  }
  const previous = previousIso ? new Date(previousIso).getTime() : null;
  if (iteration > MAX_RESLEEPS && previous !== null && deadline > previous) {
    console.error(JSON.stringify({ event: "acceptance_timer_resleep_limit", timer: spec.name, storeId, orderId }));
    deadline = order.createdAt.getTime() + HOLD_SAFETY_CAP_MS;
  }
  // Woke at the deadline it slept to, or hours now give an earlier one: act.
  if (previous !== null && deadline <= previous) return { kind: "act" };
  if (deadline <= Date.now()) return { kind: "act" };
  return {
    kind: "sleep",
    deadlineIso: new Date(deadline).toISOString(),
    zoneFallbackLogged: zoneFallbackLogged || planned.zoneInvalid,
  };
}

type TimerStep = {
  run<T>(id: string, fn: () => Promise<T>): Promise<unknown>;
  sleepUntil(id: string, time: Date): Promise<unknown>;
};

/**
 * Sleeps until the order's deadline and resolves true when the timer should act.
 * Each plan is memoized in its own step, so a replay takes the same branch, and
 * sleepUntil never receives a past date.
 */
async function waitForTimer(step: TimerStep, storeId: string, orderId: string, spec: TimerSpec): Promise<boolean> {
  let previousIso: string | null = null;
  let zoneFallbackLogged = false;
  for (let i = 0; i <= MAX_RESLEEPS + 2; i++) {
    const plan = (await step.run(`${spec.name}-plan-${i}`, () =>
      planTimer(storeId, orderId, spec, previousIso, i, zoneFallbackLogged),
    )) as TimerPlan;
    if (plan.kind !== "sleep") return plan.kind === "act";
    await step.sleepUntil(`${spec.name}-sleep-${i}`, new Date(plan.deadlineIso));
    previousIso = plan.deadlineIso;
    zoneFallbackLogged = plan.zoneFallbackLogged;
  }
  // Unreachable: past the re-sleep limit the deadline is the cap, which ends the loop.
  return true;
}

export const acceptanceAlert = inngest.createFunction(
  {
    id: "order/acceptance-alert",
    idempotency: "event.data.orderId",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };
    if (!orderId || !storeId) return;

    if (!(await waitForTimer(step, storeId, orderId, ALERT_TIMER))) return;

    await step.run("alert-record", async () => {
      await storeScopedTransaction(storeId, async (tx) => {
        await lockStoreRow(tx, storeId);
        const current = await tx.order.findUnique({ where: { id: orderId } });
        if (!current || current.status !== "AUTHORIZED") return;

        const existing = await tx.auditLog.findFirst({
          where: orderAuditWhere(orderId, "acceptance_alert"),
        });
        if (existing) return;

        await tx.auditLog.create({
          data: {
            storeId,
            actorId: SYSTEM_ACTOR_ID,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: "acceptance_alert",
            entityType: "order",
            entityId: orderId,
          },
        });
      });
    });
  },
);

export const autoCancel = inngest.createFunction(
  {
    id: "order/auto-cancel",
    idempotency: "event.data.orderId",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };
    if (!orderId || !storeId) return;

    if (!(await waitForTimer(step, storeId, orderId, CANCEL_TIMER))) return;

    await step.run("cancel-void", async () => {
      const order = await storeScopedTransaction(storeId, async (tx) => {
        return tx.order.findUnique({ where: { id: orderId } });
      });

      if (!order || (order.status !== "AUTHORIZED" && order.status !== "CANCELLING")) return;

      await autoCancelOrder(storeId, orderId);
    });
  },
);

/** Web push to store staff. A push failure never touches checkout: this runs on the after-commit event. */
export const newOrderPush = inngest.createFunction(
  {
    id: "order/new-order-push",
    idempotency: "event.data.orderId",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId?: string; storeId?: string };
    if (!orderId || !storeId) return;
    await step.run("send-push", () => sendNewOrderPush(storeId, orderId));
  },
);

const PICK_TIMEOUT_MS = 24 * 60 * 60_000;
const PICK_TIMEOUT_BATCH = 50;
/** Scheduled orders not yet due sort after the rest; read past them so they cannot fill the batch. */
const PICK_TIMEOUT_SCAN = 4 * PICK_TIMEOUT_BATCH;

/**
 * An ACCEPTED/PICKING order is abandoned 24 h after the later of acceptance and
 * its pickup slot start, and never later than created_at + HOLD_SAFETY_CAP_MS.
 */
export function pickTimeoutDeadline(order: { createdAt: Date; acceptedAt: Date; pickupSlot: string | null }): number {
  const acceptedAt = order.acceptedAt.getTime();
  const start = Math.max(acceptedAt, slotStart(order.pickupSlot, acceptedAt) ?? 0);
  return Math.min(start + PICK_TIMEOUT_MS, order.createdAt.getTime() + HOLD_SAFETY_CAP_MS);
}

async function findPickTimeoutOrders(): Promise<Array<{ id: string; storeId: string }>> {
  const now = Date.now();
  const candidates = await findPickTimeoutCandidates({
    acceptedBefore: new Date(now - PICK_TIMEOUT_MS),
    createdBefore: new Date(now - HOLD_SAFETY_CAP_MS),
    limit: PICK_TIMEOUT_SCAN,
  });
  return candidates
    .filter((order) => pickTimeoutDeadline(order) <= now)
    .slice(0, PICK_TIMEOUT_BATCH)
    .map(({ id, storeId }) => ({ id, storeId }));
}

export const sweepOrphanedAuthorized = inngest.createFunction(
  {
    id: "order/sweep-orphaned-authorized",
    singleton: { mode: "skip" },
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const found = await step.run("find-orphaned", async () => {
      await expireStaleOrderNotifications();
      const orders = await findOrphanedAuthorizedOrders();
      const notifications = await findPendingOrderNotifications();
      return { orders, notifications };
    });

    for (const row of found.orders) {
      await step.run(`resend-${row.id}`, async () => {
        await sendOrderAuthorized(row.storeId, row.id);
      });
    }

    if (found.notifications.length > 0) {
      await step.run("resend-notifications", async () => {
        for (const row of found.notifications) {
          if (!isOrderNotifyEvent(row.event)) continue;
          await sendOrderNotification(row.storeId, row.orderId, row.event);
        }
      });
    }

    // Each new finder has its own step, so its failure cannot stop the resends above.
    const pickTimeouts = await step.run("find-pick-timeouts", () => findPickTimeoutOrders());
    for (const row of pickTimeouts) {
      // A failed order logs and waits for the next run, so it cannot block the rest of the batch.
      await step.run(`pick-timeout-${row.id}`, async () => {
        let error: string | undefined;
        try {
          const result = await cancelOrder(row.storeId, row.id, { action: "pick_timeout" });
          if (!result.ok) error = result.error;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (error) console.error(JSON.stringify({ event: "pick_timeout_failed", orderId: row.id, error }));
      });
    }

    await step.run("release-orphan-holds", async () => releaseOrphanHolds(await findOrphanHoldCarts()));
  },
);

export const sendCustomerNotification = inngest.createFunction(
  {
    id: "order/send-notification",
    triggers: [{ event: "order/notification.requested" }],
    onFailure: async ({ event }) => {
      await onNotificationFailure(event);
    },
  },
  async ({ event, step }) => {
    const data = event.data as { storeId?: string; orderId?: string; event?: string };
    await deliverOrderNotification(data, step);
  },
);

export const reconcileStuckTransitional = inngest.createFunction(
  {
    id: "order/reconcile-stuck-transitional",
    singleton: { mode: "skip" },
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const stuck = await step.run("find-stuck", async () => {
      return findStuckTransitionalOrders();
    });

    for (const row of stuck) {
      await step.run(`reconcile-${row.id}`, async () => {
        await recordReconcileResult(row.storeId, row.id);
      });
    }
  },
);

export const assistantRetention = inngest.createFunction(
  {
    id: "assistant/retention",
    triggers: [{ cron: "TZ=UTC 17 3 * * *" }],
  },
  async ({ step }) =>
    runAssistantRetention({
      run: (id, fn) => step.run(id, fn) as Promise<Awaited<ReturnType<typeof fn>>>,
    }),
);

export const dailyConfidence = inngest.createFunction(
  {
    id: "listing/daily-confidence",
    singleton: { mode: "skip" },
    // A cap for one handler invocation, under Vercel's 300 seconds. The batch's own time budget bounds one step.
    checkpointing: { maxRuntime: "240s" },
    triggers: [{ cron: "TZ=UTC 23 9 * * *" }],
  },
  async ({ step }) => {
    let cursor: string | null = null;
    let batch = 0;
    while (true) {
      const previous: string | null = cursor;
      const page: ConfidenceBatchResult = await step.run(`recompute-confidence-${batch}`, () =>
        recomputeConfidenceBatch(previous),
      );
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
      batch += 1;
    }
  },
);

export const inngestFunctions = [
  acceptanceAlert,
  autoCancel,
  newOrderPush,
  sweepOrphanedAuthorized,
  reconcileStuckTransitional,
  assistantRetention,
  dailyConfidence,
  sendCustomerNotification,
  supportSlaEscalation,
  copilotOrderStockAlerts,
];
