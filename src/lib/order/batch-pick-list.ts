import { RESOLVED_LINE_STATUSES, type OrderLineStatus } from "./constants";

/** Batch picking (#564): one combined pick list for 2-4 orders, built from each order's own lines. */
export const MIN_BATCH_ORDERS = 2;
export const MAX_BATCH_ORDERS = 4;

export type BatchLineInput = {
  id: string;
  listingVariantId: string;
  qtyOrdered: number;
  qtyPicked: number;
  status: string;
  swapRule: string;
  /** The shopper's named substitute, when the swap rule is `named_substitute`. */
  substituteName: string | null;
  name: string;
  label: string;
  imageUrl: string | null;
  frozen: boolean;
  perishable: boolean;
  /** The product's category, which stands in for the aisle; null when the product has none. */
  zone: { name: string; sortOrder: number; slug?: string } | null;
};

export type BatchOrderInput = {
  id: string;
  number: number;
  createdAt: Date;
  status: string;
  fulfillment: string;
  lines: BatchLineInput[];
};

export type BatchTote = { orderId: string; number: number; letter: string; status: string; fulfillment: string };

export type BatchSplit = {
  lineId: string;
  orderId: string;
  number: number;
  letter: string;
  qty: number;
  qtyPicked: number;
  status: string;
  swap: string | null;
};

export type BatchPickLine = {
  listingVariantId: string;
  name: string;
  label: string;
  imageUrl: string | null;
  /** Picks the missing-photo glyph, the same one the storefront shows (#742). */
  categorySlug: string | null;
  totalQty: number;
  /** True while any order's line still waits to be picked or answered. */
  open: boolean;
  splits: BatchSplit[];
};

export type BatchZone = { name: string; lines: BatchPickLine[] };

export type BatchPickList = { totes: BatchTote[]; zones: BatchZone[] };

const TOTE_LETTERS = "ABCD";

/** Oldest order first: it gets tote A and is filled first. */
export function byOrderAge<T extends { createdAt: Date; number: number }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number);
}

function swapNote(line: BatchLineInput): string | null {
  if (line.swapRule === "named_substitute" && line.substituteName) return `Swap OK: ${line.substituteName}`;
  if (line.swapRule === "store_suggests") return "Store may suggest a swap";
  return null;
}

/** Dry zones in category order, then uncategorised, then chilled, then frozen last. */
function zoneOf(line: BatchLineInput): { name: string; rank: [number, number] } {
  if (line.frozen) return { name: "Frozen", rank: [3, 0] };
  if (line.perishable) return { name: "Chilled", rank: [2, 0] };
  if (!line.zone) return { name: "Other", rank: [1, 0] };
  return { name: line.zone.name, rank: [0, line.zone.sortOrder] };
}

export function buildBatchPickList(orders: BatchOrderInput[]): BatchPickList {
  const aged = byOrderAge(orders);
  const totes = aged.map((order, index) => ({
    orderId: order.id,
    number: order.number,
    letter: TOTE_LETTERS[index] ?? String(index + 1),
    status: order.status,
    fulfillment: order.fulfillment,
  }));

  const zones = new Map<string, { name: string; rank: [number, number]; lines: Map<string, BatchPickLine> }>();
  aged.forEach((order, index) => {
    for (const line of order.lines) {
      const zone = zoneOf(line);
      let bucket = zones.get(zone.name);
      if (!bucket) {
        bucket = { ...zone, lines: new Map() };
        zones.set(zone.name, bucket);
      }
      let combined = bucket.lines.get(line.listingVariantId);
      if (!combined) {
        combined = {
          listingVariantId: line.listingVariantId,
          name: line.name,
          label: line.label,
          imageUrl: line.imageUrl,
          categorySlug: line.zone?.slug ?? null,
          totalQty: 0,
          open: false,
          splits: [],
        };
        bucket.lines.set(line.listingVariantId, combined);
      }
      combined.totalQty += line.qtyOrdered;
      if (!RESOLVED_LINE_STATUSES.includes(line.status as OrderLineStatus)) combined.open = true;
      combined.splits.push({
        lineId: line.id,
        orderId: order.id,
        number: order.number,
        letter: totes[index].letter,
        qty: line.qtyOrdered,
        qtyPicked: line.qtyPicked,
        status: line.status,
        swap: swapNote(line),
      });
    }
  });

  return {
    totes,
    zones: [...zones.values()]
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.name.localeCompare(b.name))
      .map((zone) => ({
        name: zone.name,
        lines: [...zone.lines.values()].sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label)),
      })),
  };
}

/** Units found on a combined line fill the oldest order first; any short lands on the newest. */
export function allocateFound<T extends { id: string; qtyOrdered: number }>(
  linesOldestFirst: T[],
  unitsFound: number,
): Array<{ id: string; found: number }> {
  let left = unitsFound;
  return linesOldestFirst.map((line) => {
    const found = Math.min(line.qtyOrdered, Math.max(0, left));
    left -= found;
    return { id: line.id, found };
  });
}
