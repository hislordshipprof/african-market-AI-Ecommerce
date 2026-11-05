"use server";

import { revalidatePath } from "next/cache";
import { lockStoreRow, platformAdminTransaction, storeScopedTransaction } from "../db";
import { requirePlatformAdmin } from "./session";
import { getStripeProvider } from "../stripe";

export type RefundFailedRow = {
  orderId: string;
  storeName: string;
  orderNumber: number;
  capturedCents: number;
  refundedCents: number;
  owedCents: number;
  failedRefundId: string;
  failedAtLabel: string;
};

function failedAtLabel(at: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
  return `${formatted} (${timeZone})`;
}

async function capturedCentsFor(order: {
  capturedAmountCents: number | null;
  paymentIntentId: string | null;
}): Promise<number> {
  if (order.capturedAmountCents != null) return order.capturedAmountCents;
  if (!order.paymentIntentId) return 0;
  try {
    const pi = await getStripeProvider().retrievePaymentIntent(order.paymentIntentId);
    return pi.amountReceived;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "resource_missing") return 0;
    throw err;
  }
}

async function succeededRefundCents(paymentIntentId: string | null): Promise<number> {
  if (!paymentIntentId) return 0;
  try {
    const listed = await getStripeProvider().listRefunds(paymentIntentId);
    return listed
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountRefunded, 0);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "resource_missing") return 0;
    throw err;
  }
}

export async function listRefundFailedOrders(): Promise<RefundFailedRow[]> {
  await requirePlatformAdmin();
  const orders = await platformAdminTransaction((tx) =>
    tx.order.findMany({
      where: { status: "REFUND_FAILED" },
      include: { store: { select: { name: true, timezone: true } } },
      orderBy: { updatedAt: "asc" },
    }),
  );
  const failures = orders.length
    ? await platformAdminTransaction((tx) =>
        tx.auditLog.findMany({
          where: { entityId: { in: orders.map((order) => order.id) }, action: "refund_failed" },
          orderBy: { createdAt: "desc" },
        }),
      )
    : [];
  const failureByOrder = new Map<string, (typeof failures)[number]>();
  for (const failure of failures) {
    if (!failureByOrder.has(failure.entityId)) failureByOrder.set(failure.entityId, failure);
  }
  const rows: RefundFailedRow[] = [];
  for (const order of orders) {
    const failure = failureByOrder.get(order.id);
    const capturedCents = await capturedCentsFor(order);
    const refundedCents = await succeededRefundCents(order.paymentIntentId);
    rows.push({
      orderId: order.id,
      storeName: order.store.name,
      orderNumber: order.number,
      capturedCents,
      refundedCents,
      owedCents: capturedCents - refundedCents,
      failedRefundId: order.refundId ?? "",
      failedAtLabel: failedAtLabel(failure?.createdAt ?? order.updatedAt, order.store.timezone),
    });
  }
  return rows;
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; error: string; fieldError?: string };

export async function resolveRefundFailed(orderId: string, note: string): Promise<ResolveResult> {
  const session = await requirePlatformAdmin();
  const trimmed = note.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    return { ok: false, error: "Note must be 1–500 characters.", fieldError: "Note must be 1–500 characters." };
  }

  const order = await platformAdminTransaction((tx) => tx.order.findUnique({ where: { id: orderId } }));
  if (!order || order.status !== "REFUND_FAILED") {
    return { ok: false, error: "already resolved" };
  }

  return storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status !== "REFUND_FAILED") {
      return { ok: false as const, error: "already resolved" };
    }
    const openRefund = await tx.auditLog.findFirst({
      where: { entityId: orderId, action: "refund_retry" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const openAfter = openRefund?.after as { inFlight?: boolean } | null;
    if (openAfter?.inFlight === true) {
      return { ok: false as const, error: "A refund is still confirming with the bank" };
    }
    const existing = current.notes?.trim();
    const notes = existing ? `${existing}\n${trimmed}` : trimmed;
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: "REFUND_FAILED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), notes },
    });
    if (updated.count !== 1) return { ok: false as const, error: "already resolved" };
    await tx.auditLog.create({
      data: {
        storeId: order.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "refund_resolved_manually",
        entityType: "order",
        entityId: orderId,
        after: { note: trimmed, refundId: order.refundId, alert: "store" },
      },
    });
    return { ok: true as const };
  }).then((result) => {
    if (result.ok) revalidatePath("/admin/orders");
    return result;
  });
}

export async function resolveRefundFailedAction(
  _prev: ResolveResult | null,
  formData: FormData,
): Promise<ResolveResult> {
  return resolveRefundFailed(String(formData.get("orderId") ?? ""), String(formData.get("note") ?? ""));
}
