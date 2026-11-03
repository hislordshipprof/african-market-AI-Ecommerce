import { storeScopedTransaction, lockStoreRow } from "../db";
import { getStripeProvider } from "../stripe";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";
import { RESOLVED_LINE_STATUSES, type OrderLineStatus } from "./constants";
export type { OrderLineStatus } from "./constants";

export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "CANCELLING"
  | "CAPTURING"
  | "READY"
  | "AWAITING_PICKUP"
  | "COMPLETED"
  | "CANCELLED";

// Stripe USD minimum capture: $0.50 (50 cents).
// https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const STRIPE_USD_MINIMUM_CENTS = 50;

const ACTIVE_STATUSES: OrderStatus[] = [
  "AUTHORIZED",
  "ACCEPTED",
  "PICKING",
  "CAPTURING",
  "CANCELLING",
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
  // Phase 1: claim with CAPTURING inside transaction (blocks concurrent changes)
  const validation = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found" };
    if (order.status === "CAPTURING") {
      return {
        ok: true as const,
        capturedAmountCents: order.capturedAmountCents ?? 0,
        paymentIntentId: order.paymentIntentId!,
        newStatus: (order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY") as OrderStatus,
        alreadyClaiming: true,
      };
    }
    if (order.status !== "PICKING") {
      return { ok: false as const, error: `Cannot mark ready for order in status ${order.status}` };
    }

    const lines = await tx.orderLine.findMany({ where: { orderId } });

    const unresolvedLines = lines.filter(
      (l: { status: string }) => !RESOLVED_LINE_STATUSES.includes(l.status as OrderLineStatus),
    );
    if (unresolvedLines.length > 0) {
      return { ok: false as const, error: "Cannot mark ready: unresolved order lines remain" };
    }

    const lineTotalCents = lines.reduce((sum: number, l: { status: string; qtyPicked: number; unitPriceCents: number }) => {
      if (l.status === "refunded") return sum;
      return sum + l.qtyPicked * l.unitPriceCents;
    }, 0);

    const capturedAmountCents = lineTotalCents + order.tipCents + order.deliveryFeeCents;

    if (!order.paymentIntentId) {
      return { ok: false as const, error: "Order has no payment intent" };
    }

    // Stripe USD minimum capture is 50 cents ($0.50).
    // https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
    if (capturedAmountCents < STRIPE_USD_MINIMUM_CENTS) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLING" },
      });
      return {
        ok: true as const,
        capturedAmountCents,
        paymentIntentId: order.paymentIntentId,
        newStatus: "CANCELLED" as OrderStatus,
        alreadyClaiming: false,
        voidInsteadOfCapture: true,
        orderId: order.id,
        storeId,
      };
    }

    if (capturedAmountCents > order.totalAuthorizedCents) {
      return {
        ok: false as const,
        error: `Capture amount ${capturedAmountCents} exceeds authorized amount ${order.totalAuthorizedCents}`,
      };
    }

    const newStatus: OrderStatus =
      order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CAPTURING", capturedAmountCents },
    });

    return {
      ok: true as const,
      capturedAmountCents,
      paymentIntentId: order.paymentIntentId,
      newStatus,
      alreadyClaiming: false,
      voidInsteadOfCapture: false,
      orderId: order.id,
      storeId,
    };
  });

  if (!validation.ok) return validation;

  // K3: below-minimum amount — void the authorization instead of capturing
  if (validation.voidInsteadOfCapture) {
    const stripe = getStripeProvider();
    await stripe.cancelPaymentIntent(
      validation.paymentIntentId,
      `cancel:${orderId}`,
    );
    await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current || current.status !== "CANCELLING") {
        return;
      }
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          capturedAmountCents: 0,
        },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "void_zero_amount",
          entityType: "order",
          entityId: orderId,
        },
      });
    });
    return { ok: true, capturedAmountCents: 0 };
  }

  // Phase 2: Stripe capture outside transaction (idempotency key makes retry safe)
  const stripe = getStripeProvider();
  await stripe.capturePaymentIntent(
    validation.paymentIntentId,
    validation.capturedAmountCents,
    `capture:${orderId}`,
  );

  // Phase 3: finalize in transaction (verify still CAPTURING)
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CAPTURING") {
      return { ok: false as const, error: "Order status changed during capture" };
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: validation.newStatus,
        readyAt: new Date(),
        capturedAmountCents: validation.capturedAmountCents,
      },
    });
    return { ok: true as const };
  });

  if (!finalize.ok) return finalize;

  return { ok: true, capturedAmountCents: validation.capturedAmountCents };
}

export async function completePickup(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AWAITING_PICKUP" && order.status !== "READY") {
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
  // Phase 1: claim with CANCELLING inside transaction (blocks acceptOrder)
  const validation = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, error: "Order not found" };
    if (order.status === "CANCELLING") {
      return { ok: true as const, paymentIntentId: order.paymentIntentId, alreadyClaiming: true };
    }
    if (order.status !== "AUTHORIZED") {
      return { ok: false as const, error: `Order is in status ${order.status}, not AUTHORIZED` };
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLING" } });
    return { ok: true as const, paymentIntentId: order.paymentIntentId, alreadyClaiming: false };
  });

  if (!validation.ok) return validation;

  // Phase 2: Stripe cancel outside transaction (idempotency key makes retry safe)
  if (validation.paymentIntentId) {
    const stripe = getStripeProvider();
    await stripe.cancelPaymentIntent(
      validation.paymentIntentId,
      `cancel:${orderId}`,
    );
  }

  // Phase 3: finalize in transaction (verify still CANCELLING)
  const finalize = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "CANCELLING") {
      return { ok: false as const, error: "Order status changed during cancellation" };
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

    return { ok: true as const };
  });

  if (!finalize.ok) return finalize;

  return { ok: true };
}

export async function reconcileStuckOrder(
  storeId: string,
  orderId: string,
): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  const order = await storeScopedTransaction(storeId, async (tx) => {
    return tx.order.findUnique({
      where: { id: orderId },
      include: { lines: true },
    });
  });

  if (!order || (order.status !== "CAPTURING" && order.status !== "CANCELLING")) {
    return { ok: true, action: "already_resolved" };
  }

  if (!order.paymentIntentId) {
    return { ok: false, error: "Order has no payment intent" };
  }

  const stripe = getStripeProvider();
  const pi = await stripe.retrievePaymentIntent(order.paymentIntentId);

  if (pi.status === "succeeded") {
    return finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, pi.amountReceived);
  }

  if (pi.status === "canceled") {
    return finalizeCancelFromSweep(storeId, orderId);
  }

  if (pi.status === "requires_capture") {
    if (order.status === "CAPTURING") {
      await stripe.capturePaymentIntent(
        order.paymentIntentId,
        order.capturedAmountCents ?? 0,
        `capture:${orderId}`,
      );
      return finalizeCaptureFromSweep(storeId, orderId, order.fulfillment, order.capturedAmountCents ?? 0);
    } else {
      await stripe.cancelPaymentIntent(order.paymentIntentId, `cancel:${orderId}`);
      return finalizeCancelFromSweep(storeId, orderId);
    }
  }

  return { ok: true, action: "unknown_stripe_status" };
}

async function finalizeCaptureFromSweep(
  storeId: string,
  orderId: string,
  fulfillment: string,
  capturedAmountCents: number,
): Promise<{ ok: true; action: string }> {
  const newStatus: OrderStatus =
    fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || (current.status !== "CAPTURING" && current.status !== "CANCELLING")) return;

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        readyAt: new Date(),
        capturedAmountCents,
      },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "reconcile_capture",
        entityType: "order",
        entityId: orderId,
      },
    });
  });

  return { ok: true, action: "finalized_capture" };
}

async function finalizeCancelFromSweep(
  storeId: string,
  orderId: string,
): Promise<{ ok: true; action: string }> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { lines: true },
    });
    if (!order || (order.status !== "CAPTURING" && order.status !== "CANCELLING")) return;

    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    const lines = order.lines;
    const variantIds = lines.map((l: { listingVariantId: string }) => l.listingVariantId);
    const variants = await tx.listingVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, listingId: true },
    });
    const variantToListing = new Map(
      variants.map((v: { id: string; listingId: string }) => [v.id, v.listingId]),
    );

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
        action: "reconcile_cancel",
        entityType: "order",
        entityId: orderId,
      },
    });
  });

  return { ok: true, action: "finalized_cancel" };
}

export { sortPickListLines } from "./pick-sort";
export { RESOLVED_LINE_STATUSES } from "./constants";
