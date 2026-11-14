import { storeScoped } from "../db";

/** Ready-time bounds (#562): never book a courier sooner than the floor or later than the cap after packing starts. */
export const READY_FLOOR_MINUTES = 10;
export const READY_CAP_MINUTES = 45;
/** Packing pace for a store with too little history. */
export const DEFAULT_SECONDS_PER_ITEM = 90;
/** The store's recent packing times: its last courier orders packed, once it has at least the minimum. */
const HISTORY_ORDERS = 20;
const MIN_HISTORY_ORDERS = 3;
/** The one push a store gets when packing runs late. */
export const READY_PUSH_MINUTES = 5;

export type PackingSample = { items: number; seconds: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Minutes from packing start to ready: item count × the store's median pace per item, between the floor and the cap. */
export function readyMinutes(items: number, recent: PackingSample[]): number {
  const samples = recent.filter((s) => s.items > 0 && s.seconds > 0);
  const perItem = samples.length >= MIN_HISTORY_ORDERS ? median(samples.map((s) => s.seconds / s.items)) : DEFAULT_SECONDS_PER_ITEM;
  return Math.min(READY_CAP_MINUTES, Math.max(READY_FLOOR_MINUTES, Math.ceil((items * perItem) / 60)));
}

/** The store's recent packing times: picking start to Ready, per order, with its item count. */
async function recentPackingSamples(storeId: string, excludeOrderId: string): Promise<PackingSample[]> {
  const orders = await storeScoped(storeId).order.findMany({
    where: { id: { not: excludeOrderId }, pickingStartedAt: { not: null }, readyAt: { not: null } },
    orderBy: { readyAt: "desc" },
    take: HISTORY_ORDERS,
    select: { pickingStartedAt: true, readyAt: true, lines: { select: { qtyOrdered: true } } },
  });
  return orders.map((o) => ({
    items: o.lines.reduce((sum, l) => sum + l.qtyOrdered, 0),
    seconds: (o.readyAt!.getTime() - o.pickingStartedAt!.getTime()) / 1000,
  }));
}

/**
 * The order's ready time, set once when packing starts: a retried booking reuses it rather than moving it.
 * Counted from when picking started, so a late booking still aims at the same time.
 */
export async function orderReadyEstimate(storeId: string, orderId: string, now: Date): Promise<Date> {
  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { readyEstimateAt: true, pickingStartedAt: true, lines: { select: { qtyOrdered: true } } },
  });
  if (order.readyEstimateAt) return order.readyEstimateAt;
  const items = order.lines.reduce((sum, l) => sum + l.qtyOrdered, 0);
  const start = order.pickingStartedAt ?? now;
  const estimate = new Date(Math.max(start.getTime() + readyMinutes(items, await recentPackingSamples(storeId, orderId)) * 60_000, now.getTime()));
  await scoped.order.updateMany({ where: { id: orderId, readyEstimateAt: null }, data: { readyEstimateAt: estimate } });
  const stored = await scoped.order.findUniqueOrThrow({ where: { id: orderId }, select: { readyEstimateAt: true } });
  return stored.readyEstimateAt!;
}
