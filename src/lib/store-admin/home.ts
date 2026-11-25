import { storeScoped } from "../db";
import { addDays, storeToday } from "../analytics/range";
import { salesRows, salesView } from "../analytics/queries";
import { isRunningLow } from "../copilot/alerts";
import { listingLabel } from "../copilot/cards";
import { ACTIVE_STATUSES } from "../order/service";

/** One row of the Home page's "Needs you now" list (#860); each links to the page that fixes it. */
export interface NeedsItem {
  key: string;
  kind: "orders" | "swap" | "payouts" | "stock" | "messages" | "go-live";
  title: string;
  detail: string;
  href: string;
}

export interface NeedsInput {
  storeSlug: string;
  isOwner: boolean;
  now: Date;
  newOrders: { count: number; oldestAt: Date | null };
  swaps: { id: string; number: number; customerName: string }[];
  /** Set while Stripe set-up is unfinished; owners only. */
  payoutsAlert: string | null;
  lowStock: { count: number; names: string[] };
  unreadMessages: number;
  goLive: { key: string; label: string; detail: string; done: boolean; href?: string }[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function minutesAgo(at: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 60) return plural(minutes, "minute", "minutes");
  const hours = Math.round(minutes / 60);
  return plural(hours, "hour", "hours");
}

export function needsYouNow(input: NeedsInput): NeedsItem[] {
  const store = `?store=${encodeURIComponent(input.storeSlug)}`;
  const items: NeedsItem[] = [];
  const { count, oldestAt } = input.newOrders;
  if (count > 0) {
    items.push({
      key: "orders",
      kind: "orders",
      title: `Accept ${plural(count, "new order", "new orders")}`,
      detail: oldestAt ? `${count === 1 ? "Placed" : "Oldest placed"} ${minutesAgo(oldestAt, input.now)} ago` : "",
      href: `/store-admin/orders${store}`,
    });
  }
  for (const swap of input.swaps) {
    items.push({
      key: `swap-${swap.id}`,
      kind: "swap",
      title: `${swap.customerName} is choosing a swap on #${swap.number}`,
      detail: "Their choice comes back to the pick list",
      href: `/store-admin/orders/${swap.id}${store}`,
    });
  }
  if (input.isOwner && input.payoutsAlert) {
    items.push({
      key: "payouts",
      kind: "payouts",
      title: `Payouts: ${input.payoutsAlert}`,
      detail: "Finish Stripe set-up so your sales reach your bank",
      href: `/store-admin/payouts${store}`,
    });
  }
  if (input.lowStock.count > 0) {
    items.push({
      key: "stock",
      kind: "stock",
      title: `${plural(input.lowStock.count, "product is", "products are")} running low`,
      detail: input.lowStock.names.length > 0 ? `${input.lowStock.names.join(" and ")} first` : "",
      href: `/store-admin/listings${store}`,
    });
  }
  if (input.unreadMessages > 0) {
    items.push({
      key: "messages",
      kind: "messages",
      title: plural(input.unreadMessages, "unread message", "unread messages"),
      detail: "Customers asking about their orders",
      href: `/store-admin/messages${store}`,
    });
  }
  for (const item of input.goLive) {
    if (item.done || !item.href) continue;
    items.push({ key: `go-live-${item.key}`, kind: "go-live", title: item.label, detail: item.detail, href: item.href });
  }
  return items;
}

/** Today's sales against the same weekday last week, in whole percent; null when last week sold nothing. */
export function compareToLastWeek(todayCents: number, lastWeekCents: number): number | null {
  if (lastWeekCents <= 0) return null;
  return Math.round(((todayCents - lastWeekCents) / lastWeekCents) * 100);
}

const LOW_STOCK_NAMED = 2;
const RECENT_ORDERS = 5;
const PACKING: readonly string[] = ["ACCEPTED", "PICKING", "SUBSTITUTION_PENDING"];

export interface StoreHome {
  today: { day: string; salesCents: number; lastWeekCents: number; orders: number; averageBasketCents: number };
  /** The last seven store days, oldest first, ending today. */
  week: { day: string; salesCents: number }[];
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
export async function storeHome(storeId: string, timeZone: string, now: Date = new Date()): Promise<StoreHome> {
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
    today: {
      day: today,
      salesCents: todays.goodsCents,
      lastWeekCents: days[0].goodsCents,
      orders: todays.orders,
      averageBasketCents: todays.averageOrderCents,
    },
    week: days.slice(1).map((day) => ({ day: day.day, salesCents: day.goodsCents })),
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
