import { Prisma, storeScopedRawQuery } from "../db";
import { rangeDays, type AnalyticsRange } from "./range";

/**
 * Store analytics (#498, ADR-0021 Pro). Read-only, store-scoped (RLS plus an explicit store_id filter),
 * one query per view, all in integer cents. Days are store days in the store's time zone.
 *
 * Money rules, from what each order stored at capture (never recomputed rates):
 * - Goods = captured − tip − delivery fee.
 * - Card fee = the order's stored platform fee. Courier orders also pass the courier fee to the platform,
 *   capped with the card fee at captured, as at capture.
 * - Net to store = captured − card fee − courier fee − the store's share of succeeded refunds.
 * - A refund with refund_application_fee returns the platform's fee in proportion (Stripe's rule), never more
 *   than that fee across all the order's refunds, so the store bears the amount less that share; otherwise all of it.
 */

export const FULFILLMENTS = ["pickup", "store_delivery", "courier"] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

export interface SalesTotals {
  orders: number;
  goodsCents: number;
  averageOrderCents: number;
  refundsCents: number;
  cardFeeCents: number;
  courierFeeCents: number;
  netCents: number;
}
export interface SalesDay extends SalesTotals {
  day: string;
}
export interface SalesView {
  totals: SalesTotals;
  days: SalesDay[];
  byFulfillment: Array<SalesTotals & { fulfillment: Fulfillment }>;
}

export interface ProductRow {
  listingId: string;
  name: string;
  units: number;
  revenueCents: number;
}
export interface ShortRow {
  listingId: string;
  name: string;
  shortLines: number;
  swappedLines: number;
}
export interface ProductsView {
  sellers: ProductRow[];
  shortOrSwapped: ShortRow[];
  missedSearches: Array<{ query: string; searches: number }>;
}

export interface CustomersView {
  shoppers: number;
  newShoppers: number;
  returningShoppers: number;
  /** Shoppers in the range with two or more orders so far, as a whole percent. */
  repeatRatePct: number;
  repeatShoppers: number;
  orders: number;
  assistantOrders: number;
  browsingOrders: number;
}

export interface OperationsView {
  readyOrders: number;
  medianReadyMinutes: number | null;
  averageReadyMinutes: number | null;
  swapsAnswered: number;
  swapsTimedOut: number;
  swapsPending: number;
  cancellations: Array<{ reason: string; orders: number }>;
  /** Null until the store has a courier delivery in the range. */
  courier: { deliveries: number; delivered: number } | null;
}

export interface AssistantView {
  chatsInRange: number;
  ledToCart: number;
  ledToOrder: number;
}

export interface StoreAnalytics {
  range: AnalyticsRange;
  sales: SalesView;
  products: ProductsView;
  customers: CustomersView;
  operations: OperationsView;
  assistant: AssistantView;
}

function bounds(range: AnalyticsRange, timeZone: string) {
  return Prisma.sql`
    SELECT ((${range.from}::date)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC' AS lo,
           (((${range.to}::date + 1))::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC' AS hi`;
}

function storeDay(column: Prisma.Sql, timeZone: string) {
  return Prisma.sql`to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD')`;
}

type MoneyRow = {
  kind: "order" | "refund";
  day: string;
  fulfillment: string;
  orders: number;
  goods: number;
  card_fee: number;
  courier_fee: number;
  captured: number;
  refunds: number;
  refund_store_cost: number;
};

/** What the platform kept at capture: card fee plus courier fee, capped at captured (applicationFeeForCapture). */
const APPLICATION_FEE = Prisma.sql`LEAST(COALESCE(o.platform_fee_cents, 0) + CASE WHEN o.fulfillment = 'courier' THEN o.delivery_fee_cents ELSE 0 END, o.captured_amount_cents)`;

async function salesRows(storeId: string, range: AnalyticsRange, timeZone: string): Promise<MoneyRow[]> {
  return storeScopedRawQuery<MoneyRow>(storeId, Prisma.sql`
    WITH b AS (${bounds(range, timeZone)}),
    r AS (
      SELECT r.created_at, o.fulfillment, r.amount_cents, fee.total AS fee_total, share.proportional,
             SUM(share.proportional) OVER (PARTITION BY r.order_id ORDER BY r.created_at, r.id) AS running
      FROM refund_requests r
      JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
      CROSS JOIN LATERAL (SELECT ${APPLICATION_FEE} AS total) fee
      CROSS JOIN LATERAL (SELECT CASE WHEN r.refund_application_fee AND o.captured_amount_cents > 0
        THEN ROUND(fee.total::numeric * r.amount_cents / o.captured_amount_cents) ELSE 0 END AS proportional) share, b
      WHERE r.store_id = ${storeId} AND r.provider_status = 'succeeded' AND r.created_at < b.hi
    )
    SELECT 'order' AS kind, ${storeDay(Prisma.sql`o.created_at`, timeZone)} AS day, o.fulfillment,
           COUNT(*)::int AS orders,
           SUM(o.captured_amount_cents - o.tip_cents - o.delivery_fee_cents)::int AS goods,
           SUM(COALESCE(o.platform_fee_cents, 0))::int AS card_fee,
           SUM(${APPLICATION_FEE} - COALESCE(o.platform_fee_cents, 0))::int AS courier_fee,
           SUM(o.captured_amount_cents)::int AS captured,
           0 AS refunds, 0 AS refund_store_cost
    FROM orders o, b
    WHERE o.store_id = ${storeId} AND o.created_at >= b.lo AND o.created_at < b.hi AND o.captured_amount_cents > 0
    GROUP BY 2, 3
    UNION ALL
    -- Stripe returns the fee in proportion but never more than the fee in total across partial refunds (stripe/fake.ts).
    SELECT 'refund', ${storeDay(Prisma.sql`r.created_at`, timeZone)}, r.fulfillment,
           0, 0, 0, 0, 0,
           SUM(r.amount_cents)::int,
           SUM(r.amount_cents - (LEAST(r.fee_total, r.running) - LEAST(r.fee_total, r.running - r.proportional)))::int
    FROM r, b
    WHERE r.created_at >= b.lo
    GROUP BY 2, 3`);
}

function emptyTotals(): SalesTotals {
  return { orders: 0, goodsCents: 0, averageOrderCents: 0, refundsCents: 0, cardFeeCents: 0, courierFeeCents: 0, netCents: 0 };
}

function addRow(totals: SalesTotals, row: MoneyRow) {
  totals.orders += row.orders;
  totals.goodsCents += row.goods;
  totals.cardFeeCents += row.card_fee;
  totals.courierFeeCents += row.courier_fee;
  totals.refundsCents += row.refunds;
  totals.netCents += row.captured - row.card_fee - row.courier_fee - row.refund_store_cost;
}

function finish<T extends SalesTotals>(totals: T): T {
  totals.averageOrderCents = totals.orders > 0 ? Math.round(totals.goodsCents / totals.orders) : 0;
  return totals;
}

export function salesView(rows: MoneyRow[], range: AnalyticsRange): SalesView {
  const totals = emptyTotals();
  const days = new Map(rangeDays(range).map((day) => [day, { day, ...emptyTotals() }]));
  const byFulfillment = new Map(FULFILLMENTS.map((fulfillment) => [fulfillment as string, { fulfillment, ...emptyTotals() }]));
  for (const row of rows) {
    addRow(totals, row);
    const day = days.get(row.day);
    if (day) addRow(day, row);
    const split = byFulfillment.get(row.fulfillment);
    if (split) addRow(split, row);
  }
  return {
    totals: finish(totals),
    days: [...days.values()].map(finish),
    byFulfillment: [...byFulfillment.values()].map(finish),
  };
}

const LISTING_NAME = Prisma.sql`COALESCE(li.custom_name, mp.name, 'Unnamed item')`;

async function productsView(storeId: string, range: AnalyticsRange, timeZone: string): Promise<ProductsView> {
  const [sellers, shortOrSwapped, missedSearches] = await Promise.all([
    storeScopedRawQuery<ProductRow>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)}),
      o AS (
        SELECT o.id FROM orders o, b
        WHERE o.store_id = ${storeId} AND o.created_at >= b.lo AND o.created_at < b.hi AND o.captured_amount_cents > 0
      ),
      items AS (
        SELECT l.listing_variant_id AS variant_id,
               CASE WHEN l.status IN ('picked', 'refunded', 'substituted') THEN l.qty_picked ELSE l.qty_ordered END AS units,
               CASE WHEN l.status IN ('picked', 'refunded', 'substituted') THEN l.qty_picked ELSE l.qty_ordered END * l.unit_price_cents AS revenue
        FROM order_lines l JOIN o ON o.id = l.order_id
        WHERE l.store_id = ${storeId}
        UNION ALL
        SELECT l.substituted_variant_id, l.qty_ordered - l.qty_picked,
               (l.qty_ordered - l.qty_picked) * COALESCE(l.substituted_unit_price_cents, 0)
        FROM order_lines l JOIN o ON o.id = l.order_id
        WHERE l.store_id = ${storeId} AND l.status = 'substituted' AND l.substituted_variant_id IS NOT NULL
      )
      SELECT li.id AS "listingId", ${LISTING_NAME} AS name,
             SUM(items.units)::int AS units, SUM(items.revenue)::int AS "revenueCents"
      FROM items
      JOIN listing_variants v ON v.id = items.variant_id
      JOIN listings li ON li.id = v.listing_id
      LEFT JOIN master_products mp ON mp.id = li.master_product_id
      GROUP BY li.id, 2
      HAVING SUM(items.units) > 0
      ORDER BY units DESC, "revenueCents" DESC, name`),
    storeScopedRawQuery<ShortRow>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT li.id AS "listingId", ${LISTING_NAME} AS name,
             COUNT(*) FILTER (WHERE l.status <> 'substituted')::int AS "shortLines",
             COUNT(*) FILTER (WHERE l.status = 'substituted')::int AS "swappedLines"
      FROM orders o
      JOIN b ON true
      JOIN order_lines l ON l.order_id = o.id AND l.store_id = o.store_id
      JOIN listing_variants v ON v.id = l.listing_variant_id
      JOIN listings li ON li.id = v.listing_id
      LEFT JOIN master_products mp ON mp.id = li.master_product_id
      WHERE o.store_id = ${storeId} AND o.created_at >= b.lo AND o.created_at < b.hi
        AND (l.status IN ('short', 'refunded', 'substituted') OR (l.status = 'picked' AND l.qty_picked < l.qty_ordered))
      GROUP BY li.id, 2
      ORDER BY COUNT(*) DESC, name`),
    storeScopedRawQuery<{ query: string; searches: number }>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT lower(btrim(a.input->>'query')) AS query, COUNT(*)::int AS searches
      FROM ai_actions a, b
      WHERE a.store_id = ${storeId} AND a.tool = 'search_catalog' AND a.ok
        AND a.created_at >= b.lo AND a.created_at < b.hi
        AND jsonb_typeof(a.output->'items') = 'array' AND jsonb_array_length(a.output->'items') = 0
        AND btrim(COALESCE(a.input->>'query', '')) <> ''
      GROUP BY 1
      ORDER BY searches DESC, query
      LIMIT 50`),
  ]);
  return { sellers, shortOrSwapped, missedSearches };
}

/** An order from the shopper assistant: its cart's chat added at least one item. */
const ASSISTANT_CART = (cartId: Prisma.Sql, storeId: string) => Prisma.sql`EXISTS (
  SELECT 1 FROM ai_conversations ac
  JOIN ai_actions aa ON aa.conversation_id = ac.id AND aa.store_id = ac.store_id
  WHERE ac.store_id = ${storeId} AND ac.cart_id = ${cartId} AND aa.tool = 'add_to_cart' AND aa.ok)`;

async function customersView(storeId: string, range: AnalyticsRange, timeZone: string): Promise<CustomersView> {
  const [row] = await storeScopedRawQuery<Omit<CustomersView, "returningShoppers" | "repeatRatePct" | "browsingOrders">>(storeId, Prisma.sql`
    WITH b AS (${bounds(range, timeZone)}),
    o AS (
      SELECT o.id, o.source_cart_id, COALESCE(c.claimed_by_customer_id, c.id) AS shopper
      FROM orders o JOIN customers c ON c.id = o.customer_id AND c.store_id = o.store_id, b
      WHERE o.store_id = ${storeId} AND o.created_at >= b.lo AND o.created_at < b.hi AND o.captured_amount_cents > 0
    ),
    hist AS (
      SELECT COALESCE(c.claimed_by_customer_id, c.id) AS shopper, MIN(o.created_at) AS first_at, COUNT(*) AS orders
      FROM orders o JOIN customers c ON c.id = o.customer_id AND c.store_id = o.store_id, b
      WHERE o.store_id = ${storeId} AND o.created_at < b.hi AND o.captured_amount_cents > 0
        AND COALESCE(c.claimed_by_customer_id, c.id) IN (SELECT shopper FROM o)
      GROUP BY 1
    )
    SELECT (SELECT COUNT(*) FROM hist)::int AS shoppers,
           (SELECT COUNT(*) FROM hist, b WHERE hist.first_at >= b.lo)::int AS "newShoppers",
           (SELECT COUNT(*) FROM hist WHERE hist.orders >= 2)::int AS "repeatShoppers",
           (SELECT COUNT(*) FROM o)::int AS orders,
           (SELECT COUNT(*) FROM o WHERE o.source_cart_id IS NOT NULL AND ${ASSISTANT_CART(Prisma.sql`o.source_cart_id`, storeId)})::int AS "assistantOrders"`);
  return {
    ...row,
    returningShoppers: row.shoppers - row.newShoppers,
    repeatRatePct: row.shoppers > 0 ? Math.round((row.repeatShoppers * 100) / row.shoppers) : 0,
    browsingOrders: row.orders - row.assistantOrders,
  };
}

/** Cancel reasons as owners read them: the store's chosen reason, or what cancelled it. */
export const CANCEL_REASON_LABELS: Record<string, string> = {
  out_of_stock: "Out of stock",
  store_closed: "Store closed",
  too_busy: "Too busy",
  other: "Other (store)",
  auto_cancel: "Not accepted in time",
  pick_timeout: "Not ready in time",
  provider_canceled: "Card hold ended",
  unknown: "No reason recorded",
};

async function operationsView(storeId: string, range: AnalyticsRange, timeZone: string): Promise<OperationsView> {
  const [[ready], [swaps], cancellations, [courier]] = await Promise.all([
    storeScopedRawQuery<{ readyOrders: number; median: number | null; average: number | null }>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT COUNT(*)::int AS "readyOrders",
             ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM o.ready_at - o.created_at)) / 60)::int AS median,
             ROUND(AVG(EXTRACT(EPOCH FROM o.ready_at - o.created_at)) / 60)::int AS average
      FROM orders o, b
      WHERE o.store_id = ${storeId} AND o.created_at >= b.lo AND o.created_at < b.hi AND o.ready_at IS NOT NULL`),
    storeScopedRawQuery<{ answered: number; timedOut: number; pending: number }>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT COUNT(*) FILTER (WHERE s.status IN ('approved', 'declined'))::int AS answered,
             COUNT(*) FILTER (WHERE s.status = 'timed_out')::int AS "timedOut",
             COUNT(*) FILTER (WHERE s.status = 'pending')::int AS pending
      FROM substitution_requests s, b
      WHERE s.store_id = ${storeId} AND s.created_at >= b.lo AND s.created_at < b.hi`),
    storeScopedRawQuery<{ reason: string; orders: number }>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT COALESCE(cause.reason, 'unknown') AS reason, COUNT(*)::int AS orders
      FROM orders o
      JOIN b ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN a.action = 'store_cancel' THEN COALESCE(a.after->>'reason', 'other') ELSE a.action END AS reason
        FROM audit_logs a
        WHERE a.entity_type = 'order' AND a.entity_id = o.id AND a.store_id = ${storeId}
          AND a.action IN ('store_cancel', 'auto_cancel', 'pick_timeout', 'provider_canceled')
        ORDER BY a.created_at DESC
        LIMIT 1
      ) cause ON true
      WHERE o.store_id = ${storeId} AND o.status = 'CANCELLED' AND o.cancelled_at >= b.lo AND o.cancelled_at < b.hi
      GROUP BY 1
      ORDER BY orders DESC, reason`),
    storeScopedRawQuery<{ deliveries: number; delivered: number }>(storeId, Prisma.sql`
      WITH b AS (${bounds(range, timeZone)})
      SELECT COUNT(DISTINCT d.order_id)::int AS deliveries,
             COUNT(DISTINCT d.order_id) FILTER (WHERE o.delivered_at IS NOT NULL)::int AS delivered
      FROM deliveries d
      JOIN orders o ON o.id = d.order_id AND o.store_id = d.store_id, b
      WHERE d.store_id = ${storeId} AND d.created_at >= b.lo AND d.created_at < b.hi`),
  ]);
  return {
    readyOrders: ready.readyOrders,
    medianReadyMinutes: ready.median,
    averageReadyMinutes: ready.average,
    swapsAnswered: swaps.answered,
    swapsTimedOut: swaps.timedOut,
    swapsPending: swaps.pending,
    cancellations,
    courier: courier.deliveries > 0 ? courier : null,
  };
}

async function assistantView(storeId: string, range: AnalyticsRange, timeZone: string): Promise<AssistantView> {
  const [row] = await storeScopedRawQuery<AssistantView>(storeId, Prisma.sql`
    WITH b AS (${bounds(range, timeZone)})
    SELECT COUNT(*)::int AS "chatsInRange",
           COUNT(*) FILTER (WHERE ${ASSISTANT_CART(Prisma.sql`c.cart_id`, storeId)})::int AS "ledToCart",
           COUNT(*) FILTER (WHERE ${ASSISTANT_CART(Prisma.sql`c.cart_id`, storeId)} AND EXISTS (
             SELECT 1 FROM orders o WHERE o.store_id = ${storeId} AND o.source_cart_id = c.cart_id AND o.created_at >= c.created_at
               AND o.captured_amount_cents > 0
           ))::int AS "ledToOrder"
    FROM ai_conversations c, b
    WHERE c.store_id = ${storeId} AND c.created_at >= b.lo AND c.created_at < b.hi`);
  return row;
}

export async function storeAnalytics(storeId: string, timeZone: string, range: AnalyticsRange): Promise<StoreAnalytics> {
  const [sales, products, customers, operations, assistant] = await Promise.all([
    salesRows(storeId, range, timeZone).then((rows) => salesView(rows, range)),
    productsView(storeId, range, timeZone),
    customersView(storeId, range, timeZone),
    operationsView(storeId, range, timeZone),
    assistantView(storeId, range, timeZone),
  ]);
  return { range, sales, products, customers, operations, assistant };
}
