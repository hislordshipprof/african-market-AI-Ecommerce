import { inngest } from "./client";
import { storeScopedTransaction, lockStoreRow } from "../db";
import { platform } from "../db";
import { autoCancelOrder } from "../order/service";
import { isStoreOpen } from "../order/store-hours";
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
        select: { hours: true },
      });

      if (!isStoreOpen(store?.hours)) return;

      await storeScopedTransaction(storeId, async (tx) => {
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

export const inngestFunctions = [acceptanceAlert, autoCancel];
