import { inngest } from "./client";
import { storeScopedTransaction } from "../db";

const SEND_TIMEOUT_MS = 10_000;

let loggedMissingEventKey = false;

function productionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

/**
 * Local Dev Server may send without an event key. On Vercel the client forces
 * cloud mode (`isDev: false`), so INNGEST_DEV must not skip the key there.
 * CI does not select dev mode.
 */
function devServerWithoutKey(): boolean {
  if (process.env.VERCEL) return false;
  return process.env.INNGEST_DEV === "1";
}

/** One log per process when production has no event key and is not on the Dev Server. */
function missingEventKey(): boolean {
  if (devServerWithoutKey()) return false;
  if (!productionRuntime() || process.env.INNGEST_EVENT_KEY) return false;
  if (!loggedMissingEventKey) {
    loggedMissingEventKey = true;
    console.error(JSON.stringify({ event: "inngest_event_key_missing" }));
  }
  return true;
}

function logSendFailure(event: string, orderId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event, orderId, message }));
}

async function sendWithTimeout(storeId: string, orderId: string, authorizedAt: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("inngest send timed out")), SEND_TIMEOUT_MS);
  });
  const sendPromise = inngest.send({
    id: `order-authorized-${orderId}`,
    name: "order/authorized",
    data: { storeId, orderId, authorizedAt },
  });
  try {
    await Promise.race([sendPromise, timeout]);
  } catch (err) {
    void sendPromise.catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sendOrderAuthorized(storeId: string, orderId: string): Promise<void> {
  if (missingEventKey()) return;

  let sent = false;
  try {
    const order = await storeScopedTransaction(storeId, async (tx) => {
      return tx.order.findUnique({ where: { id: orderId }, select: { createdAt: true } });
    });
    if (!order) {
      console.error(JSON.stringify({ event: "inngest_order_not_found", orderId }));
      return;
    }
    await sendWithTimeout(storeId, orderId, order.createdAt.toISOString());
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
