import { storeScopedTransaction, storeScoped } from "../db";

export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "READY"
  | "AWAITING_PICKUP"
  | "COMPLETED"
  | "CANCELLED";

export type OrderLineStatus =
  | "pending"
  | "picked"
  | "short"
  | "refunded"
  | "substituted";

const ACTIVE_STATUSES: OrderStatus[] = [
  "AUTHORIZED",
  "ACCEPTED",
  "PICKING",
  "READY",
  "AWAITING_PICKUP",
];

export async function getStoreOrders(storeId: string) {
  const scoped = storeScoped(storeId);
  return scoped.order.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    include: {
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
    },
    orderBy: { createdAt: "desc" },
  });
}

export type StoreOrderRow = Awaited<ReturnType<typeof getStoreOrders>>[number];

export async function getOrderById(storeId: string, orderId: string) {
  const scoped = storeScoped(storeId);
  return scoped.order.findUnique({
    where: { id: orderId },
    include: {
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
    },
  });
}

export async function acceptOrder(
  storeId: string,
  orderId: string,
  prepEstimateMinutes: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "AUTHORIZED") {
      return { ok: false, error: `Cannot accept order in status ${order.status}` };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "ACCEPTED",
        prepEstimateMinutes: prepEstimateMinutes,
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
    const lines = await tx.orderLine.findMany({ where: { id: lineId } });
    const line = lines[0];
    if (!line) return { ok: false, error: "Order line not found" };

    const order = await tx.order.findUnique({ where: { id: line.orderId } });
    if (!order) return { ok: false, error: "Order not found" };
    if (order.status !== "ACCEPTED" && order.status !== "PICKING") {
      return { ok: false, error: `Cannot pick lines for order in status ${order.status}` };
    }

    await tx.orderLine.update({
      where: { id: lineId },
      data: { status: "picked", qtyPicked: line.qtyOrdered },
    });

    const allLines = await tx.orderLine.findMany({
      where: { orderId: line.orderId },
    });

    const allResolved = allLines.every((l) =>
      l.id === lineId ? true : l.status !== "pending",
    );

    let newStatus: OrderStatus = order.status === "ACCEPTED" ? "PICKING" : order.status as OrderStatus;

    if (allResolved) {
      newStatus = order.fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: newStatus,
          readyAt: new Date(),
        },
      });
    } else if (order.status === "ACCEPTED") {
      newStatus = "PICKING";
      await tx.order.update({
        where: { id: order.id },
        data: { status: "PICKING" },
      });
    }

    return { ok: true, orderStatus: newStatus };
  });
}

export async function completePickup(
  storeId: string,
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return storeScopedTransaction(storeId, async (tx) => {
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

export interface PickListLine {
  id: string;
  productName: string;
  variantLabel: string;
  qtyOrdered: number;
  qtyPicked: number;
  status: string;
  frozen: boolean;
  perishable: boolean;
}

export function sortPickListLines<T extends { frozen: boolean; perishable: boolean }>(
  lines: T[],
): T[] {
  return [...lines].sort((a, b) => {
    const tierA = a.frozen ? 2 : a.perishable ? 1 : 0;
    const tierB = b.frozen ? 2 : b.perishable ? 1 : 0;
    return tierA - tierB;
  });
}
