import { captureSplit, courierFeeCents } from "@/lib/order/platform-fee";

/**
 * Platform fee ledger (#546, ADR-0021): what the platform keeps per captured order, from our tables.
 * All amounts are integer cents; months are UTC calendar months.
 *
 * - A capture row is dated when the capture was confirmed (ready_at), or when the order was cancelled for a
 *   capture first seen at cancel. A capture the order no longer stores (a full cancel clears it) is the sum of
 *   its succeeded refunds.
 * - Application fee = the stored platform fee (service fee + the store's card fee) + the courier fee, capped at
 *   the capture, as sent to Stripe. Card fee share = the platform's part of the card-fee split.
 *   Net = application fee − courier fee − the store's card fee − the platform's card fee share.
 * - A refund row is dated when the refund succeeded and shown only when it returns fee: a refund with
 *   refund_application_fee returns the fee in proportion, never more than the fee across the order's refunds
 *   (Stripe's rule); a courier issue refund returns its service fee share once that fee refund is made.
 *   Stripe keeps its card fee on a refund. The courier part of a returned fee goes back to the customer, so
 *   it reverses the courier pass-through and is not a platform loss.
 */

export type LedgerMonth = { key: string; label: string; startsAt: Date; endsAt: Date };

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month to show: a strict YYYY-MM, else the current UTC month. */
export function parseLedgerMonth(input: string | undefined, now: Date): string {
  if (input && MONTH_KEY.test(input)) return input;
  return now.toISOString().slice(0, 7);
}

export function ledgerMonth(key: string): LedgerMonth {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new Error(`Not a month: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const startsAt = new Date(Date.UTC(year, month, 1));
  const endsAt = new Date(Date.UTC(year, month + 1, 1));
  const label = startsAt.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { key, label, startsAt, endsAt };
}

export function shiftMonth(key: string, by: number): string {
  const { startsAt } = ledgerMonth(key);
  return new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + by, 1)).toISOString().slice(0, 7);
}

type OrderFacts = {
  orderId: string;
  storeId: string;
  storeName: string;
  orderNumber: number;
  fulfillment: string;
  capturedAmountCents: number | null;
  platformFeeCents: number | null;
  serviceFeeCents: number;
  deliveryFeeCents: number;
};

export type CaptureFacts = OrderFacts & { at: Date; succeededRefundsCents: number };

export type RefundFacts = OrderFacts & {
  refundId: string;
  amountCents: number;
  refundApplicationFee: boolean;
  serviceFeeShareCents: number;
  feeShareReturned: boolean;
  createdAt: Date;
  succeededAt: Date;
};

export type LedgerAmounts = {
  capturedCents: number;
  serviceFeeCents: number;
  courierFeeCents: number;
  platformCardFeeCents: number;
  applicationFeeCents: number;
  feeRefundedCents: number;
  platformNetCents: number;
};

export type LedgerRow = LedgerAmounts & {
  kind: "capture" | "refund";
  id: string;
  at: Date;
  storeId: string;
  storeName: string;
  orderNumber: number;
};

export type LedgerTotals = LedgerAmounts & { orders: number };
export type StoreLedgerTotals = LedgerTotals & { storeId: string; storeName: string };

export type FeeLedger = { month: LedgerMonth; rows: LedgerRow[]; stores: StoreLedgerTotals[]; total: LedgerTotals };

function orderMoney(order: OrderFacts, capturedCents: number) {
  const courier = courierFeeCents(order);
  const split = captureSplit({ capturedCents, serviceFeeCents: order.serviceFeeCents, courierFeeCents: courier });
  const platformFee = order.platformFeeCents ?? split.platformFeeCents;
  const applicationFee = Math.min(platformFee + courier, capturedCents);
  const storeCardFee = Math.max(0, platformFee - order.serviceFeeCents);
  return {
    capturedCents,
    courierFeeCents: courier,
    applicationFeeCents: applicationFee,
    platformCardFeeCents: split.platformCardFeeCents,
    platformNetCents: applicationFee - courier - storeCardFee - split.platformCardFeeCents,
  };
}

/** A refund row's amounts are negative; a zero stays 0, not -0. */
const negative = (cents: number) => (cents === 0 ? 0 : -cents);

function emptyTotals(): LedgerTotals {
  return {
    orders: 0, capturedCents: 0, serviceFeeCents: 0, courierFeeCents: 0, platformCardFeeCents: 0,
    applicationFeeCents: 0, feeRefundedCents: 0, platformNetCents: 0,
  };
}

function addRow(totals: LedgerTotals, row: LedgerRow) {
  if (row.kind === "capture") totals.orders += 1;
  totals.capturedCents += row.capturedCents;
  totals.serviceFeeCents += row.serviceFeeCents;
  totals.courierFeeCents += row.courierFeeCents;
  totals.platformCardFeeCents += row.platformCardFeeCents;
  totals.applicationFeeCents += row.applicationFeeCents;
  totals.feeRefundedCents += row.feeRefundedCents;
  totals.platformNetCents += row.platformNetCents;
}

function refundRows(refunds: RefundFacts[], month: LedgerMonth): LedgerRow[] {
  const byOrder = new Map<string, RefundFacts[]>();
  for (const refund of refunds) byOrder.set(refund.orderId, [...(byOrder.get(refund.orderId) ?? []), refund]);
  const rows: LedgerRow[] = [];
  for (const orderRefunds of byOrder.values()) {
    orderRefunds.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.refundId.localeCompare(b.refundId));
    const order = orderRefunds[0];
    const captured = order.capturedAmountCents ?? orderRefunds.reduce((sum, r) => sum + r.amountCents, 0);
    if (captured <= 0) continue;
    const money = orderMoney(order, captured);
    let returned = 0;
    for (const refund of orderRefunds) {
      const left = Math.max(0, money.applicationFeeCents - returned);
      let fee = 0;
      if (refund.refundApplicationFee) {
        fee = Math.min(Math.round((money.applicationFeeCents * refund.amountCents) / captured), left);
      } else if (refund.feeShareReturned) {
        fee = Math.min(refund.serviceFeeShareCents, left);
      }
      returned += fee;
      const inMonth = refund.succeededAt >= month.startsAt && refund.succeededAt < month.endsAt;
      if (fee <= 0 || !inMonth) continue;
      const courierBack = refund.refundApplicationFee && money.applicationFeeCents > 0
        ? Math.round((fee * money.courierFeeCents) / money.applicationFeeCents)
        : 0;
      rows.push({
        kind: "refund",
        id: refund.refundId,
        at: refund.succeededAt,
        storeId: refund.storeId,
        storeName: refund.storeName,
        orderNumber: refund.orderNumber,
        capturedCents: negative(refund.amountCents),
        serviceFeeCents: 0,
        courierFeeCents: negative(courierBack),
        platformCardFeeCents: 0,
        applicationFeeCents: 0,
        feeRefundedCents: negative(fee),
        platformNetCents: negative(fee - courierBack),
      });
    }
  }
  return rows;
}

/** The month's rows, oldest first, with totals per store and for the month. */
export function buildFeeLedger(month: LedgerMonth, captures: CaptureFacts[], refunds: RefundFacts[]): FeeLedger {
  const rows: LedgerRow[] = [];
  for (const capture of captures) {
    const captured = capture.capturedAmountCents ?? capture.succeededRefundsCents;
    if (captured <= 0) continue;
    rows.push({
      kind: "capture",
      id: capture.orderId,
      at: capture.at,
      storeId: capture.storeId,
      storeName: capture.storeName,
      orderNumber: capture.orderNumber,
      serviceFeeCents: capture.serviceFeeCents,
      feeRefundedCents: 0,
      ...orderMoney(capture, captured),
    });
  }
  rows.push(...refundRows(refunds, month));
  rows.sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || a.storeName.localeCompare(b.storeName)
    || a.orderNumber - b.orderNumber
    || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "capture" ? -1 : 1));

  const total = emptyTotals();
  const stores = new Map<string, StoreLedgerTotals>();
  for (const row of rows) {
    addRow(total, row);
    const store = stores.get(row.storeId) ?? { storeId: row.storeId, storeName: row.storeName, ...emptyTotals() };
    addRow(store, row);
    stores.set(row.storeId, store);
  }
  return {
    month,
    rows,
    stores: [...stores.values()].sort((a, b) => a.storeName.localeCompare(b.storeName) || a.storeId.localeCompare(b.storeId)),
    total,
  };
}
