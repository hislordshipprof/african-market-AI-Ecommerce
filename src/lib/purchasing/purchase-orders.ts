import { createHash } from "node:crypto";
import { lockListingRow, lockPurchaseOrders, lockStoreRow, storeScoped, storeScopedTransaction } from "../db";
import { quotedFrom } from "../email/from";
import { sendEmail } from "../email/send";
import { escapeHtml } from "../format";
import { QTY_COLUMN_MAX, QUANTITY_MAX, WRITE_TRANSACTION } from "../copilot/types";
import { writeStockChange } from "../copilot/confirm";
import { matchReportItem, type ExtractedItem } from "../copilot/owner-report";
import { NO_COUNT } from "../copilot/reorder-list";
import type { Actor, Result, SupplierChannel } from "./suppliers";

export const PO_STATUSES = ["draft", "sent", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** Received and cancelled are final. Sending and receiving are their own steps. */
const MOVES: Record<PoStatus, PoStatus[]> = {
  draft: ["cancelled"],
  sent: ["cancelled"],
  received: [],
  cancelled: [],
};

export interface PurchaseOrderView {
  id: string;
  number: number;
  status: PoStatus;
  sentVia: SupplierChannel | null;
  sentAt: Date | null;
  createdAt: Date;
  supplier: { id: string; name: string; channel: SupplierChannel; email: string | null; phone: string | null; leadDays: number };
  /** stockMode is the listing's now: a counted line is received with a quantity, a status line becomes in stock. */
  lines: Array<{ id: string; listingId: string; name: string; quantity: number | null; stockMode: StockMode }>;
}

export type DraftResult = { ok: true; drafted: number; unassigned: string[] } | { ok: false; message: string };
export type SendResult = { ok: true; via: SupplierChannel; link?: string } | { ok: false; message: string };

const audit = (storeId: string, actor: Actor, action: string, entityId: string, before?: object, after?: object) => ({
  data: { storeId, actorId: actor.id, actorEmail: actor.email, action, entityType: "purchase_order", entityId, before, after },
});

/**
 * Splits the saved reorder list into one draft per supplier. A supplier's existing draft gets the new
 * lines and keeps its number; sent orders are never touched. Items with no supplier are left out.
 */
export async function draftPurchaseOrders(storeId: string, actor: Actor): Promise<DraftResult> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockPurchaseOrders(tx, storeId);
    const list = await tx.reorderList.findUnique({
      where: { storeId },
      select: { items: { orderBy: { position: "asc" }, select: { listingId: true, name: true, quantity: true } } },
    });
    if (!list || list.items.length === 0) return { ok: false, message: "Save a reorder list first." };
    const links = await tx.supplierListing.findMany({
      where: { listingId: { in: list.items.map((item) => item.listingId) }, supplier: { archivedAt: null } },
      select: { listingId: true, supplierId: true },
    });
    const supplierOf = new Map(links.map((link) => [link.listingId, link.supplierId]));
    const bySupplier = new Map<string, typeof list.items>();
    const unassigned: string[] = [];
    for (const item of list.items) {
      const supplierId = supplierOf.get(item.listingId);
      if (!supplierId) unassigned.push(item.name);
      else bySupplier.set(supplierId, [...(bySupplier.get(supplierId) ?? []), item]);
    }
    if (bySupplier.size === 0) return { ok: false, message: "No item on the list has a supplier yet. Pick each supplier's items first." };

    const last = await tx.purchaseOrder.aggregate({ where: { storeId }, _max: { number: true } });
    let next = (last._max.number ?? 0) + 1;
    for (const [supplierId, items] of bySupplier) {
      const existing = await tx.purchaseOrder.findFirst({ where: { storeId, supplierId, status: "draft" }, select: { id: true } });
      const order = existing ?? (await tx.purchaseOrder.create({ data: { storeId, supplierId, number: next++, createdById: actor.id } }));
      if (existing) {
        await tx.purchaseOrderLine.deleteMany({ where: { orderId: order.id } });
        await tx.purchaseOrder.update({ where: { id: order.id }, data: { updatedAt: new Date() } });
      }
      await tx.purchaseOrderLine.createMany({
        data: items.map((item, position) => ({ orderId: order.id, storeId, listingId: item.listingId, name: item.name, quantity: item.quantity, position })),
      });
      await tx.auditLog.create(audit(storeId, actor, "purchase_order.draft", order.id, undefined, {
        supplierId,
        lines: items.map((item) => ({ listingId: item.listingId, quantity: item.quantity })),
      }));
    }
    return { ok: true, drafted: bySupplier.size, unassigned };
  });
}

/** Changes quantities on a draft. 0 removes a line; the last line cannot go (cancel the order instead). */
export async function editPurchaseOrderLines(
  storeId: string,
  orderId: string,
  edits: Array<{ lineId: string; quantity: number | null }>,
  actor: Actor,
): Promise<Result> {
  for (const edit of edits) {
    const q = edit.quantity;
    if (q !== null && (!Number.isInteger(q) || q < 0 || q > QUANTITY_MAX)) return { ok: false, message: `Whole numbers, up to ${QUANTITY_MAX}.` };
  }
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, storeId },
      select: { status: true, lines: { select: { id: true, quantity: true } } },
    });
    if (!order) return { ok: false, message: "That order is not in your store." };
    if (order.status !== "draft") return { ok: false, message: "Only a draft can be changed." };
    const current = new Map(order.lines.map((line) => [line.id, line.quantity]));
    if (edits.some((edit) => !current.has(edit.lineId))) return { ok: false, message: "A line is no longer on this order. Reload the page." };
    const removed = edits.filter((edit) => edit.quantity === 0).map((edit) => edit.lineId);
    if (removed.length >= order.lines.length) return { ok: false, message: "An order needs at least one line. Cancel it instead." };
    const changed = edits.filter((edit) => current.get(edit.lineId) !== edit.quantity);
    if (changed.length === 0) return { ok: true };
    for (const edit of changed) {
      if (edit.quantity === 0) await tx.purchaseOrderLine.delete({ where: { id: edit.lineId } });
      else await tx.purchaseOrderLine.update({ where: { id: edit.lineId }, data: { quantity: edit.quantity } });
    }
    await tx.purchaseOrder.update({ where: { id: orderId }, data: { updatedAt: new Date() } });
    await tx.auditLog.create(audit(storeId, actor, "purchase_order.edit", orderId,
      { lines: changed.map((edit) => ({ lineId: edit.lineId, quantity: current.get(edit.lineId) })) },
      { lines: changed.map((edit) => ({ lineId: edit.lineId, quantity: edit.quantity })) },
    ));
    return { ok: true };
  });
}

type MessageOrder = { number: number; lines: Array<{ name: string; quantity: number | null }> };

export function purchaseOrderText(order: MessageOrder, storeName: string): string {
  return [
    `Purchase order ${order.number} from ${storeName}`,
    ...order.lines.map((line) => `${line.name}: ${line.quantity ?? NO_COUNT}`),
    "Please confirm what you can supply and when. Thank you.",
  ].join("\n");
}

/** A link the owner sends from their own phone. The platform never messages a supplier on WhatsApp or SMS. */
export function shareLink(channel: "whatsapp" | "sms", e164: string, text: string): string {
  if (channel === "whatsapp") return `https://wa.me/${e164.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`;
  // "?&body=" is read by both iOS and Android messages apps.
  return `sms:${e164}?&body=${encodeURIComponent(text)}`;
}

function emailHtml(order: MessageOrder, storeName: string): string {
  const rows = order.lines
    .map((line) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(line.name)}</td><td style="padding:4px 0;text-align:right">${line.quantity}</td></tr>`)
    .join("");
  return [
    `<p>${escapeHtml(storeName)} would like to order:</p>`,
    `<table><thead><tr><th style="text-align:left;padding-right:12px">Item</th><th style="text-align:right">Quantity</th></tr></thead><tbody>${rows}</tbody></table>`,
    `<p>Please reply to confirm what you can supply and when. Purchase order ${order.number}.</p>`,
  ].join("");
}

/**
 * Sends a draft by the supplier's channel. Email goes through Resend from the platform sender with the
 * store's name; WhatsApp and SMS return a pre-filled link and the order counts as sent once it is opened.
 */
export async function sendPurchaseOrder(
  storeId: string,
  orderId: string,
  actor: Actor & { storeName: string },
): Promise<SendResult> {
  const order = await storeScoped(storeId).purchaseOrder.findFirst({
    where: { id: orderId, storeId },
    select: {
      number: true,
      status: true,
      supplier: { select: { channel: true, email: true, phone: true, archivedAt: true } },
      lines: { orderBy: { position: "asc" }, select: { name: true, quantity: true } },
    },
  });
  if (!order) return { ok: false, message: "That order is not in your store." };
  if (order.status !== "draft") return { ok: false, message: "This order was already sent or closed." };
  if (order.supplier.archivedAt) return { ok: false, message: "This supplier was removed." };
  const missing = order.lines.find((line) => line.quantity === null);
  if (missing) return { ok: false, message: `Enter a quantity for ${missing.name}.` };

  const channel = order.supplier.channel as SupplierChannel;
  let link: string | undefined;
  if (channel === "email") {
    const html = emailHtml(order, actor.storeName);
    // The body is in the key: an edited draft sent again is a new email, the same one is not sent twice.
    const digest = createHash("sha256").update(html).digest("hex").slice(0, 16);
    try {
      await sendEmail({
        to: order.supplier.email!,
        from: quotedFrom(actor.storeName, process.env.EMAIL_FROM ?? "onboarding@resend.dev"),
        replyTo: actor.email,
        subject: `Purchase order ${order.number} from ${actor.storeName}`.replace(/[\r\n]+/g, " "),
        html,
        idempotencyKey: `purchase-order:${orderId}:${digest}`,
      });
    } catch {
      return { ok: false, message: "The email could not be sent. The order is still a draft; try again." };
    }
  } else {
    link = shareLink(channel, order.supplier.phone!, purchaseOrderText(order, actor.storeName));
  }

  await storeScopedTransaction(storeId, async (tx) => {
    const now = new Date();
    const moved = await tx.purchaseOrder.updateMany({
      where: { id: orderId, storeId, status: "draft" },
      data: { status: "sent", sentVia: channel, sentAt: now },
    });
    if (moved.count === 1) {
      await tx.auditLog.create(audit(storeId, actor, "purchase_order.send", orderId, { status: "draft" }, { status: "sent", via: channel }));
    }
  });
  return link ? { ok: true, via: channel, link } : { ok: true, via: channel };
}

/** Draft or sent to cancelled. Received is reached only through receivePurchaseOrder. */
export async function movePurchaseOrder(storeId: string, orderId: string, to: "cancelled", actor: Actor): Promise<Result> {
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.purchaseOrder.findFirst({ where: { id: orderId, storeId }, select: { status: true } });
    if (!order) return { ok: false, message: "That order is not in your store." };
    const from = order.status as PoStatus;
    if (!MOVES[from].includes(to)) return { ok: false, message: `A ${from} order cannot be marked ${to}.` };
    const now = new Date();
    const moved = await tx.purchaseOrder.updateMany({
      where: { id: orderId, storeId, status: from },
      data: { status: to, cancelledAt: now },
    });
    if (moved.count !== 1) return { ok: false, message: "This order just changed. Reload the page." };
    await tx.auditLog.create(audit(storeId, actor, `purchase_order.${to}`, orderId, { status: from }, { status: to }));
    return { ok: true };
  });
}

export type StockMode = "counted" | "status";
/** One ticked line: the quantity that came for a counted listing (null for a status listing), and the stock mode the owner saw. */
export type ReceivedLine = { lineId: string; quantity: number | null; stockMode: StockMode };
export type RejectReason = "archived" | "stock_mode_changed" | "too_large";
export type ReceiveResult =
  | { ok: true; received: number; rejected: Array<{ lineId: string; name: string; reason: RejectReason }> }
  | { ok: false; message: string };

/**
 * The owner's one tap on a sent order: each ticked line goes through the copilot's stock write keyed
 * `po-receipt:<lineId>` (a counted listing is restocked, a status listing becomes in_stock), and the order
 * is received. A line on an archived listing, or one whose stock mode changed since the owner looked, is
 * rejected and listed; the rest still go in. Unticked lines did not come. Callers authenticate the owner.
 */
export async function receivePurchaseOrder(storeId: string, orderId: string, lines: ReceivedLine[], actor: Actor): Promise<ReceiveResult> {
  if (lines.length === 0) return { ok: false, message: "Tick what came in." };
  for (const line of lines) {
    const q = line.quantity;
    if (line.stockMode === "counted" && (q === null || !Number.isInteger(q) || q < 1 || q > QUANTITY_MAX)) {
      return { ok: false, message: `Quantities are whole numbers, 1 to ${QUANTITY_MAX}.` };
    }
  }
  const peek = await storeScoped(storeId).purchaseOrder.findFirst({
    where: { id: orderId, storeId },
    select: { lines: { select: { listingId: true } } },
  });
  if (!peek) return { ok: false, message: "That order is not in your store." };
  const listingIds = [...new Set(peek.lines.map((line) => line.listingId))].sort();

  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    for (const listingId of listingIds) await lockListingRow(tx, listingId);
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, storeId },
      select: { status: true, lines: { select: { id: true, listingId: true, name: true } } },
    });
    if (!order) return { ok: false, message: "That order is not in your store." };
    if (order.status !== "sent") return { ok: false, message: order.status === "received" ? "This order was already received." : "Only a sent order can be received." };
    const onOrder = new Map(order.lines.map((line) => [line.id, line]));
    if (lines.some((line) => !onOrder.has(line.lineId)) || new Set(lines.map((line) => line.lineId)).size !== lines.length) {
      return { ok: false, message: "A line is no longer on this order. Reload the page." };
    }

    const now = new Date();
    const moved = await tx.purchaseOrder.updateMany({ where: { id: orderId, storeId, status: "sent" }, data: { status: "received", receivedAt: now } });
    if (moved.count !== 1) return { ok: false, message: "This order just changed. Reload the page." };

    const received: ReceivedLine[] = [];
    const rejected: Array<{ lineId: string; name: string; reason: RejectReason }> = [];
    for (const line of lines) {
      const { listingId, name } = onOrder.get(line.lineId)!;
      const listing = await tx.listing.findUnique({ where: { id: listingId }, include: { masterProduct: { select: { name: true } } } });
      const quantity = line.quantity ?? 0;
      const reason: RejectReason | null = !listing || !listing.active ? "archived"
        : listing.stockMode !== line.stockMode ? "stock_mode_changed"
          : line.stockMode === "counted" && (listing.qty ?? 0) + quantity > QTY_COLUMN_MAX ? "too_large"
            : null;
      if (reason) {
        rejected.push({ lineId: line.lineId, name, reason });
        continue;
      }
      await writeStockChange(tx, storeId, listing!, {
        kind: line.stockMode === "counted" ? "restock" : "set_status",
        quantity,
        statusValue: "in_stock",
      }, actor, `po-receipt:${line.lineId}`, { purchaseOrderId: orderId }, now);
      received.push(line);
    }
    await tx.auditLog.create(audit(storeId, actor, "purchase_order.received", orderId, { status: "sent" }, {
      status: "received",
      lines: received.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
      rejected: rejected.map((line) => ({ lineId: line.lineId, reason: line.reason })),
    }));
    return { ok: true, received: received.length, rejected };
  }, WRITE_TRANSACTION);
}

const STATUS_RANK: Record<PoStatus, number> = { draft: 0, sent: 1, received: 2, cancelled: 3 };

/** Drafts first, then sent, received and cancelled; up to 100 newest. */
export async function listPurchaseOrders(storeId: string): Promise<PurchaseOrderView[]> {
  const rows = await storeScoped(storeId).purchaseOrder.findMany({
    where: { storeId },
    orderBy: { number: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      status: true,
      sentVia: true,
      sentAt: true,
      createdAt: true,
      supplier: { select: { id: true, name: true, channel: true, email: true, phone: true, leadDays: true } },
      lines: {
        orderBy: { position: "asc" },
        select: { id: true, listingId: true, name: true, quantity: true, listing: { select: { stockMode: true } } },
      },
    },
  });
  return rows
    .map((row) => ({
      ...row,
      status: row.status as PoStatus,
      sentVia: row.sentVia as SupplierChannel | null,
      supplier: { ...row.supplier, channel: row.supplier.channel as SupplierChannel },
      lines: row.lines.map(({ listing, ...line }) => ({ ...line, stockMode: listing.stockMode as StockMode })),
    }))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.supplier.name.localeCompare(b.supplier.name) || b.number - a.number);
}


export type PrefillResult = { ok: true; lines: Record<string, number>; unmatched: string[] } | { ok: false; message: string };

/**
 * Invoice lines read by the copilot's reader (#21), matched to this order's lines through the copilot's
 * listing search. Only fills the form: nothing is written until the owner confirms the receipt.
 */
export async function invoicePrefill(storeId: string, orderId: string, items: ExtractedItem[]): Promise<PrefillResult> {
  const order = await storeScoped(storeId).purchaseOrder.findFirst({
    where: { id: orderId, storeId },
    select: { status: true, lines: { select: { id: true, listingId: true } } },
  });
  if (!order) return { ok: false, message: "That order is not in your store." };
  if (order.status !== "sent") return { ok: false, message: "Only a sent order can be received." };
  const lineOf = new Map(order.lines.map((line) => [line.listingId, line.id]));
  const lines: Record<string, number> = {};
  const unmatched: string[] = [];
  for (const item of items) {
    const match = await matchReportItem(storeId, item);
    const lineId = match ? lineOf.get(match.listingId) : undefined;
    if (!lineId || item.quantity === null) unmatched.push(item.name);
    else lines[lineId] = Math.min(QUANTITY_MAX, (lines[lineId] ?? 0) + item.quantity);
  }
  return { ok: true, lines, unmatched };
}
