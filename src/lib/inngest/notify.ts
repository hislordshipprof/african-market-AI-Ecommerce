import { inngest } from "./client";
import { scheduleAfterResponse } from "../schedule-after-response";
import { blockInngestSend, devServerWithoutKey } from "./event-key";
import type { OrderNotifyEvent } from "../notifications/record";

const SEND_TIMEOUT_MS = 10_000;

function sendWithTimeout(storeId: string, orderId: string, event: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("inngest send timed out")), SEND_TIMEOUT_MS);
  });
  const sendPromise = inngest.send({
    id: `order-notify-${event}-${orderId}`,
    name: "order/notification.requested",
    data: { storeId, orderId, event },
  });
  return Promise.race([sendPromise, timeout]).then(
    () => {
      if (timer) clearTimeout(timer);
    },
    (err: unknown) => {
      if (timer) clearTimeout(timer);
      void sendPromise.catch(() => undefined);
      throw err;
    },
  );
}

/**
 * Schedules nothing when the event key is missing. In tests, without a key,
 * it returns before any network call. A failure never throws to the caller.
 */
export async function sendOrderNotification(
  storeId: string,
  orderId: string,
  event: OrderNotifyEvent | string,
): Promise<void> {
  if (blockInngestSend()) return;
  const env = process.env;
  if (!env.INNGEST_EVENT_KEY && !devServerWithoutKey(env) && (env.NODE_ENV === "test" || env.CI === "true")) {
    return;
  }
  try {
    await sendWithTimeout(storeId, orderId, event);
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    console.error(JSON.stringify({ event: "inngest_send_failed", orderId, message }));
  }
}

export function scheduleOrderNotification(storeId: string, orderId: string, event: OrderNotifyEvent): void {
  scheduleAfterResponse(
    () => sendOrderNotification(storeId, orderId, event),
    "inngest_send_failed",
  );
}
