import { CANCEL_REASON_LABELS, type StoreAnalytics } from "./queries";

export const ANALYTICS_VIEWS = ["sales", "products", "customers", "operations", "assistant"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export const FULFILLMENT_LABELS: Record<string, string> = {
  pickup: "Pickup",
  store_delivery: "Store delivery",
  courier: "Courier",
};

/** Cents as dollars with two decimals, so a spreadsheet sums them exactly. */
export function csvDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function cell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // A leading =, +, - or @ would run as a formula in a spreadsheet; shopper search text can start with one.
  // A plain number such as a negative amount cannot run, and must stay a number so the sheet sums it.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows: Array<Array<string | number | null>>): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

type Totals = StoreAnalytics["sales"]["totals"];
const salesCells = (t: Totals) => [
  t.orders,
  csvDollars(t.goodsCents),
  csvDollars(t.averageOrderCents),
  csvDollars(t.refundsCents),
  csvDollars(t.cardFeeCents),
  csvDollars(t.courierFeeCents),
  csvDollars(t.netCents),
];

/** One CSV per view, built from the same numbers the page shows. */
export function analyticsCsv(view: AnalyticsView, data: StoreAnalytics, chatUsage: { chats: number; cap: number }): string {
  const range = `${data.range.from} to ${data.range.to}`;
  switch (view) {
    case "sales":
      return toCsv([
        ["Row", "Orders", "Goods revenue", "Average order", "Refunds", "Card fee", "Courier fee", "Net to store"],
        ...data.sales.days.map((d) => [d.day, ...salesCells(d)]),
        ...data.sales.byFulfillment.map((f) => [FULFILLMENT_LABELS[f.fulfillment] ?? f.fulfillment, ...salesCells(f)]),
        [`Total ${range}`, ...salesCells(data.sales.totals)],
      ]);
    case "products":
      return toCsv([
        ["Section", "Item", "Units", "Revenue", "Short lines", "Swapped lines", "Searches"],
        ...data.products.sellers.map((p) => ["Top seller", p.name, p.units, csvDollars(p.revenueCents), null, null, null]),
        ...data.products.shortOrSwapped.map((p) => ["Short or swapped", p.name, null, null, p.shortLines, p.swappedLines, null]),
        ...data.products.missedSearches.map((s) => ["Searched, not carried", s.query, null, null, null, null, s.searches]),
      ]);
    case "customers": {
      const c = data.customers;
      return toCsv([
        ["Measure", range],
        ["Shoppers", c.shoppers],
        ["New shoppers", c.newShoppers],
        ["Returning shoppers", c.returningShoppers],
        ["Repeat shoppers (2+ orders)", c.repeatShoppers],
        ["Repeat rate %", c.repeatRatePct],
        ["Orders", c.orders],
        ["Orders from the shopping assistant", c.assistantOrders],
        ["Orders from browsing", c.browsingOrders],
      ]);
    }
    case "operations": {
      const o = data.operations;
      return toCsv([
        ["Measure", range],
        ["Orders made ready", o.readyOrders],
        ["Median minutes order to ready", o.medianReadyMinutes],
        ["Average minutes order to ready", o.averageReadyMinutes],
        ["Swap prompts answered", o.swapsAnswered],
        ["Swap prompts timed out", o.swapsTimedOut],
        ["Swap prompts waiting", o.swapsPending],
        ...o.cancellations.map((c) => [`Cancelled: ${CANCEL_REASON_LABELS[c.reason] ?? c.reason}`, c.orders]),
        ...(o.courier
          ? [["Courier deliveries", o.courier.deliveries], ["Courier deliveries completed", o.courier.delivered]]
          : []),
      ]);
    }
    case "assistant": {
      const a = data.assistant;
      return toCsv([
        ["Measure", range],
        ["Chats this month", chatUsage.chats],
        ["Plan cap", chatUsage.cap],
        ["Chats", a.chatsInRange],
        ["Chats that added to the cart", a.ledToCart],
        ["Chats that led to an order", a.ledToOrder],
      ]);
    }
  }
}
