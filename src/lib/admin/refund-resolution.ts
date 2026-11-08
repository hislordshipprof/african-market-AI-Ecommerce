"use server";

import { revalidatePath } from "next/cache";
import { lockStoreRow, platformAdminTransaction, storeScopedTransaction } from "../db";
import { z } from "zod";
import { requirePlatformAdmin } from "./session";
import { parseRepaidDollars } from "./repaid-dollars";
import { parseInput, readFormFields } from "../security/parse-input";
import { getStripeProvider } from "../stripe";
import { findOpenRefundRequest, reconcileOpenRefundRequests, requestIsOpen } from "../order/refund-requests";
import { releaseOrderStock } from "../order/stock-ledger";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
import { failedAtLabel } from "./failed-at";

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

function recordedRefundId(after: unknown): string | undefined {
  if (!after || typeof after !== "object" || Array.isArray(after)) return undefined;
  const id = (after as { refundId?: unknown }).refundId;
  return typeof id === "string" ? id : undefined;
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

type RefundObservation = {
  refundedCents: number;
  pendingCents: number;
  bankRefundPending: boolean;
  refundIds: string[];
  countedRefundIds: string[];
  listed: { refundId: string; status: string; amountRefunded: number }[];
};

function observeRefunds(listed: { refundId: string; status: string; amountRefunded: number }[]): RefundObservation {
  const succeeded = listed.filter((refund) => refund.status === "succeeded");
  const pendingCents = listed
    .filter((refund) => refundStillOpen(refund.status))
    .reduce((sum, refund) => sum + refund.amountRefunded, 0);
  return {
    refundedCents: succeeded.reduce((sum, refund) => sum + refund.amountRefunded, 0),
    pendingCents,
    bankRefundPending: listed.some((refund) => refundStillOpen(refund.status)),
    refundIds: listed.map((refund) => refund.refundId).sort(),
    countedRefundIds: succeeded.map((refund) => refund.refundId),
    listed,
  };
}

function sameRefundObservation(left: RefundObservation, right: RefundObservation): boolean {
  return left.refundedCents === right.refundedCents
    && left.pendingCents === right.pendingCents
    && left.refundIds.join("\0") === right.refundIds.join("\0");
}

async function refundBalance(paymentIntentId: string | null): Promise<RefundObservation> {
  if (!paymentIntentId) return observeRefunds([]);
  try {
    return observeRefunds(await getStripeProvider().listRefunds(paymentIntentId));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "resource_missing") return observeRefunds([]);
    return { ...observeRefunds([]), bankRefundPending: true };
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
    const failureRows = failures.filter(
      (row) => row.entityId === order.id && recordedRefundId(row.after) === order.refundId,
    );
    const failure = failureRows[failureRows.length - 1] ?? failureByOrder.get(order.id);
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
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldError?: string };

const BALANCE_CHANGED = "The balance changed since you loaded this page. An alert was recorded.";

export async function resolveRefundFailed(
  orderId: string,
  note: string,
  repaidCents: number,
  displayedOwedCents: number,
): Promise<ResolveResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({
    orderId: z.string().max(200),
    note: z.string().max(2_000),
    repaidCents: z.number().int(),
    displayedOwedCents: z.number().int(),
  }), { orderId, note, repaidCents, displayedOwedCents });
  if (!parsed.ok) {
    return {
      ok: false,
      error: "Enter the amount you repaid, from $0.01 up to the captured amount.",
      fieldError: "Enter the amount you repaid, from $0.01 up to the captured amount.",
    };
  }
  const trimmed = parsed.data.note.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    return { ok: false, error: "Note must be 1–500 characters.", fieldError: "Note must be 1–500 characters." };
  }
  if (!Number.isInteger(repaidCents) || !Number.isInteger(displayedOwedCents) || displayedOwedCents < 0) {
    return {
      ok: false,
      error: "Enter the amount you repaid, from $0.01 up to the captured amount.",
      fieldError: "Enter the amount you repaid, from $0.01 up to the captured amount.",
    };
  }

  const order = await platformAdminTransaction((tx) => tx.order.findUnique({ where: { id: orderId } }));
  if (!order || order.status !== "REFUND_FAILED") {
    return { ok: false, error: "already resolved" };
  }
  const capturedCents = order.paymentIntentId
    ? await capturedCentsFor(order)
    : (order.capturedAmountCents ?? 0);
  if (repaidCents < 1 || repaidCents > capturedCents) {
    return {
      ok: false,
      error: "Enter the amount you repaid, from $0.01 up to the captured amount.",
      fieldError: "Enter the amount you repaid, from $0.01 up to the captured amount.",
    };
  }
  if (order.paymentIntentId) await reconcileOpenRefundRequests(order.storeId, order.id);
  const balance = await refundBalance(order.paymentIntentId);
  const openBefore = (await storeScopedTransaction(order.storeId, (tx) => tx.refundRequest.findMany({ where: { orderId } })))
    .filter((row) => requestIsOpen(row))
    .map((row) => row.id)
    .sort();

  return storeScopedTransaction(order.storeId, async (tx) => {
    await lockStoreRow(tx, order.storeId);
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status !== "REFUND_FAILED") {
      return { ok: false as const, error: "already resolved" };
    }
    let fresh = observeRefunds([]);
    if (current.paymentIntentId) {
      try {
        fresh = observeRefunds(await getStripeProvider().listRefunds(current.paymentIntentId));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "resource_missing") throw err;
      }
    }
    const openNow = (await tx.refundRequest.findMany({ where: { orderId } }))
      .filter((row) => requestIsOpen(row))
      .map((row) => row.id)
      .sort();
    if (!sameRefundObservation(balance, fresh) || openBefore.join("\0") !== openNow.join("\0")) {
      return { ok: false as const, error: "balance changed, refresh" };
    }
    if (fresh.bankRefundPending || fresh.pendingCents > 0 || openNow.length > 0) {
      return { ok: false as const, error: "A refund is still confirming with the bank" };
    }
    const existing = current.notes?.trim();
    const notes = existing ? `${existing}\n${trimmed}` : trimmed;
    const gap = fresh.refundedCents + repaidCents - capturedCents;
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: "REFUND_FAILED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), notes, capturedAmountCents: null },
    });
    if (updated.count !== 1) return { ok: false as const, error: "already resolved" };
    await releaseOrderStock(tx, order.storeId, orderId);
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
          displayedOwedCents,
          refundedCents: fresh.refundedCents,
          capturedCents,
          countedRefundIds: fresh.countedRefundIds,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        storeId: order.storeId,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "refund_resolution_baseline",
        entityType: "order",
        entityId: orderId,
        after: {
          refundedCents: fresh.refundedCents,
          countedRefundIds: fresh.countedRefundIds,
        },
      },
    });
    if (gap !== 0) {
      console.error(`Manual repayment for order ${orderId} does not match the capture. Store and platform alerted.`);
      await tx.auditLog.create({
        data: {
          storeId: order.storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: gap > 0 ? "refund_after_manual_resolution" : "refund_reversed_after_resolution",
          entityType: "order",
          entityId: orderId,
          after: gap > 0
            ? {
                refundId: fresh.countedRefundIds[0] ?? order.refundId ?? "",
                overpaidCents: gap,
                alert: "store_and_platform",
              }
            : {
                refundId: order.refundId ?? "",
                underpaidCents: -gap,
                alert: "store_and_platform",
              },
        },
      });
    }
    const displayedStale = displayedOwedCents !== capturedCents - fresh.refundedCents;
    return {
      ok: true as const,
      ...(displayedStale
        ? { message: gap !== 0 ? BALANCE_CHANGED : "The balance changed since you loaded this page." }
        : {}),
    };
  }, { timeout: 20_000 }).then((result) => {
    if (result.ok && !result.message) revalidatePath("/admin/orders");
    return result;
  });
}

export async function resolveRefundFailedAction(
  _prev: ResolveResult | null,
  formData: FormData,
): Promise<ResolveResult> {
  await requirePlatformAdmin();
  const fields = parseInput(z.strictObject({
    orderId: z.string().max(200).nullable(),
    note: z.string().max(2_000).nullable(),
    repaidDollars: z.string().max(40).nullable(),
    displayedOwedCents: z.string().max(20).nullable(),
  }), readFormFields(formData, ["orderId", "note", "repaidDollars", "displayedOwedCents"]));
  if (!fields.ok) {
    return {
      ok: false,
      error: "Enter the amount you repaid, from $0.01 up to the captured amount.",
      fieldError: "Enter the amount you repaid, from $0.01 up to the captured amount.",
    };
  }
  const repaidCents = parseRepaidDollars(fields.data.repaidDollars ?? "");
  const displayedRaw = fields.data.displayedOwedCents ?? "";
  const displayedOwedCents = /^-?\d+$/.test(displayedRaw) ? Number(displayedRaw) : Number.NaN;
  if (repaidCents == null || !Number.isInteger(displayedOwedCents)) {
    return {
      ok: false,
      error: "Enter the amount you repaid, from $0.01 up to the captured amount.",
      fieldError: "Enter the amount you repaid, from $0.01 up to the captured amount.",
    };
  }
  return resolveRefundFailed(
    fields.data.orderId ?? "",
    fields.data.note ?? "",
    repaidCents,
    displayedOwedCents,
  );
}
