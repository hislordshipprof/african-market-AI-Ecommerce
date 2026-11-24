import { FULFILLMENT_LABELS } from "./status-labels";
import { captureCharge, lineChargeCents, type ChargeLine } from "./substitution-pricing";
import { orderServiceFeeSettings } from "./platform-fee";
import { couponTerms } from "../coupon/discount";

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
  /** Succeeded refunds to the customer's card. */
  refundedCents: number;
  /** `substitutedName` names the replacement on a swapped line. */
  lines: Array<ChargeLine & { id: string; substitutedName: string | null }>;
};

export type ReceiptLine = { key: string; label: string; cents: number };

export type ReceiptView = {
  items: Array<{ id: string; cents: number; note: string | null }>;
  lines: ReceiptLine[];
  total: { label: "Total" | "Expected total" | "Charged"; cents: number };
  /** The card hold, shown only until the payment is captured. */
  holdCents: number | null;
  /** After a refund of a captured payment: the refund under the charge, and what is left charged. */
  refund: ReceiptLine | null;
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
    const refunded = order.refundedCents > 0;
    return {
      items,
      lines,
      total: { label: "Charged", cents: order.captureCents },
      holdCents: null,
      refund: refunded ? { key: "refund", label: "Refunded", cents: -order.refundedCents } : null,
      net: refunded ? { label: "Net charged", cents: order.captureCents - order.refundedCents } : null,
    };
  }
  const totalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  return { items, lines, total: { label: money.expected ? "Expected total" : "Total", cents: totalCents }, holdCents: order.totalAuthorizedCents, refund: null, net: null };
}
