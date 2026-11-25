import { salesRows, salesView } from "../analytics/queries";
import { MAX_CUSTOM_DAYS, addDays, daySpan, validDay, type AnalyticsRange } from "../analytics/range";
import { platformAdminTransaction } from "../db";
import { isValidTimezone } from "../order/store-hours";

export type PlatformTotals =
  | {
    ok: true;
    from: string;
    to: string;
    orders: number;
    goodsCents: number;
    refundsCents: number;
    netCents: number;
    storesWithOrders: number;
    /** Stores live now, not over the range. */
    activeStores: number;
  }
  | { ok: false; reason: string };

const BATCH = 10;

/**
 * The store analytics page's figures (#498), added across stores, each store read in its own store days.
 * Only stores with a captured order or a succeeded refund near the range are read; callers check the platform admin first.
 */
export async function platformTotals(from: string, to: string, now: Date = new Date()): Promise<PlatformTotals> {
  if (!validDay(from) || !validDay(to)) return { ok: false, reason: "from and to must be real dates, YYYY-MM-DD" };
  if (to < from) return { ok: false, reason: "from is after to" };
  if (from > now.toISOString().slice(0, 10)) return { ok: false, reason: "that range is in the future" };
  if (daySpan(from, to) > MAX_CUSTOM_DAYS) return { ok: false, reason: `at most ${MAX_CUSTOM_DAYS} days` };

  // A day either side covers every US store zone; salesRows then applies each store's own day bounds.
  const near = { gte: new Date(`${addDays(from, -1)}T00:00:00Z`), lt: new Date(`${addDays(to, 2)}T00:00:00Z`) };
  // A refund in the range can be on an order placed before it, so its store is read too.
  const [ordered, refunded, activeStores] = await platformAdminTransaction(async (tx) => Promise.all([
    tx.order.groupBy({ by: ["storeId"], where: { capturedAmountCents: { gt: 0 }, createdAt: near } }),
    tx.refundRequest.groupBy({ by: ["storeId"], where: { providerStatus: "succeeded", createdAt: near } }),
    tx.store.count({ where: { status: "active" } }),
  ]));
  const storeIds = [...new Set([...ordered, ...refunded].map((row) => row.storeId))];
  const zones = await platformAdminTransaction((tx) => tx.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, timezone: true } }));

  const range: AnalyticsRange = { preset: "custom", from, to };
  const totals = { orders: 0, goodsCents: 0, refundsCents: 0, netCents: 0, storesWithOrders: 0 };
  for (let start = 0; start < zones.length; start += BATCH) {
    const views = await Promise.all(zones.slice(start, start + BATCH).map(async (store) => {
      const zone = isValidTimezone(store.timezone) ? store.timezone : "UTC";
      return salesView(await salesRows(store.id, range, zone), range).totals;
    }));
    for (const view of views) {
      totals.orders += view.orders;
      totals.goodsCents += view.goodsCents;
      totals.refundsCents += view.refundsCents;
      totals.netCents += view.netCents;
      if (view.orders > 0) totals.storesWithOrders += 1;
    }
  }
  return { ok: true, from, to, ...totals, activeStores };
}
