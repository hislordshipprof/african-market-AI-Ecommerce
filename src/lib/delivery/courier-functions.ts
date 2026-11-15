import { inngest } from "../inngest/client";
import { sendSkipped, sendWithTimeout } from "../inngest/notify";
import { copyCourierProof } from "./proof";
import { readCourierSettings } from "./courier-settings";
import { COURIER_REGISTRATION_REQUESTED, findStoresNeedingCourierRegistration, registerStoreCouriers } from "./courier-registration";
import {
  COURIER_BOTH_FAILED,
  courierFailoverFailed,
  COURIER_DELIVERY_CREATED,
  COURIER_ORDER_CANCELLED,
  COURIER_ORDER_PACKING,
  COURIER_ORDER_READY,
  cancelOrderCouriers,
  dispatchPackingOrder,
  COURIER_PROOF_RECEIVED,
  courierProviders,
  dispatchReadyOrder,
  runCourierFailover,
  type CourierEvent,
  type DispatchDeps,
} from "./dispatch";

function productionDeps(): DispatchDeps {
  return { providers: courierProviders(), emit: emitCourierEvent, settings: () => readCourierSettings() };
}

/** Event ids let Inngest drop a repeat from a retried step. */
function eventId(event: CourierEvent): string {
  if (event.name === COURIER_ORDER_READY) return `courier-order-ready-${event.data.orderId}`;
  if (event.name === COURIER_ORDER_PACKING) return `courier-order-packing-${event.data.orderId}`;
  if (event.name === COURIER_ORDER_CANCELLED) return `courier-order-cancelled-${event.data.orderId}`;
  if (event.name === COURIER_PROOF_RECEIVED) return `courier-proof-${event.data.deliveryId}`;
  if (event.name === COURIER_DELIVERY_CREATED) return `courier-delivery-created-${event.data.deliveryId}`;
  if (event.name === COURIER_BOTH_FAILED) return `courier-both-failed-${event.data.orderId}`;
  return `courier-failover-${event.data.orderId}-${event.data.fromProvider}`;
}

/**
 * A failed timer send throws, so a retried step sends it again; without it a booked courier has no failover.
 * A failed notification send is logged, never thrown: the delivery is already booked or the failover already ran.
 */
export async function emitCourierEvent(event: CourierEvent): Promise<void> {
  if (sendSkipped()) return;
  try {
    await sendWithTimeout({ id: eventId(event), name: event.name, data: event.data });
  } catch (err) {
    console.error(JSON.stringify({ event: "inngest_send_failed", name: event.name, message: err instanceof Error ? err.message : "send failed" }));
    if (event.name === COURIER_DELIVERY_CREATED) throw err;
  }
}

/** The packing, ready and cancel jobs for one order run one at a time, so two of them never book two couriers (#562). */
const ONE_PER_ORDER = { scope: "env" as const, key: `"courier-order-" + event.data.orderId`, limit: 1 };

/** Books the courier when packing starts (#562). A failure here is tried again at Ready. */
export const courierDispatchOnPacking = inngest.createFunction(
  { id: "courier/dispatch-on-packing", idempotency: "event.data.orderId", concurrency: ONE_PER_ORDER, triggers: [{ event: COURIER_ORDER_PACKING }] },
  async ({ event, step }) => {
    const { storeId, orderId } = event.data as { storeId?: string; orderId?: string };
    if (!storeId || !orderId) return;
    await step.run("courier-dispatch-packing", () => dispatchPackingOrder(storeId, orderId, productionDeps()));
  },
);

/** Cancels the courier of an order cancelled before capture (#562). A transient provider error retries. */
export const courierCancelOnOrderCancelled = inngest.createFunction(
  { id: "courier/cancel-on-order-cancelled", idempotency: "event.data.orderId", concurrency: ONE_PER_ORDER, triggers: [{ event: COURIER_ORDER_CANCELLED }] },
  async ({ event, step }) => {
    const { storeId, orderId } = event.data as { storeId?: string; orderId?: string };
    if (!storeId || !orderId) return;
    await step.run("courier-cancel-order", () => cancelOrderCouriers(storeId, orderId, productionDeps()));
  },
);

/** Books the courier once a courier order is Ready. A retried step finds the booked delivery and books no other. */
export const courierDispatchOnReady = inngest.createFunction(
  { id: "courier/dispatch-on-ready", idempotency: "event.data.orderId", concurrency: ONE_PER_ORDER, triggers: [{ event: COURIER_ORDER_READY }] },
  async ({ event, step }) => {
    const { storeId, orderId } = event.data as { storeId?: string; orderId?: string };
    if (!storeId || !orderId) return;
    await step.run("courier-dispatch", () => dispatchReadyOrder(storeId, orderId, productionDeps()));
  },
);

export const courierProofCopy = inngest.createFunction(
  { id: "courier/proof-copy", idempotency: "event.data.deliveryId", triggers: [{ event: COURIER_PROOF_RECEIVED }] },
  async ({ event, step }) => {
    const { storeId, deliveryId } = event.data as { storeId?: string; deliveryId?: string };
    if (!storeId || !deliveryId) return;
    await step.run("courier-proof-copy", () => copyCourierProof(storeId, deliveryId));
  },
);

export const courierAssignmentTimeout = inngest.createFunction(
  {
    id: "courier/assignment-timeout",
    idempotency: "event.data.deliveryId",
    triggers: [{ event: COURIER_DELIVERY_CREATED }],
    onFailure: async ({ event }) => {
      const { storeId, deliveryId } = event.data.event.data as { storeId?: string; deliveryId?: string };
      if (storeId && deliveryId) await courierFailoverFailed({ storeId, deliveryId }, productionDeps());
    },
  },
  async ({ event, step }) => {
    const { storeId, deliveryId } = event.data as { storeId?: string; deliveryId?: string };
    if (!storeId || !deliveryId) return;
    await runCourierFailover(step, { storeId, deliveryId }, productionDeps());
  },
);

/** One run per store at a time, so a repeat request finds the store registered and creates no second Uber organization. */
export const courierRegistration = inngest.createFunction(
  {
    id: "courier/registration",
    concurrency: { key: "event.data.storeId", limit: 1 },
    triggers: [{ event: COURIER_REGISTRATION_REQUESTED }],
  },
  async ({ event, step }) => {
    const { storeId } = event.data as { storeId?: string };
    if (!storeId) return;
    await step.run("courier-register", () => registerStoreCouriers(storeId));
  },
);

const REGISTRATION_RETRY_BATCH = 100;

/** Daily retry of failed registrations, and the backfill of stores created before #526, through the job above. */
export const courierRegistrationRetry = inngest.createFunction(
  { id: "courier/registration-retry", singleton: { mode: "skip" }, triggers: [{ cron: "TZ=UTC 41 6 * * *" }] },
  async ({ step }) => {
    const stores = await step.run("find-unregistered-stores", () => findStoresNeedingCourierRegistration(REGISTRATION_RETRY_BATCH));
    if (stores.length === 0) return;
    await step.sendEvent(
      "request-courier-registration",
      stores.map((store) => ({ name: COURIER_REGISTRATION_REQUESTED, data: { storeId: store.id } })),
    );
  },
);
