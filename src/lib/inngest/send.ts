import { inngest } from "./client";
import { storeScopedTransaction } from "../db";

export async function sendOrderAuthorized(storeId: string, orderId: string): Promise<void> {
  try {
    await inngest.send({
      name: "order/authorized",
      data: { storeId, orderId },
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
