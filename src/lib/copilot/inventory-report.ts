import { Prisma, platform, storeScoped, storeScopedRawQuery } from "../db";
import { isValidTimezone } from "../order/store-hours";
import { listingLabel } from "./cards";
import { searchListingMatches } from "./search";

const DAY_MS = 24 * 60 * 60_000;
export const MOVEMENT_DAYS = 7;
const VELOCITY_DAYS = 14;
/** Shopify-style floor: fewer units sold than this in 14 days gets no estimate. */
export const SALES_FLOOR = 3;
export const RUNNING_OUT_DAYS = 3;

export type StockEstimate =
  | { kind: "estimate"; perDay: number; daysLeft: number; outDate: string; outDay: string }
  | { kind: "not_enough_sales" }
  | { kind: "sold_out" }
  | { kind: "not_counted" };

export interface MovementRow {
  listingId: string;
  name: string;
  stockMode: string;
  qty: number | null;
  /** Online order units sold in the last 7 days, and in the 7 before. */
  online7: number;
  onlinePrior7: number;
  /** Counter sales the owner reported, last 7 days. */
  counter7: number;
  restocked7: number;
  short7: number;
  estimate: StockEstimate;
}

export interface MovementTotals {
  online: number;
  onlinePrior: number;
  counter: number;
  restocked: number;
  short: number;
}

interface EventSums {
  online7: number;
  onlinePrior7: number;
  counter7: number;
  restocked7: number;
  short7: number;
  sold14: number;
}

const NO_EVENTS: EventSums = { online7: 0, onlinePrior7: 0, counter7: 0, restocked7: 0, short7: 0, sold14: 0 };

/** The store's calendar date and weekday for an instant. */
function localDay(timeZone: string, at: Date): { date: string; weekday: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at);
  return { date, weekday };
}

/** Monday of the store's current week, YYYY-MM-DD: the key for once-a-week alerts. */
export function storeWeek(timeZone: string, now: Date): string {
  const { date } = localDay(timeZone, now);
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Counted listings with at least 3 units sold online or at the counter in 14 days get a days-left estimate. */
export function estimateStock(
  listing: { stockMode: string; qty: number | null },
  sold14: number,
  timeZone: string,
  now: Date,
): StockEstimate {
  if (listing.stockMode !== "counted" || listing.qty == null) return { kind: "not_counted" };
  if (listing.qty <= 0) return { kind: "sold_out" };
  if (sold14 < SALES_FLOOR) return { kind: "not_enough_sales" };
  const daysLeft = Math.floor((listing.qty * VELOCITY_DAYS) / sold14);
  const out = localDay(timeZone, new Date(now.getTime() + daysLeft * DAY_MS));
  return {
    kind: "estimate",
    perDay: Math.round((sold14 * 10) / VELOCITY_DAYS) / 10,
    daysLeft,
    outDate: out.date,
    outDay: out.weekday,
  };
}

export async function storeTimeZone(storeId: string): Promise<string> {
  const store = await platform.store.findUnique({ where: { id: storeId }, select: { timezone: true } });
  return store && isValidTimezone(store.timezone) ? store.timezone : "UTC";
}

/**
 * Stock movement per active listing, read under the store's RLS. Velocity counts online
 * sales and reported counter sales only (ADR-0009). Windows are rolling 7 days back from `now`.
 */
export async function inventoryReport(
  storeId: string,
  options: { now?: Date; query?: string; listingIds?: string[] } = {},
): Promise<{ rows: MovementRow[]; totals: MovementTotals; timeZone: string }> {
  const now = options.now ?? new Date();
  let ids = options.listingIds;
  if (options.query !== undefined && options.query.trim() !== "") {
    const found = await searchListingMatches(storeId, options.query);
    const matched = found.listings.map((listing) => listing.id);
    ids = ids ? ids.filter((id) => matched.includes(id)) : matched;
  }
  const timeZone = await storeTimeZone(storeId);
  if (ids && ids.length === 0) return { rows: [], totals: sumTotals([]), timeZone };

  const since7 = new Date(now.getTime() - MOVEMENT_DAYS * DAY_MS);
  const since14 = new Date(now.getTime() - VELOCITY_DAYS * DAY_MS);
  const [listings, sums] = await Promise.all([
    storeScoped(storeId).listing.findMany({
      where: { active: true, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, customName: true, stockMode: true, qty: true, masterProduct: { select: { name: true } } },
    }),
    storeScopedRawQuery<{ listing_id: string } & EventSums>(storeId, Prisma.sql`
      SELECT
        listing_id,
        COALESCE(-SUM(delta) FILTER (WHERE type = 'sale' AND created_at >= ${since7}), 0)::int AS "online7",
        COALESCE(-SUM(delta) FILTER (WHERE type = 'sale' AND created_at < ${since7}), 0)::int AS "onlinePrior7",
        COALESCE(-SUM(delta) FILTER (WHERE type = 'counter_sale' AND created_at >= ${since7}), 0)::int AS "counter7",
        COALESCE(SUM(delta) FILTER (WHERE type = 'restock' AND created_at >= ${since7}), 0)::int AS "restocked7",
        COALESCE(-SUM(delta) FILTER (WHERE type = 'short' AND created_at >= ${since7}), 0)::int AS "short7",
        COALESCE(-SUM(delta) FILTER (WHERE type IN ('sale', 'counter_sale')), 0)::int AS "sold14"
      FROM stock_events
      WHERE store_id = ${storeId}
        AND type IN ('sale', 'counter_sale', 'restock', 'short')
        AND created_at >= ${since14} AND created_at < ${now}
        ${ids ? Prisma.sql`AND listing_id = ANY(${ids}::text[])` : Prisma.empty}
      GROUP BY listing_id
    `),
  ]);

  const byListing = new Map(sums.map((row) => [row.listing_id, row]));
  const rows = listings.map((listing): MovementRow => {
    const s = byListing.get(listing.id) ?? NO_EVENTS;
    return {
      listingId: listing.id,
      name: listingLabel(listing),
      stockMode: listing.stockMode,
      qty: listing.stockMode === "counted" ? listing.qty : null,
      online7: s.online7,
      onlinePrior7: s.onlinePrior7,
      counter7: s.counter7,
      restocked7: s.restocked7,
      short7: s.short7,
      estimate: estimateStock(listing, s.sold14, timeZone, now),
    };
  });
  rows.sort(compareRows);
  return { rows, totals: sumTotals(rows), timeZone };
}

/** Soonest to run out first, then the most sold, then by name. */
function compareRows(a: MovementRow, b: MovementRow): number {
  const left = (row: MovementRow) => (row.estimate.kind === "estimate" ? row.estimate.daysLeft : Number.POSITIVE_INFINITY);
  if (left(a) !== left(b)) return left(a) - left(b);
  const sold = (row: MovementRow) => row.online7 + row.counter7;
  if (sold(a) !== sold(b)) return sold(b) - sold(a);
  return a.name.localeCompare(b.name);
}

function sumTotals(rows: MovementRow[]): MovementTotals {
  return rows.reduce((t, row) => ({
    online: t.online + row.online7,
    onlinePrior: t.onlinePrior + row.onlinePrior7,
    counter: t.counter + row.counter7,
    restocked: t.restocked + row.restocked7,
    short: t.short + row.short7,
  }), { online: 0, onlinePrior: 0, counter: 0, restocked: 0, short: 0 });
}

/** One sentence for an estimate, shared by the page and the copilot's fixed reply. */
export function estimateText(estimate: StockEstimate): string {
  switch (estimate.kind) {
    case "estimate":
      return `About ${estimate.perDay} a day, ${estimate.daysLeft} ${estimate.daysLeft === 1 ? "day" : "days"} left, est. out ${estimate.outDay}`;
    case "not_enough_sales":
      return "Not enough sales to estimate";
    case "sold_out":
      return "Sold out";
    case "not_counted":
      return "Counts not tracked";
  }
}
