import { directoryOrders, productsView, salesRows, salesView } from "../analytics/queries";
import { MAX_CUSTOM_DAYS, addDays, daySpan, storeToday, validDay, type AnalyticsRange } from "../analytics/range";
import { platform } from "../db";
import { money } from "../format";
import { isValidTimezone } from "../order/store-hours";
import { PAYOUTS_SHOWN, storePayouts } from "../payouts/service";
import { storeWeek } from "./inventory-report";

/**
 * The copilot's `sales_summary` tool (#818): the analytics page's figures (#498) and the payouts page's
 * Stripe payouts for one period, read only. Money is in dollars so the reply's number check can match it.
 */
export const SALES_PERIODS = ["today", "this_week", "last_week", "this_month", "range"] as const;
export type SalesPeriodInput = { period: (typeof SALES_PERIODS)[number]; from?: string; to?: string };
const TOP_ITEMS = 5;
/** Payout statuses that are money on its way or in the bank; failed and cancelled payouts never arrive. */
const ARRIVING = new Set(["paid", "in_transit", "pending"]);

/** Store days, inclusive. Weeks run Monday to Sunday, as in the weekly report. A bad range is refused, never guessed. */
export function salesPeriod(
  input: SalesPeriodInput,
  timeZone: string,
  now: Date,
): { ok: true; from: string; to: string } | { ok: false; reason: string } {
  const today = storeToday(timeZone, now);
  const monday = storeWeek(timeZone, now);
  if (input.period === "today") return { ok: true, from: today, to: today };
  if (input.period === "this_week") return { ok: true, from: monday, to: today };
  if (input.period === "last_week") return { ok: true, from: addDays(monday, -7), to: addDays(monday, -1) };
  if (input.period === "this_month") return { ok: true, from: `${today.slice(0, 7)}-01`, to: today };
  if (!validDay(input.from) || !validDay(input.to)) return { ok: false, reason: "from and to must be real dates, YYYY-MM-DD" };
  if (input.from > today) return { ok: false, reason: "that range is in the future" };
  const to = input.to > today ? today : input.to;
  if (to < input.from) return { ok: false, reason: "from is after to" };
  if (daySpan(input.from, to) > MAX_CUSTOM_DAYS) return { ok: false, reason: `at most ${MAX_CUSTOM_DAYS} days` };
  return { ok: true, from: input.from, to };
}

const dollars = (cents: number) => cents / 100;

export interface SalesFigures {
  from: string;
  to: string;
  orders: number;
  goodsCents: number;
  refundsCents: number;
  netCents: number;
  averageOrderCents: number;
  directoryOrders: number;
}

export type SalesPayout =
  | { known: true; arrivedCents: number; payouts: number }
  | { known: false; reason: string };

export async function salesSummary(storeId: string, input: SalesPeriodInput, now: Date = new Date()) {
  const store = await platform.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true, stripeAccountId: true } });
  const timeZone = isValidTimezone(store.timezone) ? store.timezone : "UTC";
  const period = salesPeriod(input, timeZone, now);
  if (!period.ok) return { ok: false as const, reason: period.reason };
  const range: AnalyticsRange = { preset: "custom", from: period.from, to: period.to };
  const [sales, products, fromDirectory, payout] = await Promise.all([
    salesRows(storeId, range, timeZone).then((rows) => salesView(rows, range).totals),
    productsView(storeId, range, timeZone),
    directoryOrders(storeId, range, timeZone),
    periodPayout({ id: storeId, stripeAccountId: store.stripeAccountId }, range),
  ]);
  const figures: SalesFigures = {
    from: range.from,
    to: range.to,
    orders: sales.orders,
    goodsCents: sales.goodsCents,
    refundsCents: sales.refundsCents,
    netCents: sales.netCents,
    averageOrderCents: sales.averageOrderCents,
    directoryOrders: fromDirectory,
  };
  const item = (row: { name: string; units: number; revenueCents: number }) => ({ name: row.name, units: row.units, sales: dollars(row.revenueCents) });
  const bySales = [...products.sellers].sort((a, b) => b.revenueCents - a.revenueCents || b.units - a.units || a.name.localeCompare(b.name));
  return {
    ok: true as const,
    figures,
    result: {
      from: range.from,
      to: range.to,
      timeZone,
      orders: sales.orders,
      goodsSales: dollars(sales.goodsCents),
      unitsSold: products.sellers.reduce((sum, row) => sum + row.units, 0),
      refunds: dollars(sales.refundsCents),
      netToStore: dollars(sales.netCents),
      averageOrder: dollars(sales.averageOrderCents),
      ordersFromDirectory: fromDirectory,
      topByQuantity: products.sellers.slice(0, TOP_ITEMS).map(item),
      topBySales: bySales.slice(0, TOP_ITEMS).map(item),
      payout: payout.known
        ? { known: true, arrived: dollars(payout.arrivedCents), payouts: payout.payouts }
        : payout,
      note: "Money is US dollars. Orders are captured orders placed in the period. Goods sales leave out the customer's service fee, tip and delivery fee. Net to store is after the card fee, service fee, courier fees, sales tax the platform remits and refunds. Payout is what Stripe sends to the bank with an arrival date in the period.",
    },
  };
}

/** Stripe payouts arriving in the period, from the payouts page's list. Unknown when the list may not reach back that far. */
async function periodPayout(store: { id: string; stripeAccountId: string | null }, range: AnalyticsRange): Promise<SalesPayout> {
  if (!store.stripeAccountId) return { known: false, reason: "Stripe payouts are not set up" };
  const listed = await storePayouts(store);
  if (!listed.ok) return { known: false, reason: "Stripe could not be reached" };
  // Stripe gives the arrival date as midnight UTC of the bank day.
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  const oldest = listed.payouts.at(-1);
  if (oldest && listed.payouts.length >= PAYOUTS_SHOWN && day(oldest.arrivalDate) > range.from) {
    return { known: false, reason: "the period is older than the payouts listed" };
  }
  const arriving = listed.payouts.filter((p) => ARRIVING.has(p.status) && day(p.arrivalDate) >= range.from && day(p.arrivalDate) <= range.to);
  return { known: true, arrivedCents: arriving.reduce((sum, p) => sum + p.amountCents, 0), payouts: arriving.length };
}

const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayText = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

/** The fixed reply line for a period, used when the model's text quotes a number no tool returned. */
export function salesText(f: SalesFigures): string {
  const period = f.from === f.to ? dayText(f.from) : `${dayText(f.from)} to ${dayText(f.to)}`;
  return `${period}: ${f.orders} orders, ${money(f.goodsCents)} goods sales, ${money(f.refundsCents)} refunded, `
    + `${money(f.netCents)} net to store, average order ${money(f.averageOrderCents)}.`;
}
