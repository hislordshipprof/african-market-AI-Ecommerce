import { FULFILLMENT_LABELS } from "./status-labels";
import { captureCharge, lineChargeCents, type ChargeLine } from "./substitution-pricing";
import { orderServiceFeeSettings } from "./platform-fee";
import { couponTerms } from "../coupon/discount";
import type { RequestLine } from "./refund-requests";

/** What an order's goods, discount and service fee come to now, from its stored amounts and its lines. */
export type OrderMoneyInput = {
  subtotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  serviceFeeBps: number;
  serviceFeeMinCents: number;
  serviceFeeMaxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  coupon: { kind: string; percentOff: number | null; amountOffCents: number | null } | null;
  lines: ChargeLine[];
};

function shorted(line: ChargeLine): boolean {
  return line.status === "substituted" || line.status === "refunded" || (line.status === "picked" && line.qtyPicked < line.qtyOrdered);
}

/**
 * Capture rewrites the discount, fee and tax on the goods picked but not the subtotal, so once `captured`
 * the goods come from the lines. Before capture, once a short line is answered, the goods come from the
 * lines too and the discount and fee from the capture formula: `expected` is then true. Tax stays as stored
 * until capture recalculates it.
 */
export function orderMoney(order: OrderMoneyInput, captured: boolean): { goodsCents: number; discountCents: number; serviceFeeCents: number; expected: boolean } {
  const goodsCents = order.lines.reduce((sum, line) => sum + lineChargeCents(line), 0);
  if (captured) return { goodsCents, discountCents: order.discountCents, serviceFeeCents: order.serviceFeeCents, expected: false };
  if (!order.lines.some(shorted)) {
    return { goodsCents: order.subtotalCents, discountCents: order.discountCents, serviceFeeCents: order.serviceFeeCents, expected: false };
  }
  const charge = captureCharge(order.lines, {
    tipCents: order.tipCents,
    deliveryFeeCents: order.deliveryFeeCents,
    serviceFee: orderServiceFeeSettings(order),
    coupon: order.coupon ? couponTerms(order.coupon) : null,
  });
  return { goodsCents, discountCents: charge.discountCents, serviceFeeCents: charge.serviceFeeCents, expected: true };
}

export type ReceiptOrder = Omit<OrderMoneyInput, "lines"> & {
  status: string;
  fulfillment: string;
  couponCode: string | null;
  taxCents: number;
  totalAuthorizedCents: number;
  /** What Stripe captured (#537); kept after a refund, null until the capture is confirmed. */
  captureCents: number | null;
  /** Succeeded refunds to the customer's card, with the lines each returned (#798); none for a refund not tied to lines. */
  refunds: Array<{ amountCents: number; lines: RequestLine[] }>;
  /** `name` is the item's name; `substitutedName` names the replacement on a swapped line. */
  lines: Array<ChargeLine & { id: string; name?: string; substitutedName: string | null }>;
};

export type ReceiptLine = { key: string; label: string; cents: number };

export type ReceiptView = {
  items: Array<{ id: string; cents: number; note: string | null }>;
  lines: ReceiptLine[];
  total: { label: "Total" | "Expected total" | "Charged"; cents: number };
  /** The card hold, shown only until the payment is captured. */
  holdCents: number | null;
  /** After a refund of a captured payment: each refunded line and any refund not tied to a line, then what is left charged. */
  refunds: ReceiptLine[];
  net: { label: "Net charged"; cents: number } | null;
};

function itemNote(line: ReceiptOrder["lines"][number]): string | null {
  if (line.status === "substituted") return line.substitutedName ? `Swapped for ${line.substitutedName}` : "Swapped";
  if ((line.status === "picked" || line.status === "refunded") && line.qtyPicked < line.qtyOrdered) {
    return `${line.qtyPicked} of ${line.qtyOrdered} found`;
  }
  return null;
}

/** The tracking page receipt, from the amounts stored on the order and its lines (`orderMoney`). */
export function orderReceipt(order: ReceiptOrder): ReceiptView {
  const captured = order.captureCents != null;
  const money = orderMoney(order, captured);
  const settled = captured || money.expected;
  const items = order.lines.map((line) => ({
    id: line.id,
    cents: settled ? lineChargeCents(line) : line.qtyOrdered * line.unitPriceCents,
    note: settled ? itemNote(line) : null,
  }));

  const lines: ReceiptLine[] = [{ key: "subtotal", label: "Subtotal", cents: money.goodsCents }];
  if (money.discountCents > 0) {
    lines.push({ key: "discount", label: order.couponCode ? `Promo ${order.couponCode}` : "Promo discount", cents: -money.discountCents });
  }
  if (order.deliveryFeeCents > 0) {
    lines.push({ key: "delivery", label: FULFILLMENT_LABELS[order.fulfillment] ?? "Delivery fee", cents: order.deliveryFeeCents });
  }
  if (money.serviceFeeCents > 0) lines.push({ key: "service-fee", label: "Service fee", cents: money.serviceFeeCents });
  if (order.tipCents > 0) lines.push({ key: "tip", label: "Tip", cents: order.tipCents });
  lines.push({ key: "tax", label: "Tax", cents: order.taxCents });

  if (order.captureCents != null) {
    const refunds = refundLines(order);
    const refundedCents = order.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    return {
      items,
      lines,
      total: { label: "Charged", cents: order.captureCents },
      holdCents: null,
      refunds,
      net: refundedCents > 0 ? { label: "Net charged", cents: order.captureCents - refundedCents } : null,
    };
  }
  const totalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  return { items, lines, total: { label: money.expected ? "Expected total" : "Total", cents: totalCents }, holdCents: order.totalAuthorizedCents, refunds: [], net: null };
}

/** One row per refunded item, in the order's line order, and one for what was refunded without lines. */
function refundLines(order: ReceiptOrder): ReceiptLine[] {
  const byLine = new Map<string, { qty: number; cents: number }>();
  let other = 0;
  for (const refund of order.refunds) {
    if (refund.lines.length === 0) other += refund.amountCents;
    for (const line of refund.lines) {
      const sum = byLine.get(line.lineId) ?? { qty: 0, cents: 0 };
      byLine.set(line.lineId, { qty: sum.qty + line.qty, cents: sum.cents + line.amountCents });
    }
  }
  const rows: ReceiptLine[] = order.lines.flatMap((line) => {
    const refunded = byLine.get(line.id);
    return refunded ? [{ key: `refund-${line.id}`, label: `Refunded ${refunded.qty} × ${line.name ?? "Item"}`, cents: -refunded.cents }] : [];
  });
  if (other > 0) rows.push({ key: "refund", label: "Refunded", cents: -other });
  return rows;
}
