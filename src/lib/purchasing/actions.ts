"use server";

import { z } from "zod";
import { storeMayUse } from "../billing/plan";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { QUANTITY_MAX } from "../copilot/types";
import { archiveSupplier, saveSupplier, setSupplierListings, SUPPLIER_LISTINGS_MAX, type Result } from "./suppliers";
import { draftPurchaseOrders, editPurchaseOrderLines, movePurchaseOrder, sendPurchaseOrder, type DraftResult, type SendResult } from "./purchase-orders";

const PRO_ONLY = "Suppliers and purchase orders are on the Pro plan.";
const id = z.string().min(1).max(200);

/** Pro only: purchase orders are drafted from the Pro reorder list (#551). */
async function gate(session: Awaited<ReturnType<typeof requireStoreOwner>>) {
  const allowed = await storeMayUse(session.store.id, "reorder-suggestions");
  return { allowed, actor: { id: session.user.id, email: session.user.email } };
}

export async function saveSupplierAction(input: unknown): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.object({ id: id.nullable(), supplier: z.unknown() }), input);
  if (!parsed.ok) return { ok: false, message: "Check the supplier details." };
  return saveSupplier(session.store.id, parsed.data.id, parsed.data.supplier, actor);
}

export async function setSupplierListingsAction(input: unknown): Promise<Result> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.strictObject({ supplierId: id, listingIds: z.array(id).max(SUPPLIER_LISTINGS_MAX) }), input);
  if (!parsed.ok) return { ok: false, message: "Pick the items again." };
  return setSupplierListings(session.store.id, parsed.data.supplierId, parsed.data.listingIds, actor);
}

export async function archiveSupplierAction(input: unknown): Promise<Result> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.strictObject({ supplierId: id }), input);
  if (!parsed.ok) return { ok: false, message: "That supplier is not in your store." };
  return archiveSupplier(session.store.id, parsed.data.supplierId, actor);
}

export async function draftPurchaseOrdersAction(): Promise<DraftResult> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  return draftPurchaseOrders(session.store.id, actor);
}

export async function editPurchaseOrderAction(input: unknown): Promise<Result> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.strictObject({
    orderId: id,
    lines: z.array(z.strictObject({ lineId: id, quantity: z.number().int().min(0).max(QUANTITY_MAX).nullable() })).max(500),
  }), input);
  if (!parsed.ok) return { ok: false, message: `Whole numbers, up to ${QUANTITY_MAX}.` };
  return editPurchaseOrderLines(session.store.id, parsed.data.orderId, parsed.data.lines, actor);
}

export async function sendPurchaseOrderAction(input: unknown): Promise<SendResult> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.strictObject({ orderId: id }), input);
  if (!parsed.ok) return { ok: false, message: "That order is not in your store." };
  return sendPurchaseOrder(session.store.id, parsed.data.orderId, { ...actor, storeName: session.store.name });
}

export async function movePurchaseOrderAction(input: unknown): Promise<Result> {
  const session = await requireStoreOwner();
  const { allowed, actor } = await gate(session);
  if (!allowed) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(z.strictObject({ orderId: id, to: z.enum(["received", "cancelled"]) }), input);
  if (!parsed.ok) return { ok: false, message: "That order is not in your store." };
  return movePurchaseOrder(session.store.id, parsed.data.orderId, parsed.data.to, actor);
}
