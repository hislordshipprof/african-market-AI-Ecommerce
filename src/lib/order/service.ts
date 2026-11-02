import { storeScopedTransaction, lockStoreRow } from "../db";
import { getStripeProvider } from "../stripe";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";
import { RESOLVED_LINE_STATUSES, type OrderLineStatus } from "./constants";
export type { OrderLineStatus } from "./constants";

export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "READY"
  | "AWAITING_PICKUP"
  | "COMPLETED"
  | "CANCELLED";

const ACTIVE_STATUSES: OrderStatus[] = [
  "AUTHORIZED",
  "ACCEPTED",
  "PICKING",
  "READY",
  "AWAITING_PICKUP",
];

const ORDER_WITH_LINES = {
  customer: { select: { name: true, phone: true } },
  lines: {
    include: {
      listingVariant: {
        include: {
          listing: {
            select: {
              id: true,
              customName: true,
              frozen: true,
              perishable: true,
              masterProduct: { select: { name: true } },
            },
          },
        },
      },
    },
  },
} as const;

export async function getStoreOrders(storeId: string) {
  return storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      include: ORDER_WITH_LINES,
      orderBy: { createdAt: "desc" },
    });
  });
}

export type StoreOrderRow = Awaited<ReturnType<typeof getStoreOrders>>[number];

export async function acceptOrder(
  storeId: string,
  orderId: string,
  prepEstimateMinutes: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clamped = Math.max(1, Math.min(120, Math.round(prepEstimateMinutes)));
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AUTHORIZED") {
      return { ok: false, error: `Cannot accept order in status ${order.status}` };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "ACCEPTED",
        prepEstimateMinutes: clamped,
        acceptedAt: new Date(),
      },
    });

    return { ok: true };
  });
}

export async function markLinePicked(
  storeId: string,
  lineId: string,
): Promise<{ ok: true; orderStatus: OrderStatus } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);

    const lines = await tx.orderLine.findMany({ where: { id: lineId } });
    const line = lines[0];
    if (!line) return { ok: false, error: "Order line not found" };
    if (line.status !== "pending") {
      return { ok: false, error: `Line already resolved (${line.status})` };
    }

    const order = await tx.order.findUnique({ where: { id: line.orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "ACCEPTED" && order.status !== "PICKING") {
      return { ok: false, error: `Cannot pick lines for order in status ${order.status}` };
    }

    await tx.orderLine.update({
      where: { id: lineId },
      data: { status: "picked", qtyPicked: line.qtyOrdered },
    });

    if (order.status === "ACCEPTED") {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "PICKING" },
      });
    }

    return { ok: true, orderStatus: "PICKING" };
  });
}

export async function markReady(
  storeId: string,
  orderId: string,
): Promise<{ ok: true; capturedAmountCents: number } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "PICKING") {
      return { ok: false, error: `Cannot mark ready for order in status ${order.status}` };
    }

    const lines = await tx.orderLine.findMany({ where: { orderId } });

    const unresolvedLines = lines.filter(
      (l: { status: string }) => !RESOLVED_LINE_STATUSES.includes(l.status as OrderLineStatus),
    );
    if (unresolvedLines.length > 0) {
      return { ok: false, error: "Cannot mark ready: unresolved order lines remain" };
    }

    const lineTotalCents = lines.reduce((sum: number, l: { status: string; qtyPicked: number; unitPriceCents: number }) => {
      if (l.status === "refunded") return sum;
      return sum + l.qtyPicked * l.unitPriceCents;
    }, 0);

    const capturedAmountCents = lineTotalCents + order.tipCents + order.deliveryFeeCents;

    if (capturedAmountCents > order.totalAuthorizedCents) {
      return {
        ok: false,
        error: `Capture amount ${capturedAmountCents} exceeds authorized amount ${order.totalAuthorizedCents}`,
      };
    }

    if (!order.paymentIntentId) {
      return { ok: false, error: "Order has no payment intent" };
    }

    const stripe = getStripeProvider();
    await stripe.capturePaymentIntent(
      order.paymentIntentId,
      capturedAmountCents,
      `capture:${orderId}`,
    );

    // Pickup → AWAITING_PICKUP per spec §4.3 (READY → AWAITING_PICKUP for pickup)
    const newStatus: OrderStatus =
      order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        readyAt: new Date(),
        capturedAmountCents,
      },
    });

    return { ok: true, capturedAmountCents };
  });
}

export async function completePickup(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AWAITING_PICKUP") {
      return { ok: false, error: `Cannot complete pickup for order in status ${order.status}` };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    return { ok: true };
  });
}

export async function autoCancelOrder(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AUTHORIZED") {
      return { ok: false, error: `Order is in status ${order.status}, not AUTHORIZED` };
    }

    if (order.paymentIntentId) {
      const stripe = getStripeProvider();
      await stripe.cancelPaymentIntent(
        order.paymentIntentId,
        `cancel:${orderId}`,
      );
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });

    const lines = await tx.orderLine.findMany({ where: { orderId } });

    const variantIds = lines.map((l: { listingVariantId: string }) => l.listingVariantId);
    const variants = await tx.listingVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, listingId: true },
    });
    const variantToListing = new Map(variants.map((v: { id: string; listingId: string }) => [v.id, v.listingId]));

    const stockEventData = lines
      .map((line: { listingVariantId: string; qtyOrdered: number }) => {
        const listingId = variantToListing.get(line.listingVariantId);
        if (!listingId) return null;
        return {
          storeId,
          listingId,
          type: "cancel_restore" as const,
          delta: line.qtyOrdered,
          actorId: SYSTEM_ACTOR_ID,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    if (stockEventData.length > 0) {
      await tx.stockEvent.createMany({ data: stockEventData });
    }

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "auto_cancel",
        entityType: "order",
        entityId: orderId,
      },
    });

    return { ok: true };
  });
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
