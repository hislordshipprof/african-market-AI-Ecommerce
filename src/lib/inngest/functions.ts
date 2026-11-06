import { inngest } from "./client";
import { storeScopedTransaction, lockStoreRow, findOrphanedAuthorizedOrders, findStuckTransitionalOrders } from "../db";
import { platform } from "../db";
import { autoCancelOrder, reconcileStuckOrder } from "../order/service";
import { isStoreOpen } from "../order/store-hours";
import { sendOrderAuthorized } from "./send";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";
import { runAssistantRetention } from "../assistant/retention";

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

function remainingSleep(authorizedAt: string | undefined, totalMs: number): string {
  if (!authorizedAt) return `${totalMs / 1000}s`;
  const elapsed = Date.now() - new Date(authorizedAt).getTime();
  const remaining = Math.max(0, totalMs - elapsed);
  return `${Math.ceil(remaining / 1000)}s`;
}

export const acceptanceAlert = inngest.createFunction(
  {
    id: "order/acceptance-alert",
    idempotency: "event.data.orderId",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, authorizedAt } = event.data as { orderId: string; storeId: string; authorizedAt?: string };
    if (!orderId || !storeId) return;

    const sleepDuration = remainingSleep(authorizedAt, 15 * 60 * 1000);
    if (sleepDuration !== "0s") {
      await step.sleep("wait-15-min", sleepDuration);
    }

    await step.run("check-and-alert", async () => {
      const order = await storeScopedTransaction(storeId, async (tx) => {
        return tx.order.findUnique({ where: { id: orderId } });
      });

      if (!order || order.status !== "AUTHORIZED") return;

      const store = await platform.store.findUnique({
        where: { id: storeId },
        select: { hours: true, timezone: true },
      });

      if (!isStoreOpen(store?.hours, store?.timezone ?? "America/New_York")) return;

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
    const { orderId, storeId, authorizedAt } = event.data as { orderId: string; storeId: string; authorizedAt?: string };
    if (!orderId || !storeId) return;

    const sleepDuration = remainingSleep(authorizedAt, 30 * 60 * 1000);
    if (sleepDuration !== "0s") {
      await step.sleep("wait-30-min", sleepDuration);
    }

    await step.run("cancel-if-still-authorized", async () => {
      const order = await storeScopedTransaction(storeId, async (tx) => {
        return tx.order.findUnique({ where: { id: orderId } });
      });

      if (!order || (order.status !== "AUTHORIZED" && order.status !== "CANCELLING")) return;

      await autoCancelOrder(storeId, orderId);
    });
  },
);

export const sweepOrphanedAuthorized = inngest.createFunction(
  {
    id: "order/sweep-orphaned-authorized",
    singleton: { mode: "skip" },
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const orphaned = await step.run("find-orphaned", async () => {
      return findOrphanedAuthorizedOrders();
    });

    for (const row of orphaned) {
      await step.run(`resend-${row.id}`, async () => {
        await sendOrderAuthorized(row.storeId, row.id);
      });
    }
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

export const inngestFunctions = [
  acceptanceAlert,
  autoCancel,
  sweepOrphanedAuthorized,
  reconcileStuckTransitional,
  assistantRetention,
];
