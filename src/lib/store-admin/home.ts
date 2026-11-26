import { storeScoped } from "../db";
import { addDays, storeToday } from "../analytics/range";
import { salesRows, salesView } from "../analytics/queries";
import { isRunningLow } from "../copilot/alerts";
import { listingLabel } from "../copilot/cards";
import { ACTIVE_STATUSES } from "../order/service";

const LOW_STOCK_NAMED = 2;
const RECENT_ORDERS = 5;
const PACKING: readonly string[] = ["ACCEPTED", "PICKING", "SUBSTITUTION_PENDING"];

export interface StoreHome {
  today: { day: string; orders: number };
  /** Store revenue, owner-only (platform-spec §3: analytics is the owner's); null for staff. */
  sales: {
    todayCents: number;
    lastWeekCents: number;
    averageBasketCents: number;
    /** The last seven store days, oldest first, ending today. */
    week: { day: string; salesCents: number }[];
  } | null;
  toPack: { total: number; fresh: number; packing: number };
  newOrders: { count: number; oldestAt: Date | null };
  swaps: { id: string; number: number; customerName: string }[];
  lowStock: { count: number; names: string[] };
  recent: { id: string; number: number; customerName: string; status: string; fulfillment: string; totalCents: number; createdAt: Date; active: boolean }[];
}

/**
 * The Home page's numbers (#860). Sales are the Analytics page's goods revenue (captured orders, by store day),
 * so Home and Analytics never disagree.
 */
export async function storeHome(storeId: string, timeZone: string, now: Date, options: { sales: boolean }): Promise<StoreHome> {
  const today = storeToday(timeZone, now);
  const range = { preset: "custom" as const, from: addDays(today, -7), to: today };
  const scoped = storeScoped(storeId);
  const [rows, active, listings, recent] = await Promise.all([
    salesRows(storeId, range, timeZone),
    scoped.order.findMany({
      where: { status: { in: ["AUTHORIZED", ...PACKING] } },
      select: { id: true, number: true, status: true, createdAt: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    scoped.listing.findMany({
      where: { active: true },
      select: { stockMode: true, qty: true, status: true, customName: true, masterProduct: { select: { name: true } } },
    }),
    scoped.order.findMany({
      select: { id: true, number: true, status: true, fulfillment: true, totalCents: true, subtotalCents: true, createdAt: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: RECENT_ORDERS,
    }),
  ]);
  const days = salesView(rows, range).days;
  const todays = days[days.length - 1];
  const fresh = active.filter((order) => order.status === "AUTHORIZED");
  const low = listings
    .filter(isRunningLow)
    .sort((a, b) => (a.qty ?? Infinity) - (b.qty ?? Infinity));
  return {
    today: { day: today, orders: todays.orders },
    sales: options.sales
      ? {
          todayCents: todays.goodsCents,
          lastWeekCents: days[0].goodsCents,
          averageBasketCents: todays.averageOrderCents,
          week: days.slice(1).map((day) => ({ day: day.day, salesCents: day.goodsCents })),
        }
      : null,
    toPack: { total: active.length, fresh: fresh.length, packing: active.length - fresh.length },
    newOrders: { count: fresh.length, oldestAt: fresh[0]?.createdAt ?? null },
    swaps: active
      .filter((order) => order.status === "SUBSTITUTION_PENDING")
      .map((order) => ({ id: order.id, number: order.number, customerName: order.customer.name })),
    lowStock: { count: low.length, names: low.slice(0, LOW_STOCK_NAMED).map(listingLabel) },
    recent: recent.map((order) => ({
      id: order.id,
      number: order.number,
      customerName: order.customer.name,
      status: order.status,
      fulfillment: order.fulfillment,
      totalCents: order.totalCents || order.subtotalCents,
      createdAt: order.createdAt,
      active: (ACTIVE_STATUSES as string[]).includes(order.status),
    })),
  };
}
