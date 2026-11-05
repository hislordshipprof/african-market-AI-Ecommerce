"use server";

import { revalidatePath } from "next/cache";
import { lockStoreRow, platformAdminTransaction, storeScopedTransaction } from "../db";
import { requirePlatformAdmin } from "./session";
import { getStripeProvider } from "../stripe";
import { findOpenRefundRequest, openRefundRequest, reconcileOpenRefundRequests } from "../order/refund-requests";

export type RefundFailedRow = {
  orderId: string;
  storeName: string;
  orderNumber: number;
  capturedCents: number;
  refundedCents: number;
  owedCents: number;
  failedRefundId: string;
  failedAtLabel: string;
  bankRefundPending: boolean;
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

function refundStillOpen(status: string): boolean {
  return status === "pending" || status === "requires_action";
}

async function refundBalance(paymentIntentId: string | null): Promise<{
  refundedCents: number;
  bankRefundPending: boolean;
  listed: { refundId: string; status: string }[];
}> {
  if (!paymentIntentId) return { refundedCents: 0, bankRefundPending: false, listed: [] };
  try {
    const listed = await getStripeProvider().listRefunds(paymentIntentId);
    return {
      refundedCents: listed
        .filter((refund) => refund.status === "succeeded")
        .reduce((sum, refund) => sum + refund.amountRefunded, 0),
      bankRefundPending: listed.some((refund) => refundStillOpen(refund.status)),
      listed,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "resource_missing") return { refundedCents: 0, bankRefundPending: false, listed: [] };
    return { refundedCents: 0, bankRefundPending: true, listed: [] };
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
    const balance = await refundBalance(order.paymentIntentId);
    const reservation = await findOpenRefundRequest(order.storeId, order.id);
    const matched = reservation?.providerRefundId
      ? balance.listed.find((refund) => refund.refundId === reservation.providerRefundId)
      : undefined;
    const reservationOpen = !!reservation && (reservation.state !== "CREATED" || !matched || refundStillOpen(matched.status));
    rows.push({
      orderId: order.id,
      storeName: order.store.name,
      orderNumber: order.number,
      capturedCents,
      refundedCents: balance.refundedCents,
      owedCents: capturedCents - balance.refundedCents,
      failedRefundId: order.refundId ?? "",
      failedAtLabel: failedAtLabel(failure?.createdAt ?? order.updatedAt, order.store.timezone),
      bankRefundPending: balance.bankRefundPending || reservationOpen,
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
  if (order.paymentIntentId) await reconcileOpenRefundRequests(order.storeId, order.id);
  const balance = await refundBalance(order.paymentIntentId);
  const capturedCents = order.paymentIntentId
    ? await capturedCentsFor(order)
    : (order.capturedAmountCents ?? 0);

  return storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status !== "REFUND_FAILED") {
      return { ok: false as const, error: "already resolved" };
    }
    if (balance.bankRefundPending || await openRefundRequest(tx, orderId)) {
      return { ok: false as const, error: "A refund is still confirming with the bank" };
    }
    const existing = current.notes?.trim();
    const notes = existing ? `${existing}\n${trimmed}` : trimmed;
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: "REFUND_FAILED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), notes },
    });
    if (updated.count !== 1) return { ok: false as const, error: "already resolved" };
    const repaidCents = Math.max(0, capturedCents - balance.refundedCents);
    await tx.auditLog.create({
      data: {
        storeId: order.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "refund_resolved_manually",
        entityType: "order",
        entityId: orderId,
        after: {
          note: trimmed,
          refundId: order.refundId,
          alert: "store",
          repaidCents,
          refundedCents: balance.refundedCents,
          capturedCents,
        },
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
