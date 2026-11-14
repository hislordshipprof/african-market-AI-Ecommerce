import { platformAdminTransaction } from "../db";
import { capturedApplicationFee } from "../order/platform-fee";
import { requirePlatformAdmin } from "./session";

export const ORDER_VIEW_ACTION = "platform.order_view";

export type OrderTimelineEntry = { at: Date; label: string; actorEmail: string | null };

export type OrderDetail = {
  id: string;
  number: number;
  status: string;
  fulfillment: string;
  createdAt: Date;
  store: { id: string; name: string; timezone: string };
  customer: { name: string; email: string | null; phone: string | null };
  deliveryAddress: string | null;
  /** Last four characters only: the full token opens the customer's tracking page. */
  trackingTokenHint: string | null;
  payment: {
    paymentIntentId: string | null;
    subtotalCents: number;
    tipCents: number;
    deliveryFeeCents: number;
    serviceFeeCents: number;
    authorizedCents: number;
    /** What Stripe captured, kept after a refund or cancellation; null with `capturedAt` set when the amount was not recorded. */
    capturedCents: number | null;
    capturedAt: Date | null;
    applicationFeeCents: number | null;
    /** Refund requests Stripe reports as succeeded. */
    refundedCents: number;
  };
  lines: Array<{
    id: string;
    name: string;
    variantLabel: string;
    qtyOrdered: number;
    qtyPicked: number;
    unitPriceCents: number;
    status: string;
    swapRule: string;
    substitutedName: string | null;
    substitutedVariantLabel: string | null;
    substitutedUnitPriceCents: number | null;
  }>;
  timeline: OrderTimelineEntry[];
  refundRequests: Array<{
    id: string;
    amountCents: number;
    state: string;
    providerStatus: string | null;
    providerRefundId: string | null;
    serviceFeeShareCents: number;
    createdAt: Date;
  }>;
  deliveries: Array<{
    id: string;
    provider: string;
    externalId: string;
    status: string;
    quoteFeeCents: number;
    actualFeeCents: number | null;
    trackingUrl: string | null;
    createdAt: Date;
  }>;
  issueReports: Array<{ id: string; type: string; state: string; amountCents: number; note: string | null; createdAt: Date }>;
  supportThread: {
    id: string;
    topic: string;
    state: string;
    escalatedAt: Date | null;
    /** Escalated and not resolved: the thread is in the Messages queue, where the platform can reply. */
    inPlatformQueue: boolean;
    messages: Array<{ id: string; sender: string; body: string; createdAt: Date }>;
  } | null;
};

export function trackingTokenHint(token: string | null): string | null {
  return token && token.length > 8 ? `…${token.slice(-4)}` : token ? "…" : null;
}

const variantSelect = { label: true, listing: { select: { customName: true, masterProduct: { select: { name: true } } } } } as const;

const productName = (variant: { listing: { customName: string | null; masterProduct: { name: string } | null } }) =>
  variant.listing.customName ?? variant.listing.masterProduct?.name ?? "Item";

const MILESTONES = [
  ["createdAt", "Placed"],
  ["acceptedAt", "Accepted"],
  ["readyAt", "Ready"],
  ["outForDeliveryAt", "Out for delivery"],
  ["deliveredAt", "Delivered"],
  ["completedAt", "Completed"],
  ["cancelledAt", "Cancelled"],
] as const;

/**
 * One order across stores for a platform admin. The view's audit row is written in the same transaction,
 * before anything is read, so no customer data is returned without it. An unknown id writes nothing.
 */
async function readOrderDetail(orderId: string, admin: { id: string; email: string }): Promise<OrderDetail | null> {
  return platformAdminTransaction(async (tx) => {
    const found = await tx.order.findUnique({ where: { id: orderId }, select: { storeId: true } });
    if (!found) return null;
    await tx.auditLog.create({
      data: { storeId: found.storeId, actorId: admin.id, actorEmail: admin.email, action: ORDER_VIEW_ACTION, entityType: "order", entityId: orderId },
    });

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        store: { select: { id: true, name: true, timezone: true } },
        customer: { select: { name: true, email: true, phone: true } },
        lines: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: { listingVariant: { select: variantSelect }, substitutedVariant: { select: variantSelect } },
        },
        refundRequests: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        deliveries: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        issueReports: { orderBy: { createdAt: "asc" } },
        supportThreads: { include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } },
      },
    });
    const audits = await tx.auditLog.findMany({
      where: { entityType: "order", entityId: orderId, storeId: order.storeId, action: { not: ORDER_VIEW_ACTION } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { action: true, actorEmail: true, createdAt: true },
    });

    const timeline: OrderTimelineEntry[] = [
      ...MILESTONES.flatMap(([field, label]) => {
        const at = order[field];
        return at ? [{ at, label, actorEmail: null }] : [];
      }),
      ...audits.map((row) => ({ at: row.createdAt, label: row.action, actorEmail: row.actorEmail })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    const thread = order.supportThreads[0] ?? null;
    const address = [order.deliveryLine1, order.deliveryLine2, order.deliveryCity, order.deliveryState, order.deliveryZip]
      .filter(Boolean)
      .join(", ");

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      fulfillment: order.fulfillment,
      createdAt: order.createdAt,
      store: order.store,
      customer: order.customer,
      deliveryAddress: address || null,
      trackingTokenHint: trackingTokenHint(order.trackingToken),
      payment: {
        paymentIntentId: order.paymentIntentId,
        subtotalCents: order.subtotalCents,
        tipCents: order.tipCents,
        deliveryFeeCents: order.deliveryFeeCents,
        serviceFeeCents: order.serviceFeeCents,
        authorizedCents: order.totalAuthorizedCents,
        capturedCents: order.captureCents,
        capturedAt: order.capturedAt,
        applicationFeeCents: capturedApplicationFee({ ...order, capturedAmountCents: order.captureCents }),
        refundedCents: order.refundRequests
          .filter((request) => request.providerStatus === "succeeded")
          .reduce((sum, request) => sum + request.amountCents, 0),
      },
      lines: order.lines.map((line) => ({
        id: line.id,
        name: productName(line.listingVariant),
        variantLabel: line.listingVariant.label,
        qtyOrdered: line.qtyOrdered,
        qtyPicked: line.qtyPicked,
        unitPriceCents: line.unitPriceCents,
        status: line.status,
        swapRule: line.swapRule,
        substitutedName: line.substitutedVariant ? productName(line.substitutedVariant) : null,
        substitutedVariantLabel: line.substitutedVariant?.label ?? null,
        substitutedUnitPriceCents: line.substitutedUnitPriceCents,
      })),
      timeline,
      refundRequests: order.refundRequests.map((request) => ({
        id: request.id,
        amountCents: request.amountCents,
        state: request.state,
        providerStatus: request.providerStatus,
        providerRefundId: request.providerRefundId,
        serviceFeeShareCents: request.serviceFeeShareCents,
        createdAt: request.createdAt,
      })),
      deliveries: order.deliveries.map((delivery) => ({
        id: delivery.id,
        provider: delivery.provider,
        externalId: delivery.externalId,
        status: delivery.status,
        quoteFeeCents: delivery.quoteFeeCents,
        actualFeeCents: delivery.actualFeeCents,
        trackingUrl: delivery.trackingUrl,
        createdAt: delivery.createdAt,
      })),
      issueReports: order.issueReports.map((issue) => ({
        id: issue.id,
        type: issue.type,
        state: issue.state,
        amountCents: issue.amountCents,
        note: issue.note,
        createdAt: issue.createdAt,
      })),
      supportThread: thread && {
        id: thread.id,
        topic: thread.topic,
        state: thread.state,
        escalatedAt: thread.escalatedAt,
        inPlatformQueue: thread.escalatedAt !== null && thread.state !== "resolved",
        messages: thread.messages.map((message) => ({ id: message.id, sender: message.sender, body: message.body, createdAt: message.createdAt })),
      },
    };
  });
}

/** The order detail page's read: platform admins only, audited per view. */
export async function viewOrderDetail(orderId: string): Promise<OrderDetail | null> {
  const session = await requirePlatformAdmin();
  return readOrderDetail(orderId, { id: session.user.id, email: session.user.email });
}
