import { csvDollars, toCsv } from "@/lib/analytics/csv";
import { captureSplit, courierFeeCents, platformTaxCents } from "@/lib/order/platform-fee";

/**
 * Platform fee ledger (#546, ADR-0021): what the platform keeps per captured order, from our tables.
 * All amounts are integer cents; months are UTC calendar months.
 *
 * - A capture row comes from the order's capture record (confirmed_capture_cents, capture_confirmed_at), which a
 *   trigger writes once when the capture is confirmed and nothing clears: a cancel, a full refund or a manual
 *   repayment leaves it as it was. A capture whose cancel refund failed stays a capture row, marked refund failed.
 * - Application fee = the stored platform fee (service fee + the store's card fee) + the courier fee, capped at
 *   the capture, as sent to Stripe. Card fee share = the platform's part of the card-fee split.
 *   Net = application fee − courier fee − the store's card fee − the platform's card fee share.
 * - A refund row is dated when the refund succeeded and shown only when it returns fee: a refund with
 *   refund_application_fee returns the fee in proportion, never more than the fee across the order's refunds
 *   (Stripe's rule); a courier refund after delivery returns its service fee share, and its share of the tax the
 *   platform collected (#65), once that fee refund is made.
 *   Stripe keeps its card fee on a refund. The courier part of a returned fee goes back to the customer, so
 *   it reverses the courier pass-through and is not a platform loss; so does the tax part of a returned fee.
 * - A manual repayment is its own row in the month it was recorded: the amount repaid comes off the capture.
 *   It moves no money through Stripe, so no fee comes back and the platform net does not change.
 */

export type LedgerMonth = { key: string; label: string; startsAt: Date; endsAt: Date };

export const LEDGER_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month to show: a strict YYYY-MM, else the current UTC month. */
export function parseLedgerMonth(input: string | undefined, now: Date): string {
  if (input && LEDGER_MONTH.test(input)) return input;
  return now.toISOString().slice(0, 7);
}

export function ledgerMonth(key: string): LedgerMonth {
  const match = LEDGER_MONTH.exec(key);
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
  taxCents: number;
  taxLiableParty: string;
};

export type CaptureFacts = OrderFacts & { at: Date; refundFailed: boolean };

export type RepaymentFacts = OrderFacts & { repaymentId: string; at: Date; repaidCents: number };

export type RefundFacts = OrderFacts & {
  refundId: string;
  amountCents: number;
  refundApplicationFee: boolean;
  serviceFeeShareCents: number;
  platformTaxShareCents: number;
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
  kind: "capture" | "refund" | "repayment";
  refundFailed: boolean;
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
  const platformTax = platformTaxCents(order);
  const split = captureSplit({ capturedCents, serviceFeeCents: order.serviceFeeCents, courierFeeCents: courier, platformTaxCents: platformTax });
  const platformFee = order.platformFeeCents ?? split.platformFeeCents;
  const applicationFee = Math.min(platformFee + courier + platformTax, capturedCents);
  const storeCardFee = Math.max(0, platformFee - order.serviceFeeCents);
  return {
    capturedCents,
    courierFeeCents: courier,
    applicationFeeCents: applicationFee,
    platformCardFeeCents: split.platformCardFeeCents,
    // Courier fees and the tax the platform collects pass through; only their card fees are its cost.
    platformNetCents: applicationFee - courier - platformTax - storeCardFee - split.platformCardFeeCents,
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
    // An order still cancelling has no capture record yet: a refund at cancel returns the whole capture.
    const captured = order.capturedAmountCents ?? orderRefunds.reduce((sum, r) => sum + r.amountCents, 0);
    if (captured <= 0) continue;
    const money = orderMoney(order, captured);
    const platformTax = platformTaxCents(order);
    let returned = 0;
    for (const refund of orderRefunds) {
      const left = Math.max(0, money.applicationFeeCents - returned);
      let fee = 0;
      if (refund.refundApplicationFee) {
        fee = Math.min(Math.round((money.applicationFeeCents * refund.amountCents) / captured), left);
      } else if (refund.feeShareReturned) {
        fee = Math.min(refund.serviceFeeShareCents + refund.platformTaxShareCents, left);
      }
      returned += fee;
      const inMonth = refund.succeededAt >= month.startsAt && refund.succeededAt < month.endsAt;
      if (fee <= 0 || !inMonth) continue;
      const share = (cents: number) => (refund.refundApplicationFee && money.applicationFeeCents > 0
        ? Math.round((fee * cents) / money.applicationFeeCents)
        : 0);
      const courierBack = share(money.courierFeeCents);
      const taxBack = refund.refundApplicationFee ? share(platformTax) : Math.min(refund.platformTaxShareCents, fee);
      rows.push({
        kind: "refund",
        refundFailed: false,
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
        platformNetCents: negative(fee - courierBack - taxBack),
      });
    }
  }
  return rows;
}

const KIND_ORDER: Record<LedgerRow["kind"], number> = { capture: 0, refund: 1, repayment: 2 };

/** The month's rows, oldest first, with totals per store and for the month. */
export function buildFeeLedger(
  month: LedgerMonth,
  captures: CaptureFacts[],
  refunds: RefundFacts[],
  repayments: RepaymentFacts[],
): FeeLedger {
  const rows: LedgerRow[] = [];
  for (const capture of captures) {
    const captured = capture.capturedAmountCents ?? 0;
    if (captured <= 0) continue;
    rows.push({
      kind: "capture",
      refundFailed: capture.refundFailed,
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
  for (const repayment of repayments) {
    if (!(repayment.repaidCents > 0)) continue;
    rows.push({
      kind: "repayment",
      refundFailed: false,
      id: repayment.repaymentId,
      at: repayment.at,
      storeId: repayment.storeId,
      storeName: repayment.storeName,
      orderNumber: repayment.orderNumber,
      capturedCents: -repayment.repaidCents,
      serviceFeeCents: 0,
      courierFeeCents: 0,
      platformCardFeeCents: 0,
      applicationFeeCents: 0,
      feeRefundedCents: 0,
      platformNetCents: 0,
    });
  }
  rows.sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || a.storeName.localeCompare(b.storeName)
    || a.orderNumber - b.orderNumber
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.id.localeCompare(b.id));

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

export const LEDGER_PAGE_SIZE = 100;

/** Which rows the page shows: a strict positive page number, held to the last page; anything else is page 1. */
export function ledgerPage(rowCount: number, input: string | undefined) {
  const count = Math.max(1, Math.ceil(rowCount / LEDGER_PAGE_SIZE));
  const asked = input && /^[1-9]\d{0,5}$/.test(input) ? Number(input) : 1;
  const number = Math.min(asked, count);
  const from = (number - 1) * LEDGER_PAGE_SIZE;
  return { number, count, from, to: Math.min(rowCount, from + LEDGER_PAGE_SIZE) };
}

/** The row label the page and the CSV share. */
export function rowLabel(row: Pick<LedgerRow, "kind" | "refundFailed">): string {
  if (row.kind === "repayment") return "Manual repayment";
  if (row.kind === "refund") return "Refund";
  return row.refundFailed ? "Order, refund failed" : "Order";
}

export function ordersLabel(orders: number): string {
  return `${orders} ${orders === 1 ? "order" : "orders"}`;
}

/** The amount columns in screen order. */
export const AMOUNT_COLUMNS: Array<[keyof LedgerAmounts, string]> = [
  ["capturedCents", "Captured"],
  ["serviceFeeCents", "Service fee"],
  ["courierFeeCents", "Courier fee passed through"],
  ["platformCardFeeCents", "Card fee share (platform)"],
  ["applicationFeeCents", "Application fee"],
  ["feeRefundedCents", "Fee refunded"],
  ["platformNetCents", "Platform net"],
];

export const utcDate = (at: Date) => at.toISOString().slice(0, 10);

/** The month as on screen: every row, each store's total, then the month's. */
export function feeLedgerCsv(ledger: FeeLedger): string {
  const amounts = (values: LedgerAmounts) => AMOUNT_COLUMNS.map(([key]) => csvDollars(values[key]));
  const month = ledger.month.key;
  return toCsv([
    ["Month (UTC)", "Date (UTC)", "Store", "Order", "Row", ...AMOUNT_COLUMNS.map(([, label]) => label)],
    ...ledger.rows.map((row) => [month, utcDate(row.at), row.storeName, `#${row.orderNumber}`, rowLabel(row), ...amounts(row)]),
    ...ledger.stores.map((store) => [month, null, store.storeName, null, `Store total (${ordersLabel(store.orders)})`, ...amounts(store)]),
    [month, null, "All stores", null, `Month total (${ordersLabel(ledger.total.orders)})`, ...amounts(ledger.total)],
  ]);
}
