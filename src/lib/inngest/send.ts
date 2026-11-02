import { inngest } from "./client";

export async function sendOrderAuthorized(storeId: string, orderId: string): Promise<void> {
  try {
    await inngest.send({
      name: "order/authorized",
      data: { storeId, orderId },
    });
  } catch (err) {
    console.warn("[inngest] Failed to send order/authorized event, skipping:", err instanceof Error ? err.message : err);
  }
}
