import { Prisma, platform, storeScoped, storeScopedTransaction, txQuery } from "../db";
import { pushToStoreMembers } from "../push/store-members";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { listingLabel } from "./cards";
import { isValidTimezone } from "../order/store-hours";
import { stockBadge } from "../storefront/stock-badge";

/** Owner decision 2026-11-10: one store-wide threshold for counted listings. */
export const LOW_STOCK_THRESHOLD = 5;

export type AlertKind = "sold_out" | "running_low" | "order_needs_low_stock" | "confirm_request";

interface AlertDraft {
  kind: AlertKind;
  listingId: string;
  orderId?: string;
  dedupeKey: string;
}

interface AlertListing {
  id: string;
  active: boolean;
  stockMode: string;
  qty: number | null;
  status: string | null;
  confidence: number;
}

/** The store's calendar day, so the per-listing dedupe key rolls over at the owner's midnight. */
export async function storeDay(storeId: string, now = new Date()): Promise<string> {
  const store = await platform.store.findUnique({ where: { id: storeId }, select: { timezone: true } });
  const timeZone = store && isValidTimezone(store.timezone) ? store.timezone : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isSoldOut(listing: AlertListing): boolean {
  return (listing.stockMode === "counted" && listing.qty === 0)
    || (listing.stockMode === "status" && listing.status === "out_of_stock");
}

function isRunningLow(listing: AlertListing): boolean {
  if (isSoldOut(listing)) return false;
  if (listing.stockMode === "counted") return listing.qty != null && listing.qty <= LOW_STOCK_THRESHOLD;
  return listing.status === "low";
}

/** Writes each draft once per store; a repeated dedupe key is skipped. Returns how many were new. */
async function writeAlerts(storeId: string, drafts: AlertDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const written = await storeScopedTransaction(storeId, (tx) =>
    tx.copilotAlert.createMany({
      data: drafts.map((draft) => ({ storeId, ...draft })),
      skipDuplicates: true,
    }),
  );
  return written.count;
}

/**
 * Alerts for an authorized order, read after checkout reserved its stock: sold out and
 * running low per listing per day, and one alert for the order when any line is on a
 * low or ask-store listing.
 */
export async function createOrderStockAlerts(storeId: string, orderId: string): Promise<number> {
  const lines = await storeScopedTransaction(storeId, (tx) =>
    tx.orderLine.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: {
        listingVariant: {
          select: {
            listing: {
              select: { id: true, active: true, stockMode: true, qty: true, status: true, confidence: true },
            },
          },
        },
      },
    }),
  );
  const listings = new Map<string, AlertListing>();
  for (const line of lines) listings.set(line.listingVariant.listing.id, line.listingVariant.listing);

  const day = await storeDay(storeId);
  const drafts: AlertDraft[] = [];
  let needsAttention: string | null = null;
  for (const listing of listings.values()) {
    if (!listing.active) continue;
    if (isSoldOut(listing)) {
      drafts.push({ kind: "sold_out", listingId: listing.id, dedupeKey: `sold_out:${listing.id}:${day}` });
    } else if (isRunningLow(listing)) {
      drafts.push({ kind: "running_low", listingId: listing.id, dedupeKey: `running_low:${listing.id}:${day}` });
    }
    if (!needsAttention && (isRunningLow(listing) || stockBadge(listing) === "ask-store")) needsAttention = listing.id;
  }
  if (needsAttention) {
    drafts.push({
      kind: "order_needs_low_stock",
      listingId: needsAttention,
      orderId,
      dedupeKey: `order_needs_low_stock:${orderId}`,
    });
  }
  return writeAlerts(storeId, drafts);
}

/** Owner decision 2026-11-10: at most 2 alert pushes per store per hour. */
const PUSH_CAP = 2;
const PUSH_WINDOW_MS = 60 * 60_000;
const PUSH_BODY_ITEMS = 3;

export interface AlertView {
  id: string;
  kind: AlertKind;
  listingId: string;
  stockMode: string;
  text: string;
  createdAt: Date;
}

/** Template text, no model call: the alert's listing and order as they are now. */
export async function describeAlerts(
  storeId: string,
  alerts: Array<{ id: string; kind: string; listingId: string; orderId: string | null; createdAt: Date }>,
): Promise<AlertView[]> {
  if (alerts.length === 0) return [];
  const scoped = storeScoped(storeId);
  const orderIds = [...new Set(alerts.flatMap((a) => (a.orderId ? [a.orderId] : [])))];
  const [listings, orders] = await Promise.all([
    scoped.listing.findMany({
      where: { id: { in: [...new Set(alerts.map((a) => a.listingId))] } },
      select: { id: true, customName: true, stockMode: true, qty: true, masterProduct: { select: { name: true } } },
    }),
    orderIds.length > 0
      ? scoped.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })
      : Promise.resolve([]),
  ]);
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const numberById = new Map(orders.map((o) => [o.id, o.number]));
  return alerts.flatMap((alert) => {
    const listing = listingById.get(alert.listingId);
    if (!listing) return [];
    const name = listingLabel(listing);
    const left = listing.stockMode === "counted" && listing.qty != null ? `; you have ${listing.qty} left` : "";
    const text = {
      sold_out: `${name} is sold out`,
      running_low: `${name} is running low${left}`,
      order_needs_low_stock: `Order #${numberById.get(alert.orderId ?? "") ?? "?"} needs ${name}${left}`,
      confirm_request: `Do you still have ${name}?`,
    }[alert.kind as AlertKind] ?? name;
    return [{ id: alert.id, kind: alert.kind as AlertKind, listingId: alert.listingId, stockMode: listing.stockMode, text, createdAt: alert.createdAt }];
  });
}

/**
 * One push to the store's owners summarising every open alert not yet pushed, unless the
 * store already had its pushes this hour. Capped alerts keep `pushed_at` null and go out
 * with the next allowed push or the digest. Never throws for a push failure.
 */
export async function pushCopilotAlerts(
  storeId: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<void> {
  const waiting = await storeScoped(storeId).copilotAlert.count({ where: { state: "open", pushedAt: null } });
  if (waiting === 0) return;
  const allowed = await takeRateLimit(`copilot-push:${storeId}`, PUSH_CAP, PUSH_WINDOW_MS, now);
  if (!allowed.ok) return;

  const claimed = await storeScopedTransaction(storeId, (tx) => txQuery<Array<{
    id: string;
    kind: string;
    listing_id: string;
    order_id: string | null;
    created_at: Date;
  }>>(tx, Prisma.sql`
    UPDATE copilot_alerts
    SET pushed_at = ${new Date(now)}
    WHERE store_id = ${storeId} AND state = 'open' AND pushed_at IS NULL
    RETURNING id, kind, listing_id, order_id, created_at
  `));
  if (claimed.length === 0) return;

  const store = await platform.store.findUnique({ where: { id: storeId }, select: { slug: true } });
  if (!store) return;
  const views = await describeAlerts(storeId, claimed
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
    .map((row) => ({ id: row.id, kind: row.kind, listingId: row.listing_id, orderId: row.order_id, createdAt: row.created_at })));
  const shown = views.slice(0, PUSH_BODY_ITEMS).map((v) => v.text);
  const more = claimed.length - shown.length;
  const body = claimed.length === 1
    ? (shown[0] ?? "1 alert")
    : `${claimed.length} alerts: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;

  await pushToStoreMembers(storeId, {
    title: claimed.length === 1 ? "Stock alert" : "Stock alerts",
    body,
    url: `/store-admin/copilot?store=${encodeURIComponent(store.slug)}`,
    tag: "copilot-alerts",
  }, env, { roles: ["owner"] });
}
