const DAY_MS = 24 * 60 * 60 * 1000;

/** Sales and shortage rates look this far back. */
export const CONFIDENCE_WINDOW_DAYS = 30;

/** Time and sales alone stop here: a quiet owner sees Limited, not Ask store (D8). */
const IDLE_FLOOR = 0.3;
/** Time constant of the decay. The score is 0.91 after a day and 0.575 after seven. */
const DECAY_DAYS = 7.5;
/** Penalties start after a day and reach full weight when the listing goes Limited. */
const GRACE_DAYS = 1;
const FULL_WEAR_DAYS = 7;
const SELL_THROUGH_WEIGHT = 0.4;
const RESTOCK_WEIGHT = 0.2;
const RESTOCK_STALE_DAYS = 60;
/** Short units at least equal to sold units is evidence enough to go below the floor. */
const SHORTAGE_RATE_BELOW_FLOOR = 0.5;

export interface ConfidenceListing {
  createdAt: Date;
  stockMode: string;
  qty: number | null;
}

/**
 * A stock event. The daily job passes one row per listing and type instead of
 * every event: `createdAt` is the newest, and `delta` is the sum over the last
 * `CONFIDENCE_WINDOW_DAYS`, so the result matches the raw events.
 */
export interface ConfidenceEvent {
  type: string;
  delta: number;
  createdAt: Date;
}

/** Elapsed days, never negative: an event dated after `now` is treated as just happened. */
function daysSince(from: Date, now: Date): number {
  return Math.max(0, now.getTime() - from.getTime()) / DAY_MS;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function newest(current: Date | null, next: Date): Date {
  return current && current > next ? current : next;
}

/**
 * How sure we are that a listing's recorded stock is still true, from 0 to 1.
 * Uses time since the last manual confirmation (`recount`, `restock` or `adjust`,
 * else `createdAt`), sales relative to recorded stock, the shortage rate, and time
 * since the last restock. Reservation events are ignored. It takes no
 * `confidenceUpdatedAt` because the daily job rewrites that column.
 */
export function computeConfidence(
  listing: ConfidenceListing,
  events: readonly ConfidenceEvent[],
  now: Date,
): number {
  let confirmedAt: Date | null = null;
  let restockedAt: Date | null = null;
  let lastShortAt: Date | null = null;
  let sold = 0;
  let short = 0;

  for (const event of events) {
    const recent = daysSince(event.createdAt, now) <= CONFIDENCE_WINDOW_DAYS;
    switch (event.type) {
      case "restock":
        restockedAt = newest(restockedAt, event.createdAt);
        confirmedAt = newest(confirmedAt, event.createdAt);
        break;
      case "recount":
      case "adjust":
        confirmedAt = newest(confirmedAt, event.createdAt);
        break;
      case "sale":
        if (recent) sold += Math.abs(event.delta);
        break;
      case "short":
        if (recent) {
          short += Math.abs(event.delta);
          lastShortAt = newest(lastShortAt, event.createdAt);
        }
        break;
    }
  }

  const age = daysSince(confirmedAt ?? listing.createdAt, now);
  const wear = clamp01((age - GRACE_DAYS) / (FULL_WEAR_DAYS - GRACE_DAYS));

  const dailySales = sold / CONFIDENCE_WINDOW_DAYS;
  const sellThrough =
    listing.stockMode === "counted" && listing.qty != null
      ? clamp01((dailySales * age) / Math.max(1, listing.qty))
      : 0;
  const restockStaleness = clamp01(daysSince(restockedAt ?? listing.createdAt, now) / RESTOCK_STALE_DAYS);

  let score =
    IDLE_FLOOR +
    (1 - IDLE_FLOOR) *
      Math.exp(-age / DECAY_DAYS) *
      (1 - SELL_THROUGH_WEIGHT * sellThrough * wear) *
      (1 - RESTOCK_WEIGHT * restockStaleness * wear);

  // A confirmation newer than the last short answered it.
  if (short > 0 && lastShortAt && (!confirmedAt || confirmedAt < lastShortAt)) {
    const shortageRate = short / (short + sold);
    score *= 1 - shortageRate * wear;
    if (shortageRate < SHORTAGE_RATE_BELOW_FLOOR) score = Math.max(IDLE_FLOOR, score);
  }

  return clamp01(score);
}
