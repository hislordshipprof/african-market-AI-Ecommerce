import { FULFILLMENT_LABELS } from "./status-labels";
import { lineChargeCents, type ChargeLine } from "./substitution-pricing";

export type ReceiptOrder = {
  status: string;
  fulfillment: string;
  subtotalCents: number;
  discountCents: number;
  couponCode: string | null;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  tipCents: number;
  taxCents: number;
  totalAuthorizedCents: number;
  /** What Stripe captured (#537); kept after a refund, null until the capture is confirmed. */
  captureCents: number | null;
  /** Succeeded refunds to the customer's card. */
  refundedCents: number;
  lines: Array<ChargeLine & { id: string }>;
};

export type ReceiptLine = { key: string; label: string; cents: number };

export type ReceiptView = {
  items: Array<{ id: string; cents: number; note: string | null }>;
  lines: ReceiptLine[];
  total: { label: "Total" | "Charged"; cents: number };
  /** The card hold, shown only until the payment is captured. */
  holdCents: number | null;
  /** After a refund of a captured payment: the refund under the charge, and what is left charged. */
  refund: ReceiptLine | null;
  net: { label: "Net charged"; cents: number } | null;
};

function itemNote(line: ChargeLine): string | null {
  if (line.status === "substituted") return "Swapped";
  if ((line.status === "picked" || line.status === "refunded") && line.qtyPicked < line.qtyOrdered) {
    return `${line.qtyPicked} of ${line.qtyOrdered} found`;
  }
  return null;
}

/**
 * The tracking page receipt, from the amounts stored on the order. Capture rewrites the fees and tax
 * on the goods picked but not the subtotal, so once captured the goods come from the lines.
 */
export function orderReceipt(order: ReceiptOrder): ReceiptView {
  const captured = order.captureCents != null;
  const items = order.lines.map((line) => ({
    id: line.id,
    cents: captured ? lineChargeCents(line) : line.qtyOrdered * line.unitPriceCents,
    note: captured ? itemNote(line) : null,
  }));
  const goodsCents = captured ? items.reduce((sum, item) => sum + item.cents, 0) : order.subtotalCents;

  const lines: ReceiptLine[] = [{ key: "subtotal", label: "Subtotal", cents: goodsCents }];
  if (order.discountCents > 0) {
    lines.push({ key: "discount", label: order.couponCode ? `Promo ${order.couponCode}` : "Promo discount", cents: -order.discountCents });
  }
  if (order.deliveryFeeCents > 0) {
    lines.push({ key: "delivery", label: FULFILLMENT_LABELS[order.fulfillment] ?? "Delivery fee", cents: order.deliveryFeeCents });
  }
  if (order.serviceFeeCents > 0) lines.push({ key: "service-fee", label: "Service fee", cents: order.serviceFeeCents });
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
  return { items, lines, total: { label: "Total", cents: totalCents }, holdCents: order.totalAuthorizedCents, refund: null, net: null };
}
