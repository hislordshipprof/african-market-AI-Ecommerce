import type { Prisma } from "@prisma/client";
import { storeScoped } from "../db";
import { decodeOrderCursor, encodeOrderCursor } from "../admin/order-search";
import { SUCCEEDED_REFUNDS } from "./service";
import { showCapturedLine, storePayoutLines } from "./staff-copy";

export const PAST_ORDERS_PAGE_SIZE = 25;

/** Orders the store has handed off or closed (#785): the inbox shows only the rest. */
const PAST_STATUSES = ["COMPLETED", "DELIVERED", "CANCELLED", "PARTIALLY_REFUNDED", "REFUNDED"];

export type PastOrderRow = {
  id: string;
  number: number;
  createdAt: Date;
  status: string;
  fulfillment: string;
  customerName: string;
  /** What the card was charged, else the order total when nothing was charged. */
  totalCents: number;
  /** The store's payout after fees and refunds; null when nothing was captured. */
  payoutCents: number | null;
};

function searchWhere(q: string | undefined): Prisma.OrderWhereInput {
  const term = q?.trim().slice(0, 100) ?? "";
  if (!term) return {};
  const digits = term.replace(/^#/, "");
  if (/^\d{1,9}$/.test(digits)) return { number: Number(digits) };
  return {
    customer: {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    },
  };
}

/** One page of past orders, newest first, keyset-paged on (created_at, id); `q` is an order number or customer. */
export async function pastStoreOrders(
  storeId: string,
  { q, cursor }: { q?: string; cursor?: string },
): Promise<{ rows: PastOrderRow[]; nextCursor: string | null }> {
  const after = cursor ? decodeOrderCursor(cursor) : null;
  const rows = await storeScoped(storeId).order.findMany({
    where: {
      status: { in: PAST_STATUSES },
      ...searchWhere(q),
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },
    select: {
      id: true, number: true, createdAt: true, status: true, fulfillment: true, totalCents: true, captureCents: true,
      capturedAmountCents: true, platformFeeCents: true, serviceFeeCents: true, deliveryFeeCents: true,
      shippingPostageCents: true, taxCents: true, taxLiableParty: true,
      customer: { select: { name: true } },
      refundRequests: SUCCEEDED_REFUNDS,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAST_ORDERS_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, PAST_ORDERS_PAGE_SIZE).map((row) => ({
    id: row.id,
    number: row.number,
    createdAt: row.createdAt,
    status: row.status,
    fulfillment: row.fulfillment,
    customerName: row.customer.name,
    totalCents: row.captureCents ?? row.totalCents,
    payoutCents: showCapturedLine(row.status, row.capturedAmountCents)
      ? storePayoutLines({ ...row, capturedAmountCents: row.capturedAmountCents! }).at(-1)!.cents
      : null,
  }));
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > PAST_ORDERS_PAGE_SIZE && last ? encodeOrderCursor(last) : null };
}
