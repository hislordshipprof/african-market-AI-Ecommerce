import { inngest } from "../inngest/client";
import { sendSkipped, sendWithTimeout } from "../inngest/notify";
import { DoorDashDriveProvider } from "./doordash";
import { UberDirectProvider } from "./uber-direct";
import {
  COURIER_BOTH_FAILED,
  COURIER_DELIVERY_CREATED,
  courierRequest,
  runCourierFailover,
  selectAndDispatch,
  type CourierEvent,
  type DispatchDeps,
  type DispatchResult,
} from "./dispatch";

/** Both adapters read their keys per call, so a provider without keys fails its quote and is skipped. */
function productionDeps(): DispatchDeps {
  return { providers: [new DoorDashDriveProvider(), new UberDirectProvider()], emit: emitCourierEvent };
}

/** Event ids let Inngest drop a repeat from a retried step. */
function eventId(event: CourierEvent): string {
  if (event.name === COURIER_DELIVERY_CREATED) return `courier-delivery-created-${event.data.deliveryId}`;
  if (event.name === COURIER_BOTH_FAILED) return `courier-both-failed-${event.data.orderId}`;
  return `courier-failover-${event.data.orderId}-${event.data.fromProvider}`;
}

/** A failed send is logged, never thrown: the delivery is already booked or the failover already ran. */
export async function emitCourierEvent(event: CourierEvent): Promise<void> {
  if (sendSkipped()) return;
  try {
    await sendWithTimeout({ id: eventId(event), name: event.name, data: event.data });
  } catch (err) {
    console.error(JSON.stringify({ event: "inngest_send_failed", name: event.name, message: err instanceof Error ? err.message : "send failed" }));
  }
}

/** Books a courier for a Ready courier order with the platform's providers. */
export async function dispatchCourier(storeId: string, orderId: string): Promise<DispatchResult> {
  // Plan gate (#494): courier delivery is Pro only. The check goes here, before any quote; failover does not re-check.
  return selectAndDispatch({ storeId, orderId, ...(await courierRequest(storeId, orderId)) }, productionDeps());
}

export const courierAssignmentTimeout = inngest.createFunction(
  {
    id: "courier/assignment-timeout",
    idempotency: "event.data.deliveryId",
    triggers: [{ event: COURIER_DELIVERY_CREATED }],
  },
  async ({ event, step }) => {
    const { storeId, deliveryId } = event.data as { storeId?: string; deliveryId?: string };
    if (!storeId || !deliveryId) return;
    await runCourierFailover(step, { storeId, deliveryId }, productionDeps());
  },
);
