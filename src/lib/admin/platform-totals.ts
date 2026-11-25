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
    /** Each store day in the range, added across stores. */
    days: Array<{ day: string; orders: number; goodsCents: number }>;
    /** Each store read (one with an order or a refund near the range); `today` is its last day, `to`. */
    stores: Array<{ storeId: string; orders: number; goodsCents: number; today: { orders: number; goodsCents: number } }>;
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
  const days = new Map<string, { day: string; orders: number; goodsCents: number }>();
  const stores: Extract<PlatformTotals, { ok: true }>["stores"] = [];
  for (let start = 0; start < zones.length; start += BATCH) {
    const views = await Promise.all(zones.slice(start, start + BATCH).map(async (store) => {
      const zone = isValidTimezone(store.timezone) ? store.timezone : "UTC";
      return { storeId: store.id, view: salesView(await salesRows(store.id, range, zone), range) };
    }));
    for (const { storeId, view: { totals: view, days: storeDays } } of views) {
      totals.orders += view.orders;
      totals.goodsCents += view.goodsCents;
      totals.refundsCents += view.refundsCents;
      totals.netCents += view.netCents;
      if (view.orders > 0) totals.storesWithOrders += 1;
      for (const { day, orders, goodsCents } of storeDays) {
        const sum = days.get(day) ?? { day, orders: 0, goodsCents: 0 };
        sum.orders += orders;
        sum.goodsCents += goodsCents;
        days.set(day, sum);
      }
      const last = storeDays.find((row) => row.day === to);
      stores.push({ storeId, orders: view.orders, goodsCents: view.goodsCents, today: { orders: last?.orders ?? 0, goodsCents: last?.goodsCents ?? 0 } });
    }
  }
  const everyDay = Array.from({ length: daySpan(from, to) }, (_, index) => addDays(from, index));
  return {
    ok: true, from, to, ...totals, activeStores,
    days: everyDay.map((day) => days.get(day) ?? { day, orders: 0, goodsCents: 0 }),
    stores,
  };
}
