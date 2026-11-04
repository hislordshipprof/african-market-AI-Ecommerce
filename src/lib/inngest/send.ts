import { inngest } from "./client";
import { storeScopedTransaction } from "../db";

export async function sendOrderAuthorized(storeId: string, orderId: string): Promise<void> {
  try {
    const order = await storeScopedTransaction(storeId, async (tx) => {
      return tx.order.findUnique({ where: { id: orderId }, select: { createdAt: true } });
    });
    await inngest.send({
      name: "order/authorized",
      data: { storeId, orderId, authorizedAt: order?.createdAt?.toISOString() ?? new Date().toISOString() },
    });
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { inngestEventSentAt: new Date() },
      });
    });
  } catch (err) {
    console.warn("[inngest] Failed to send order/authorized event, skipping:", err instanceof Error ? err.message : err);
  }
}
