"use server";

import { z } from "zod";
import { READ_ONLY_MESSAGE, requireStoreMember, requireStoreWriter } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import {
  getStoreOrders,
  acceptOrder,
  defaultPrepEstimate,
  markLinePicked,
  markLineShort,
  markReady,
  completePickup,
  markOutForDelivery,
  markDelivered,
  cancelOrder,
  cancelShipment,
} from "./service";
import { buyShippingLabel, SHIPMENT_SCANNED, LABEL_BEING_BOUGHT, LABEL_NOT_BOUGHT, LABEL_PDF_NOT_SAVED, LABEL_STORAGE_NOT_SET_UP, POSTAGE_ROSE_PREFIX, SHIPPING_UNAVAILABLE } from "../shipping/label";
import { STORE_CANCEL_REASONS } from "./constants";
import {
  BATCH_LINE_DONE,
  BATCH_NOT_FOUND,
  BATCH_ORDERS_NOT_BATCHABLE,
  BATCH_SIZE,
  ORDER_IN_BATCH,
  UNITS_FOUND_PREFIX,
  leaveBatch,
  pickBatchLine,
  readPickBatch,
  startBatch,
  startBatchPacking,
} from "./batch";
import { courierProviders, pushReadyTime, READY_ALREADY_PUSHED, READY_NOT_PUSHABLE } from "../delivery/dispatch";
import { emitCourierEvent } from "../delivery/courier-functions";
import { readStoreCourierSettings } from "../delivery/courier-settings";
import {
  DELIVERY_PROOF_MAX_BYTES,
  PROOF_PHOTO_MISSING,
  PROOF_PHOTO_NOT_IMAGE,
  PROOF_PHOTO_TOO_LARGE,
  PROOF_STORAGE_NOT_SET_UP,
  STORE_DELIVERY_ONLY,
} from "./delivery-proof";
import { platform } from "../db";
import { STAFF_GENERIC_ERROR, redactedErrorMessage } from "./staff-copy";
import {
  ISSUE_ALREADY_HANDLED,
  ISSUE_AMOUNT_ABOVE_CAPTURE_PREFIX,
  ISSUE_AMOUNT_ABOVE_ISSUE,
  ISSUE_DECLINE_REASON_MISSING,
  ISSUE_NOT_FOUND,
  ISSUE_REFUND_FAILED,
  ISSUE_REFUND_NOT_STARTED,
  approveIssue,
  declineIssue,
  issueIdSchema,
} from "./issue-review";

const ALLOWED_STAFF_ERRORS = new Set([
  LABEL_STORAGE_NOT_SET_UP,
  SHIPPING_UNAVAILABLE,
  LABEL_NOT_BOUGHT,
  LABEL_PDF_NOT_SAVED,
  LABEL_BEING_BOUGHT,
  SHIPMENT_SCANNED,
  "This order cannot get a label",
  "The label is being bought. Try again in a minute",
  "Order status changed during cancellation",
  "Refund is still confirming with the bank",
  "Order not found",
  "Order line not found",
  "Auto-accept is not enabled for this store",
  "Order is not awaiting pickup",
  "Cannot complete pickup for delivery order — use courier dispatch",
  "Cannot mark ready: unresolved order lines remain",
  "Order has no payment intent",
  "Card capture failed temporarily; we'll retry",
  "Card capture is still confirming with the bank",
  "Cancellation is still confirming with the bank",
  "Payment authorization expired or was voided — order cancelled; contact the customer",
  "Payment authorization was released — order cancelled; contact the customer",
  "Order status changed during cancellation",
  "Quantity found must be a whole number below the quantity ordered",
  READY_ALREADY_PUSHED,
  READY_NOT_PUSHABLE,
  BATCH_SIZE,
  BATCH_ORDERS_NOT_BATCHABLE,
  BATCH_NOT_FOUND,
  BATCH_LINE_DONE,
  ORDER_IN_BATCH,
  STORE_DELIVERY_ONLY,
  PROOF_PHOTO_MISSING,
  PROOF_PHOTO_NOT_IMAGE,
  PROOF_PHOTO_TOO_LARGE,
  PROOF_STORAGE_NOT_SET_UP,
  ISSUE_NOT_FOUND,
  ISSUE_ALREADY_HANDLED,
  ISSUE_AMOUNT_ABOVE_ISSUE,
  ISSUE_DECLINE_REASON_MISSING,
  ISSUE_REFUND_NOT_STARTED,
  ISSUE_REFUND_FAILED,
]);

function isAllowListed(message: string): boolean {
  if (ALLOWED_STAFF_ERRORS.has(message)) return true;
  return (
    message.startsWith("Cannot mark ready for order in status ") ||
    message.startsWith("Cannot accept order in status ") ||
    message.startsWith("Cannot pick lines for order in status ") ||
    message.startsWith("Cannot mark lines short for order in status ") ||
    message.startsWith("Cannot complete pickup for order in status ") ||
    message.startsWith("Cannot send out for delivery in status ") ||
    message.startsWith("Cannot mark delivered in status ") ||
    message.startsWith("Cannot cancel order in status ") ||
    message.startsWith("Line already resolved") ||
    message.startsWith("Retrying in ") ||
    message.startsWith("Capture amount ") ||
    message.startsWith(UNITS_FOUND_PREFIX) ||
    message.startsWith(POSTAGE_ROSE_PREFIX) ||
    message.startsWith(ISSUE_AMOUNT_ABOVE_CAPTURE_PREFIX)
  );
}

function staffFailure(action: string, orderId: string, err: unknown): { ok: false; error: string } {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown failure";
  const message = redactedErrorMessage(err);
  console.error(JSON.stringify({ event: "order_action_failed", action, orderId, message }));
  if (isAllowListed(raw)) return { ok: false, error: raw };
  return { ok: false, error: STAFF_GENERIC_ERROR };
}

function presented<T extends { ok: boolean }>(
  action: string,
  orderId: string,
  result: T,
): T | { ok: false; error: string } {
  if (result.ok !== false || !("error" in result)) return result;
  const error = (result as { error?: unknown }).error;
  if (typeof error === "string" && isAllowListed(error)) return result;
  return staffFailure(action, orderId, error);
}

async function runStaffAction<T extends { ok: boolean }>(
  action: string,
  orderId: string,
  fn: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return presented(action, orderId, await fn());
  } catch (err) {
    return staffFailure(action, orderId, err);
  }
}

const orderIdSchema = z.string().min(1).max(200);

export async function fetchOrdersAction() {
  const session = await requireStoreMember();
  const orders = await getStoreOrders(session.store.id);
  return { orders, storeId: session.store.id };
}

export async function acceptOrderAction(orderId: string, prepEstimateMinutes: number) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  const prep = parseInput(z.number().int().min(0).max(100_000), prepEstimateMinutes);
  if (!id.ok || !prep.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("acceptOrder", id.data, () =>
    acceptOrder(session.store.id, id.data, prep.data),
  );
}

export async function autoAcceptOrderAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  const store = await platform.store.findUnique({
    where: { id: session.store.id },
    select: { autoAcceptOrders: true, prepTimeMinutes: true },
  });
  if (!store?.autoAcceptOrders) {
    return { ok: false as const, error: "Auto-accept is not enabled for this store" };
  }
  return runStaffAction("acceptOrder", id.data, async () =>
    acceptOrder(session.store.id, id.data, await defaultPrepEstimate(session.store.id, id.data, store.prepTimeMinutes)),
  );
}

export async function markLinePickedAction(lineId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, lineId);
  if (!id.ok) return { ok: false as const, error: "Order line not found" };
  return runStaffAction("markLinePicked", id.data, () => markLinePicked(session.store.id, id.data));
}

export async function markLineShortAction(lineId: string, qtyFound: number) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, lineId);
  const found = parseInput(z.number().int().min(0).max(100_000), qtyFound);
  if (!id.ok) return { ok: false as const, error: "Order line not found" };
  if (!found.ok) return { ok: false as const, error: "Quantity found must be a whole number below the quantity ordered" };
  return runStaffAction("markLineShort", id.data, () => markLineShort(session.store.id, id.data, found.data));
}

/** `confirmPostageCents`: staff accepted a re-quoted postage more than $2 above what the shopper paid (#568). */
export async function markReadyAction(orderId: string, confirmPostageCents?: number) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  const confirm = parseInput(z.number().int().min(0).max(1_000_000).optional(), confirmPostageCents);
  if (!confirm.ok) return { ok: false as const, error: "Postage not recognised. Mark ready again" };
  return runStaffAction("markReady", id.data, () => markReady(session.store.id, id.data, { confirmPostageCents: confirm.data }));
}

/** Buys the label again when the one at Ready failed (#568). */
export async function buyShippingLabelAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("buyShippingLabel", id.data, () => buyShippingLabel(session.store.id, id.data));
}

/** Voids the label and refunds the order, only before the carrier's first scan (#568). */
export async function cancelShipmentAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("cancelShipment", id.data, () =>
    cancelShipment(session.store.id, id.data, { id: session.user.id, email: session.user.email }),
  );
}

/** The store's one "5 more minutes" on a courier order that is packing (#562). */
export async function pushReadyTimeAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("pushReadyTime", id.data, () =>
    pushReadyTime(session.store.id, id.data, { providers: courierProviders(), emit: emitCourierEvent, settings: readStoreCourierSettings }),
  );
}

export async function completePickupAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("completePickup", id.data, () => completePickup(session.store.id, id.data));
}

export async function markOutForDeliveryAction(orderId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  return runStaffAction("markOutForDelivery", id.data, () => markOutForDelivery(session.store.id, id.data));
}

/** FormData: `orderId` and the `photo` file. The service checks the photo's bytes. */
export async function markDeliveredAction(form: FormData) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, form.get("orderId"));
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  const photo = form.get("photo");
  const file = photo instanceof File && photo.size > 0 ? photo : null;
  if (file && file.size > DELIVERY_PROOF_MAX_BYTES) return { ok: false as const, error: PROOF_PHOTO_TOO_LARGE };
  return runStaffAction("markDelivered", id.data, async () =>
    markDelivered(session.store.id, id.data, file ? new Uint8Array(await file.arrayBuffer()) : null),
  );
}

const batchOrderIdsSchema = z.array(orderIdSchema).min(1).max(10);

/** Batch picking (#564): 2-4 Accepted orders of the session's store picked together. */
export async function startBatchAction(orderIds: string[]) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const ids = parseInput(batchOrderIdsSchema, orderIds);
  if (!ids.ok) return { ok: false as const, error: BATCH_SIZE };
  return runStaffAction("startBatch", ids.data.join(","), () => startBatch(session.store.id, ids.data));
}

export async function readBatchAction(batchId: string) {
  const session = await requireStoreMember();
  const id = parseInput(orderIdSchema, batchId);
  if (!id.ok) return null;
  return readPickBatch(session.store.id, id.data);
}

/** "Start packing": books the courier for courier orders (#562). */
export async function startBatchPackingAction(batchId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, batchId);
  if (!id.ok) return { ok: false as const, error: BATCH_NOT_FOUND };
  return runStaffAction("startBatchPacking", id.data, () => startBatchPacking(session.store.id, id.data));
}

export async function pickBatchLineAction(batchId: string, listingVariantId: string, unitsFound: number) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, batchId);
  const variant = parseInput(orderIdSchema, listingVariantId);
  const found = parseInput(z.number().int().min(0).max(100_000), unitsFound);
  if (!id.ok) return { ok: false as const, error: BATCH_NOT_FOUND };
  if (!variant.ok) return { ok: false as const, error: BATCH_LINE_DONE };
  if (!found.ok) return { ok: false as const, error: `${UNITS_FOUND_PREFIX}the number ordered` };
  return runStaffAction("pickBatchLine", id.data, () =>
    pickBatchLine(session.store.id, id.data, variant.data, found.data),
  );
}

export async function leaveBatchAction(batchId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, batchId);
  if (!id.ok) return { ok: false as const, error: BATCH_NOT_FOUND };
  return runStaffAction("leaveBatch", id.data, () => leaveBatch(session.store.id, id.data));
}

const storeCancelSchema = z.object({
  reason: z.enum(STORE_CANCEL_REASONS),
  note: z.string().trim().max(500).nullish(),
});

/** Before capture only: the core refuses CAPTURING and every later status. */
export async function cancelOrderAction(orderId: string, input: { reason: string; note?: string | null }) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(orderIdSchema, orderId);
  if (!id.ok) return { ok: false as const, error: "Order not found" };
  const parsed = parseInput(storeCancelSchema, input);
  if (!parsed.ok) return { ok: false as const, error: "Choose a reason to cancel" };
  return runStaffAction("cancelOrder", id.data, () =>
    cancelOrder(session.store.id, id.data, {
      action: "store_cancel",
      actor: { id: session.user.id, email: session.user.email },
      reason: parsed.data.reason,
      note: parsed.data.note || null,
    }),
  );
}

const issueAmountSchema = z.number().int().min(1).max(10_000_000).optional();
const declineReasonSchema = z.string().trim().min(1).max(500);

/** Any member with write access (owner decision 2). No amount refunds the whole issue. */
export async function approveIssueAction(issueId: string, amountCents?: number) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(issueIdSchema, issueId);
  if (!id.ok) return { ok: false as const, error: ISSUE_NOT_FOUND };
  const amount = parseInput(issueAmountSchema, amountCents);
  if (!amount.ok) return { ok: false as const, error: ISSUE_AMOUNT_ABOVE_ISSUE };
  return runStaffAction("approveIssue", id.data, () =>
    approveIssue(session.store.id, id.data, { id: session.user.id, email: session.user.email }, amount.data),
  );
}

export async function declineIssueAction(issueId: string, reason: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(issueIdSchema, issueId);
  if (!id.ok) return { ok: false as const, error: ISSUE_NOT_FOUND };
  const parsed = parseInput(declineReasonSchema, reason);
  if (!parsed.ok) return { ok: false as const, error: ISSUE_DECLINE_REASON_MISSING };
  return runStaffAction("declineIssue", id.data, () =>
    declineIssue(session.store.id, id.data, { id: session.user.id, email: session.user.email }, parsed.data),
  );
}
