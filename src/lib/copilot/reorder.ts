import { Prisma, platform, storeScoped, storeScopedRawQuery } from "../db";
import { listingLabel } from "./cards";

const DAY_MS = 24 * 60 * 60_000;
export const REORDER_WINDOW_DAYS = 28;
export const DEFAULT_LEAD_DAYS = 7;
export const DEFAULT_COVER_DAYS = 14;
export const REORDER_STATUSES = ["low", "out_of_stock"] as const;

export interface ReorderRow {
  listingId: string;
  name: string;
  stockMode: string;
  /** Counted listings only. */
  onHand: number | null;
  /** Status listings only. */
  status: string | null;
  /** Online and reported counter sales in the last 28 days. */
  sold28: number;
  perDay: number;
  /** Null is "reorder (no count)": a status listing marked low or out that sold in 28 days. */
  suggested: number | null;
}

export interface ReorderSuggestions {
  leadDays: number;
  coverDays: number;
  windowDays: number;
  rows: ReorderRow[];
}

/** ceil(daily sales x (lead + cover) - on hand), floored at 0, in whole numbers so an exact need is not rounded up. */
export function suggestQuantity(input: { onHand: number; sold28: number }, leadDays: number, coverDays: number): number {
  const need = input.sold28 * (leadDays + coverDays) - input.onHand * REORDER_WINDOW_DAYS;
  return need <= 0 ? 0 : Math.ceil(need / REORDER_WINDOW_DAYS);
}

export async function loadReorderDays(storeId: string): Promise<{ leadDays: number; coverDays: number }> {
  const store = await platform.store.findUnique({
    where: { id: storeId },
    select: { reorderLeadDays: true, reorderCoverDays: true },
  });
  return {
    leadDays: store?.reorderLeadDays ?? DEFAULT_LEAD_DAYS,
    coverDays: store?.reorderCoverDays ?? DEFAULT_COVER_DAYS,
  };
}

/**
 * Read only: what to reorder, from the last 28 days of online and reported counter sales (ADR-0009),
 * read under the store's RLS. Nothing here writes stock or orders anything.
 */
export async function reorderSuggestions(storeId: string, options: { now?: Date } = {}): Promise<ReorderSuggestions> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - REORDER_WINDOW_DAYS * DAY_MS);
  const [days, listings, sums] = await Promise.all([
    loadReorderDays(storeId),
    storeScoped(storeId).listing.findMany({
      where: { active: true },
      select: { id: true, customName: true, stockMode: true, qty: true, status: true, masterProduct: { select: { name: true } } },
    }),
    storeScopedRawQuery<{ listing_id: string; sold: number }>(storeId, Prisma.sql`
      SELECT listing_id, COALESCE(-SUM(delta), 0)::int AS sold
      FROM stock_events
      WHERE store_id = ${storeId}
        AND type IN ('sale', 'counter_sale')
        AND created_at >= ${since} AND created_at < ${now}
      GROUP BY listing_id
    `),
  ]);

  const sold = new Map(sums.map((row) => [row.listing_id, row.sold]));
  const rows: ReorderRow[] = [];
  for (const listing of listings) {
    const sold28 = Math.max(0, sold.get(listing.id) ?? 0);
    const perDay = Math.round((sold28 * 10) / REORDER_WINDOW_DAYS) / 10;
    const base = { listingId: listing.id, name: listingLabel(listing), stockMode: listing.stockMode, sold28, perDay };
    if (listing.stockMode === "counted") {
      const onHand = listing.qty ?? 0;
      const suggested = suggestQuantity({ onHand, sold28 }, days.leadDays, days.coverDays);
      if (suggested > 0) rows.push({ ...base, onHand, status: null, suggested });
    } else if (sold28 > 0 && (REORDER_STATUSES as readonly string[]).includes(listing.status ?? "")) {
      rows.push({ ...base, onHand: null, status: listing.status, suggested: null });
    }
  }
  rows.sort(compareRows);
  return { ...days, windowDays: REORDER_WINDOW_DAYS, rows };
}

/** Counted rows first, the biggest order first; then "reorder (no count)" rows; then by name. */
function compareRows(a: ReorderRow, b: ReorderRow): number {
  const size = (row: ReorderRow) => row.suggested ?? -1;
  if (size(a) !== size(b)) return size(b) - size(a);
  return a.name.localeCompare(b.name);
}
