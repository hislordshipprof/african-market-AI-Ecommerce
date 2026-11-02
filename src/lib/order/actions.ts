"use server";

import { requireStoreMember } from "../store-admin/session";
import {
  getStoreOrders,
  acceptOrder,
  markLinePicked,
  completePickup,
  getOrderById,
} from "./service";
import { platform } from "../db";

export async function fetchOrdersAction() {
  const session = await requireStoreMember();
  const orders = await getStoreOrders(session.store.id);
  return { orders, storeId: session.store.id };
}

export async function fetchOrderAction(orderId: string) {
  const session = await requireStoreMember();
  const order = await getOrderById(session.store.id, orderId);
  return { order, storeId: session.store.id };
}

export async function acceptOrderAction(orderId: string, prepEstimateMinutes: number) {
  const session = await requireStoreMember();
  return acceptOrder(session.store.id, orderId, prepEstimateMinutes);
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
  return acceptOrder(session.store.id, orderId, store.prepTimeMinutes);
}

export async function markLinePickedAction(lineId: string) {
  const session = await requireStoreMember();
  return markLinePicked(session.store.id, lineId);
}

export async function completePickupAction(orderId: string) {
  const session = await requireStoreMember();
  return completePickup(session.store.id, orderId);
}
