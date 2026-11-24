import type { Prisma } from "@prisma/client";

/** One line of a refund request (#798): the amounts of a request's lines sum to its amount. */
export type RequestLine = { lineId: string; qty: number; amountCents: number };

/** The stored lines of a refund request, or none when it is not tied to lines. Safe for client components. */
export function requestLines(value: Prisma.JsonValue | null | undefined): RequestLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const line = item as Partial<RequestLine> | null;
    return line && typeof line.lineId === "string" && typeof line.qty === "number" && typeof line.amountCents === "number"
      ? [{ lineId: line.lineId, qty: line.qty, amountCents: line.amountCents }]
      : [];
  });
}

/** Units of each line the given succeeded refunds returned. */
export function refundedUnits(refunds: Array<{ lines: Prisma.JsonValue | null }>): Map<string, number> {
  const units = new Map<string, number>();
  for (const refund of refunds) {
    for (const line of requestLines(refund.lines)) units.set(line.lineId, (units.get(line.lineId) ?? 0) + line.qty);
  }
  return units;
}

type NamedVariant = { label: string; listing: { customName: string | null; masterProduct: { name: string } | null } };

/** The owner's refund choices (#798): each picked line and how many units are left to refund of it. */
export function refundableLines(order: {
  lines: Array<{ id: string; qtyPicked: number; unitPriceCents: number; listingVariant: NamedVariant }>;
  refundRequests: Array<{ lines: Prisma.JsonValue | null }>;
}): Array<{ id: string; name: string; variant: string; unitPriceCents: number; refundableQty: number }> {
  const units = refundedUnits(order.refundRequests);
  return order.lines.map((line) => ({
    id: line.id,
    name: line.listingVariant.listing.customName ?? line.listingVariant.listing.masterProduct?.name ?? line.listingVariant.label,
    variant: line.listingVariant.label,
    unitPriceCents: line.unitPriceCents,
    refundableQty: Math.max(0, line.qtyPicked - (units.get(line.id) ?? 0)),
  }));
}
