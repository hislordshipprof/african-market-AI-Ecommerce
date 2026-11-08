import type { PrismaClient } from "@prisma/client";
import { lockListingRows, writeListingQuantities, type LockedListingStock } from "../db";
import { SYSTEM_ACTOR_ID } from "../system-actor";

/**
 * Moves counted stock through the order lifecycle. Every function runs inside the
 * caller's transaction, after its status guard and under its store lock, and locks
 * the listings it touches in id order before any insert.
 *
 * One event per line and moment, keyed in `stock_events.idempotency_key`. A key that
 * already exists skips both the event and the qty change.
 *
 * Nothing here throws on a business condition. An inactive listing, zero stock or a
 * changed stock mode must not stop an order the customer's card already backs.
 */

type LedgerTx = Pick<PrismaClient, "stockEvent" | "orderLine" | "$queryRaw" | "$executeRaw">;

/**
 * Absolute counts. Newer than a reservation, they supersede its release.
 * A restock or counter sale is relative, so a later cancel still returns the reserved units.
 */
export const SUPERSEDING_EVENT_TYPES = ["recount", "adjust"];

interface LedgerLine {
  id: string;
  /** The listing the order reserved from. */
  listingId: string;
  qtyPicked: number;
  status: string;
  /** Only for a `substituted` line: a named substitute on a `picked` line sold nothing. */
  substituteListingId: string | null;
}

type ReleaseMoment = "release-short" | "release-capture" | "release-cancel";
const RELEASE_MOMENTS: ReleaseMoment[] = ["release-short", "release-capture", "release-cancel"];
const CONSUME_MOMENTS = ["short", "sale"];

function isCounted(stock: LockedListingStock | undefined): stock is LockedListingStock & { qty: number } {
  return stock?.stockMode === "counted" && stock.qty != null;
}

async function writeEvents(
  tx: LedgerTx,
  storeId: string,
  events: Array<{ listingId: string; type: string; delta: number; key: string }>,
  createdAt: Date,
): Promise<void> {
  if (events.length === 0) return;
  await tx.stockEvent.createMany({
    data: events.map((event) => ({
      storeId,
      listingId: event.listingId,
      type: event.type,
      delta: event.delta,
      actorId: SYSTEM_ACTOR_ID,
      idempotencyKey: event.key,
      createdAt,
    })),
  });
}

async function writeQuantities(
  tx: LedgerTx,
  stock: Map<string, LockedListingStock>,
  touched: Set<string>,
  now: Date,
): Promise<void> {
  const rows = [...touched].flatMap((id) => {
    const row = stock.get(id);
    return isCounted(row) ? [{ id: row.id, qty: row.qty }] : [];
  });
  await writeListingQuantities(tx, rows, now);
}

/**
 * Placement. `stock` comes from `lockListingRows`, called before the order lines were
 * inserted. Two lines on one listing apply in sequence, each clamped to what is left.
 */
export async function reserveOrderStock(
  tx: LedgerTx,
  storeId: string,
  lines: Array<{ id: string; listingId: string; qtyOrdered: number }>,
  locked: LockedListingStock[],
): Promise<void> {
  const stock = new Map(locked.map((row) => [row.id, { ...row }]));
  const touched = new Set<string>();
  const events = [];
  for (const line of lines) {
    const row = stock.get(line.listingId);
    if (!isCounted(row)) continue;
    const taken = Math.min(row.qty, line.qtyOrdered);
    if (taken <= 0) continue;
    row.qty -= taken;
    touched.add(row.id);
    events.push({ listingId: row.id, type: "reservation", delta: -taken, key: `reservation:${line.id}` });
  }
  const now = new Date();
  await writeEvents(tx, storeId, events, now);
  await writeQuantities(tx, stock, touched, now);
}

async function linesForLedger(
  tx: LedgerTx,
  where: { orderId: string } | { id: string },
): Promise<LedgerLine[]> {
  const rows = await tx.orderLine.findMany({
    where,
    select: {
      id: true,
      qtyPicked: true,
      status: true,
      listingVariant: { select: { listingId: true } },
      substituteVariant: { select: { listingId: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    listingId: row.listingVariant.listingId,
    qtyPicked: row.qtyPicked,
    status: row.status,
    substituteListingId: row.status === "substituted" ? (row.substituteVariant?.listingId ?? null) : null,
  }));
}

async function openLedger(tx: LedgerTx, storeId: string, lines: LedgerLine[]) {
  const listingIds = [
    ...new Set(lines.flatMap((line) => (line.substituteListingId ? [line.listingId, line.substituteListingId] : [line.listingId]))),
  ];
  const stock = new Map((await lockListingRows(tx, listingIds)).map((row) => [row.id, row]));
  const keys = lines.flatMap((line) =>
    ["reservation", ...RELEASE_MOMENTS, ...CONSUME_MOMENTS].map((moment) => `${moment}:${line.id}`),
  );
  const [written, confirmations] = await Promise.all([
    tx.stockEvent.findMany({
      where: { storeId, idempotencyKey: { in: keys } },
      select: { idempotencyKey: true, delta: true, createdAt: true },
    }),
    tx.stockEvent.groupBy({
      by: ["listingId"],
      where: { storeId, listingId: { in: listingIds }, type: { in: SUPERSEDING_EVENT_TYPES } },
      _max: { createdAt: true },
    }),
  ]);
  const byKey = new Map(written.map((row) => [row.idempotencyKey, row]));
  const confirmedAt = new Map(confirmations.map((row) => [row.listingId, row._max.createdAt]));
  const events: Array<{ listingId: string; type: string; delta: number; key: string }> = [];
  const touched = new Set<string>();

  /** Reserved units on this line that no earlier moment returned. */
  function stillReserved(lineId: string): number {
    const reservation = byKey.get(`reservation:${lineId}`);
    if (!reservation) return 0;
    const released = RELEASE_MOMENTS.reduce((sum, moment) => sum + (byKey.get(`${moment}:${lineId}`)?.delta ?? 0), 0);
    return Math.max(0, -reservation.delta - released);
  }

  return {
    /** Writes no row when there is nothing to return. A delta of 0 means D9 or a stock-mode change. */
    release(line: LedgerLine, moment: ReleaseMoment, upTo = Number.POSITIVE_INFINITY) {
      const key = `${moment}:${line.id}`;
      if (byKey.has(key)) return;
      const units = Math.min(upTo, stillReserved(line.id));
      if (units <= 0) return;
      const row = stock.get(line.listingId);
      const reservedAt = byKey.get(`reservation:${line.id}`)!.createdAt;
      const confirmed = confirmedAt.get(line.listingId);
      // A tie counts as confirmed. Any error then stays low, which cannot oversell.
      const superseded = confirmed != null && confirmed >= reservedAt;
      const moved = isCounted(row) && !superseded;
      if (moved) {
        row.qty += units;
        touched.add(row.id);
      }
      events.push({ listingId: line.listingId, type: "reservation_release", delta: moved ? units : 0, key });
    },
    /** `sale` and `short` record true units. Only the qty clamps. */
    consume(listingId: string, type: "sale" | "short", units: number, lineId: string) {
      const key = `${type}:${lineId}`;
      if (byKey.has(key) || units <= 0) return;
      const row = stock.get(listingId);
      if (isCounted(row)) {
        row.qty = Math.max(0, row.qty - units);
        touched.add(row.id);
      }
      events.push({ listingId, type, delta: -units, key });
    },
    async flush() {
      const now = new Date();
      await writeEvents(tx, storeId, events, now);
      await writeQuantities(tx, stock, touched, now);
    },
  };
}

/** Capture. The line's status chooses the sale listing, never the presence of a substitute. */
export async function settleCapturedStock(tx: LedgerTx, storeId: string, orderId: string): Promise<void> {
  const lines = await linesForLedger(tx, { orderId });
  const ledger = await openLedger(tx, storeId, lines);
  for (const line of lines) {
    ledger.release(line, "release-capture");
    if (line.status === "refunded") continue;
    if (line.status === "substituted" && !line.substituteListingId) {
      console.error(JSON.stringify({ event: "stock_sale_without_substitute", lineId: line.id }));
      continue;
    }
    ledger.consume(line.substituteListingId ?? line.listingId, "sale", line.qtyPicked, line.id);
  }
  await ledger.flush();
}

/** A picker found fewer than ordered. Called under the same lock that set the line status. */
export async function settleShortLine(
  tx: LedgerTx,
  storeId: string,
  lineId: string,
  unfulfilled: number,
): Promise<void> {
  const lines = await linesForLedger(tx, { id: lineId });
  const ledger = await openLedger(tx, storeId, lines);
  for (const line of lines) {
    ledger.release(line, "release-short", unfulfilled);
    ledger.consume(line.listingId, "short", unfulfilled, line.id);
  }
  await ledger.flush();
}

/** Cancel, void or auto-cancel: returns what the order still holds, once. */
export async function releaseOrderStock(tx: LedgerTx, storeId: string, orderId: string): Promise<void> {
  const lines = await linesForLedger(tx, { orderId });
  const ledger = await openLedger(tx, storeId, lines);
  for (const line of lines) ledger.release(line, "release-cancel");
  await ledger.flush();
}
