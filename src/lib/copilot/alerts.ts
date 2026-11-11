import { platform, storeScopedTransaction } from "../db";
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
