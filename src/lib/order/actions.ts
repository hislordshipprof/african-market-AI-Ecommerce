"use server";

import { requireStoreMember } from "../store-admin/session";
import {
  getStoreOrders,
  acceptOrder,
  markLinePicked,
  markReady,
  completePickup,
} from "./service";
import { platform } from "../db";
import { STAFF_GENERIC_ERROR } from "./staff-copy";

const ALLOWED_STAFF_ERRORS = new Set([
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
]);

function isAllowListed(message: string): boolean {
  if (ALLOWED_STAFF_ERRORS.has(message)) return true;
  return (
    message.startsWith("Cannot mark ready for order in status ") ||
    message.startsWith("Cannot accept order in status ") ||
    message.startsWith("Cannot pick lines for order in status ") ||
    message.startsWith("Cannot complete pickup for order in status ") ||
    message.startsWith("Line already resolved") ||
    message.startsWith("Retrying in ") ||
    message.startsWith("Capture amount ")
  );
}

function staffFailure(action: string, orderId: string, err: unknown): { ok: false; error: string } {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown failure";
  const message = raw
    .replace(/[^\s<>"]+@[^\s<>"]+/g, "[redacted]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[redacted]");
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

export async function fetchOrdersAction() {
  const session = await requireStoreMember();
  const orders = await getStoreOrders(session.store.id);
  return { orders, storeId: session.store.id };
}

export async function acceptOrderAction(orderId: string, prepEstimateMinutes: number) {
  const session = await requireStoreMember();
  return runStaffAction("acceptOrder", orderId, () =>
    acceptOrder(session.store.id, orderId, prepEstimateMinutes),
  );
}

export async function autoAcceptOrderAction(orderId: string) {
  const session = await requireStoreMember();
  const store = await platform.store.findUnique({
    where: { id: session.store.id },
    select: { autoAcceptOrders: true, prepTimeMinutes: true },
  });
  if (!store?.autoAcceptOrders) {
    return { ok: false as const, error: "Auto-accept is not enabled for this store" };
  }
  return runStaffAction("acceptOrder", orderId, () =>
    acceptOrder(session.store.id, orderId, store.prepTimeMinutes),
  );
}

export async function markLinePickedAction(lineId: string) {
  const session = await requireStoreMember();
  return runStaffAction("markLinePicked", lineId, () => markLinePicked(session.store.id, lineId));
}

export async function markReadyAction(orderId: string) {
  const session = await requireStoreMember();
  return runStaffAction("markReady", orderId, () => markReady(session.store.id, orderId));
}

export async function completePickupAction(orderId: string) {
  const session = await requireStoreMember();
  return runStaffAction("completePickup", orderId, () => completePickup(session.store.id, orderId));
}
