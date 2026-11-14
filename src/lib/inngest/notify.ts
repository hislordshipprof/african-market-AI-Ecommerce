import { inngest } from "./client";
import { scheduleAfterResponse } from "../schedule-after-response";
import { blockInngestSend, devServerWithoutKey } from "./event-key";
import type { OrderNotifyEvent } from "../notifications/record";

const SEND_TIMEOUT_MS = 10_000;
const SWEEP_ROUND_MS = 15 * 60_000;

export function sendWithTimeout(payload: Parameters<typeof inngest.send>[0]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("inngest send timed out")), SEND_TIMEOUT_MS);
  });
  const sendPromise = inngest.send(payload);
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
export function sendSkipped(): boolean {
  if (blockInngestSend()) return true;
  const env = process.env;
  return !env.INNGEST_EVENT_KEY && !devServerWithoutKey(env) && (env.NODE_ENV === "test" || env.CI === "true");
}

async function sendLogged(orderId: string, payload: Parameters<typeof inngest.send>[0]): Promise<void> {
  if (sendSkipped()) return;
  try {
    await sendWithTimeout(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    console.error(JSON.stringify({ event: "inngest_send_failed", orderId, message }));
  }
}

function notificationEvent(storeId: string, orderId: string, event: OrderNotifyEvent | string, round?: string) {
  return {
    id: `order-notify-${event}-${orderId}${round ? `-${round}` : ""}`,
    name: "order/notification.requested",
    data: { storeId, orderId, event },
  };
}

/** `round` keeps a repeatable event (a later substitution prompt) apart from Inngest's 24 h dedupe. */
export async function sendOrderNotification(
  storeId: string,
  orderId: string,
  event: OrderNotifyEvent | string,
  round?: string,
): Promise<void> {
  await sendLogged(orderId, notificationEvent(storeId, orderId, event, round));
}

/**
 * The sweep's re-send, in one call. Each 15-minute round gets a new id, so an event Inngest
 * took but never ran is sent again; the row claim and the provider key stop a double send.
 */
export async function resendOrderNotifications(
  rows: ReadonlyArray<{ storeId: string; orderId: string; event: OrderNotifyEvent }>,
): Promise<void> {
  if (rows.length === 0 || sendSkipped()) return;
  const round = `sweep-${Math.floor(Date.now() / SWEEP_ROUND_MS)}`;
  try {
    await sendWithTimeout(rows.map((row) => notificationEvent(row.storeId, row.orderId, row.event, round)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    console.error(JSON.stringify({ event: "inngest_send_failed", count: rows.length, message }));
  }
}

/** A courier order reached Ready: the dispatch function books its courier (#136). */
export function scheduleCourierDispatch(storeId: string, orderId: string): void {
  scheduleAfterResponse(
    () => sendLogged(orderId, { id: `courier-order-ready-${orderId}`, name: "courier/order.ready", data: { storeId, orderId } }),
    "inngest_send_failed",
  );
}

export function scheduleOrderNotification(storeId: string, orderId: string, event: OrderNotifyEvent, round?: string): void {
  scheduleAfterResponse(
    () => sendOrderNotification(storeId, orderId, event, round),
    "inngest_send_failed",
  );
}

/** Starts the 10-minute timer for one substitution prompt. The sweep is the backstop if this send is lost. */
export function scheduleSubstitutionTimer(storeId: string, orderId: string, requestId: string, expiresAt: Date): void {
  scheduleAfterResponse(
    () => sendLogged(orderId, {
      id: `order-substitution-${requestId}`,
      name: "order/substitution.requested",
      data: { storeId, requestId, expiresAt: expiresAt.toISOString() },
    }),
    "inngest_send_failed",
  );
}
