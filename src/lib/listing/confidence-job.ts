import { findStoreIdsAfter, readStockEventRollups, storeScopedTransaction, writeConfidenceScores } from "../db";
import { CONFIRMING_EVENT_TYPES } from "../order/stock-ledger";
import { computeConfidence, CONFIDENCE_WINDOW_DAYS, type ConfidenceEvent } from "./confidence";

const STORES_PER_BATCH = 100;
/** A step past Vercel's limit retries from the same cursor and the stores after it never decay. */
const BATCH_BUDGET_MS = 120_000;
const WRITE_PAGE_SIZE = 500;
const TRANSACTION = { timeout: 30_000, maxWait: 8_000 };
const SIGNAL_EVENT_TYPES = [...CONFIRMING_EVENT_TYPES, "sale", "short"];

async function recomputeStore(storeId: string): Promise<number> {
  // Inside the step: replay must not reuse an older clock.
  const now = new Date();
  const windowStart = new Date(now.getTime() - CONFIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { listings, rollups } = await storeScopedTransaction(storeId, async (tx) => {
    const listings = await tx.listing.findMany({
      where: { storeId, active: true },
      select: { id: true, createdAt: true, stockMode: true, qty: true, confidenceUpdatedAt: true },
    });
    if (listings.length === 0) return { listings, rollups: [] };
    return { listings, rollups: await readStockEventRollups(tx, storeId, SIGNAL_EVENT_TYPES, windowStart) };
  }, TRANSACTION);

  const eventsByListing = new Map<string, ConfidenceEvent[]>();
  for (const row of rollups) {
    const events = eventsByListing.get(row.listingId) ?? [];
    events.push(row);
    eventsByListing.set(row.listingId, events);
  }

  const scored = listings.map((listing) => ({
    id: listing.id,
    confidence: computeConfidence(listing, eventsByListing.get(listing.id) ?? [], now),
    readAt: listing.confidenceUpdatedAt.toISOString(),
  }));

  for (let start = 0; start < scored.length; start += WRITE_PAGE_SIZE) {
    const page = scored.slice(start, start + WRITE_PAGE_SIZE);
    await storeScopedTransaction(storeId, (tx) => writeConfidenceScores(tx, page, now), TRANSACTION);
  }
  return scored.length;
}

export interface ConfidenceBatchResult {
  /** Null once every store has been visited. */
  nextCursor: string | null;
  stores: number;
  failed: number;
  listings: number;
}

/**
 * One step of the daily job: up to 100 stores, stopping early on time. Step output is
 * serialized, so this returns only strings and numbers. A store that fails is logged and
 * waits for tomorrow, but a batch where every store failed throws so Inngest retries it,
 * because that looks like the database and not one store.
 */
export async function recomputeConfidenceBatch(cursor: string | null): Promise<ConfidenceBatchResult> {
  const storeIds = await findStoreIdsAfter(cursor, STORES_PER_BATCH);
  const startedAt = Date.now();
  let stores = 0;
  let failed = 0;
  let listings = 0;
  let lastVisited: string | null = null;

  for (const storeId of storeIds) {
    lastVisited = storeId;
    stores += 1;
    try {
      listings += await recomputeStore(storeId);
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({
        event: "confidence_store_failed",
        storeId,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
    if (Date.now() - startedAt >= BATCH_BUDGET_MS) break;
  }

  if (stores > 0 && failed === stores) {
    throw new Error(`Daily confidence failed for all ${stores} stores in this batch`);
  }
  const finished = stores === storeIds.length && storeIds.length < STORES_PER_BATCH;
  return { nextCursor: finished ? null : lastVisited, stores, failed, listings };
}
