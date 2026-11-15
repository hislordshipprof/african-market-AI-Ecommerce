import { storeScopedTransaction } from "../db";
import { blockInngestSend } from "./event-key";
import { sendWithTimeout } from "./notify";

function logSendFailure(event: string, orderId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event, orderId, message }));
}

export async function sendOrderAuthorized(storeId: string, orderId: string): Promise<void> {
  if (blockInngestSend()) return;

  let sent = false;
  try {
    const order = await storeScopedTransaction(storeId, async (tx) => {
      return tx.order.findUnique({ where: { id: orderId }, select: { createdAt: true } });
    });
    if (!order) {
      console.error(JSON.stringify({ event: "inngest_order_not_found", orderId }));
      return;
    }
    await sendWithTimeout({
      id: `order-authorized-${orderId}`,
      name: "order/authorized",
      data: { storeId, orderId, authorizedAt: order.createdAt.toISOString() },
    });
    sent = true;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { inngestEventSentAt: new Date() },
      });
    });
  } catch (err) {
    logSendFailure(sent ? "inngest_sent_at_update_failed" : "inngest_send_failed", orderId, err);
  }
}
