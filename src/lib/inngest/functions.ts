import { inngest } from "./client";
import { storeScopedTransaction, lockStoreRow, platformAdminTransaction } from "../db";
import { platform } from "../db";
import { autoCancelOrder } from "../order/service";
import { isStoreOpen } from "../order/store-hours";
import { sendOrderAuthorized } from "./send";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";

export const acceptanceAlert = inngest.createFunction(
  {
    id: "order/acceptance-alert",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };

    await step.sleep("wait-15-min", "15m");

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
        const existing = await tx.auditLog.findFirst({
          where: { entityId: orderId, action: "acceptance_alert" },
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
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };

    await step.sleep("wait-30-min", "30m");

    await step.run("cancel-if-still-authorized", async () => {
      const order = await storeScopedTransaction(storeId, async (tx) => {
        return tx.order.findUnique({ where: { id: orderId } });
      });

      if (!order || order.status !== "AUTHORIZED") return;

      await autoCancelOrder(storeId, orderId);
    });
  },
);

export const sweepOrphanedAuthorized = inngest.createFunction(
  {
    id: "order/sweep-orphaned-authorized",
    triggers: [{ cron: "*/2 * * * *" }],
  },
  async ({ step }) => {
    const orphaned = await step.run("find-orphaned", async () => {
      return platformAdminTransaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
          SELECT id, store_id FROM orders
          WHERE status = 'AUTHORIZED'
            AND inngest_event_sent_at IS NULL
            AND created_at < NOW() - INTERVAL '1 minute'
          LIMIT 50
        `;
        return rows;
      });
    });

    for (const row of orphaned) {
      await step.run(`resend-${row.id}`, async () => {
        await sendOrderAuthorized(row.store_id, row.id);
      });
    }
  },
);

export const inngestFunctions = [acceptanceAlert, autoCancel, sweepOrphanedAuthorized];
