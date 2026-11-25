import { lockStoreRow, platform, storeScopedTransaction, updateStoreOneOff } from "../db";
import { revalidateStore } from "../get-store";
import { addDays, storeToday, validDay } from "../analytics/range";
import { storeLocalToUtc } from "../store-local-time";
import { parseTimeMinutes } from "../order/store-hours";
import { activeDeliveryPause, pauseEndLabel } from "../delivery/delivery-pause";
import { twelveHour, WEEK_DAYS } from "./weekly-hours";

/**
 * A one-day change the owner confirms (#819). Weekly hours never change: a day goes under `hours.dates`, keyed by
 * the store-local date, and a delivery pause is `stores.delivery_paused_until`.
 */
export type StoreChange =
  | { kind: "day_hours"; date: string; closed: true }
  | { kind: "day_hours"; date: string; closed: false; open: string; close: string }
  | { kind: "delivery_pause"; until: string };

type Tx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];
type Actor = { id: string; email: string };
type Hours = Record<string, unknown>;

const DAYS_AHEAD = 13;
const PAUSE_MAX_MS = 7 * 24 * 60 * 60_000;
const CLOCK = /^\d{2}:\d{2}$/;

function hoursObject(hours: unknown): Hours | null {
  return typeof hours === "object" && hours !== null && !Array.isArray(hours) ? (hours as Hours) : null;
}

function storedDates(hours: unknown): Hours {
  return hoursObject(hoursObject(hours)?.dates) ?? {};
}

/** The one-off days from today on in the store's zone; past days are dropped. */
function currentDates(hours: unknown, timezone: string, now: Date): Hours {
  const today = storeToday(timezone, now);
  return Object.fromEntries(Object.entries(storedDates(hours)).filter(([date]) => date >= today));
}

function withDates(hours: Hours, dates: Hours): Hours {
  const week = { ...hours };
  delete week.dates;
  return Object.keys(dates).length > 0 ? { ...week, dates } : week;
}

/**
 * Newly saved weekly hours with the store's current one-off days kept (past days dropped). Hours that are not an
 * object (none set: always open) are returned as they are, so a store with no hours never becomes closed.
 */
export function keepOneOffDays<T>(saved: T, previous: unknown, timezone: string, now: Date): T {
  const week = hoursObject(saved);
  if (!week || "dates" in week) return saved;
  return withDates(week, currentDates(previous, timezone, now)) as T;
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(",", "");
}

function dayValue(change: Extract<StoreChange, { kind: "day_hours" }>): string {
  return change.closed ? "Closed" : `${twelveHour(change.open)} - ${twelveHour(change.close)}`;
}

function describe(value: unknown): string | null {
  if (value == null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function auditChange(tx: Tx, storeId: string, actor: Actor, action: string, before: Hours, after: Hours) {
  return tx.auditLog.create({
    data: { storeId, actorId: actor.id, actorEmail: actor.email, action, entityType: "store", entityId: storeId, before: before as object, after: after as object },
  });
}

/**
 * What the confirm compares to tell the change went stale. A day: `{ date, weekly }`, the stored one-off for that
 * date and the weekly hours of its weekday, as stored text (or null). A pause: `{ deliveryPausedUntil }`, an ISO
 * instant or null.
 */
export function storeChangeBefore(
  store: { hours: unknown; deliveryPausedUntil: Date | null; timezone: string },
  change: StoreChange,
): Record<string, string | null> {
  if (change.kind === "delivery_pause") return { deliveryPausedUntil: store.deliveryPausedUntil?.toISOString() ?? null };
  const hours = hoursObject(store.hours) ?? {};
  const day = WEEK_DAYS[(new Date(`${change.date}T00:00:00Z`).getUTCDay() + 6) % 7];
  return { date: describe(storedDates(hours)[change.date]), weekly: describe(hours[day] ?? hours[day.slice(0, 3)]) };
}

/** Why the change cannot be made, or null: a day from today to 13 days ahead, open before close, a pause of up to 7 days. */
export function storeChangeError(change: StoreChange, timezone: string, now: Date): string | null {
  if (change.kind === "delivery_pause") {
    const until = new Date(change.until).getTime();
    if (Number.isNaN(until)) return "Give the time delivery should start again.";
    if (until <= now.getTime()) return "The pause must end after now.";
    if (until - now.getTime() > PAUSE_MAX_MS) return "Delivery can be paused for up to 7 days.";
    return null;
  }
  const today = storeToday(timezone, now);
  if (!validDay(change.date) || change.date < today || change.date > addDays(today, DAYS_AHEAD)) {
    return "Pick a day from today to 13 days ahead.";
  }
  if (change.closed) return null;
  const open = CLOCK.test(change.open) ? parseTimeMinutes(change.open) : null;
  const close = CLOCK.test(change.close) ? parseTimeMinutes(change.close) : null;
  if (open === null || close === null) return "Enter an opening and a closing time.";
  if (open >= close) return "The store must open before it closes on the same day.";
  return null;
}

/** When the change stops applying: the store's midnight after the day, or the pause end. */
export function storeChangeEndsAt(change: StoreChange, timezone: string): Date {
  if (change.kind === "delivery_pause") return new Date(change.until);
  const end = storeLocalToUtc(`${addDays(change.date, 1)}T00:00`, timezone);
  if (!end) throw new Error(`Not a date: ${change.date}`);
  return end;
}

/** The owner-facing sentence for the confirm card. */
export function storeChangeText(change: StoreChange, timezone: string, now: Date): string {
  if (change.kind === "delivery_pause") {
    return `Delivery paused until ${pauseEndLabel(new Date(change.until), timezone, now)}. Pickup stays open.`;
  }
  const same = "(one day only). Your weekly hours stay the same.";
  if (change.closed) return `Closed all day ${dateLabel(change.date)} ${same}`;
  return `${dateLabel(change.date)}: open ${twelveHour(change.open)} to ${twelveHour(change.close)} ${same}`;
}

/** What `clearStoreChange` takes: one one-off day, or the delivery pause. */
export type StoreChangeRef = { date: string } | { deliveryPause: true };

/** The one-off days from today on, in date order, then a pause that has not ended: the settings page's list. */
export function activeStoreChanges(
  store: { hours: unknown; deliveryPausedUntil: Date | null; timezone: string },
  now: Date,
): { which: StoreChangeRef; text: string }[] {
  const days = Object.entries(currentDates(store.hours, store.timezone, now))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({
      which: { date },
      text: `${dateLabel(date)}: ${typeof value === "string" && /^\s*closed\s*$/i.test(value) ? "closed all day" : `open ${describe(value)}`}`,
    }));
  const until = activeDeliveryPause(store, now);
  return until ? [...days, { which: { deliveryPause: true }, text: `Delivery paused until ${pauseEndLabel(until, store.timezone, now)}` }] : days;
}

/**
 * Writes the change inside the caller's store-scoped transaction; the caller holds lockStoreRow and revalidates
 * the store after commit. Past one-off days are dropped. One audit row. Throws on a change storeChangeError refuses,
 * and on a one-off day for a store with no weekly hours (it is open at all times).
 */
export async function writeStoreChange(tx: Tx, storeId: string, change: StoreChange, actor: Actor, now: Date): Promise<void> {
  // Already held by the caller; read again here for the row as locked.
  const store = await lockStoreRow(tx, storeId);
  const refused = storeChangeError(change, store.timezone, now);
  if (refused) throw new Error(refused);
  const audit = (action: string, before: Hours, after: Hours) => auditChange(tx, storeId, actor, action, before, after);

  if (change.kind === "delivery_pause") {
    const until = new Date(change.until);
    await updateStoreOneOff(tx, storeId, { deliveryPausedUntil: until });
    await audit("store.delivery_pause", { deliveryPausedUntil: store.deliveryPausedUntil?.toISOString() ?? null }, { deliveryPausedUntil: until.toISOString() });
    return;
  }
  const hours = hoursObject(store.hours);
  if (!hours) throw new Error("Set your weekly hours first.");
  const value = dayValue(change);
  const dates = { ...currentDates(hours, store.timezone, now), [change.date]: value };
  await updateStoreOneOff(tx, storeId, { hours: withDates(hours, dates) });
  await audit("store.hours_one_off", { date: change.date, hours: describe(storedDates(hours)[change.date]) }, { date: change.date, hours: value });
}

/** Removes one one-off day or the delivery pause, audited like writeStoreChange. For the owner's settings page. */
export async function clearStoreChange(
  storeId: string,
  which: StoreChangeRef,
  actor: Actor,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const site = await platform.store.findUnique({ where: { id: storeId }, select: { id: true, slug: true, customDomain: true } });
  if (!site) return { ok: false, message: "Store not found." };
  const cleared = await storeScopedTransaction(storeId, async (tx) => {
    const row = await lockStoreRow(tx, storeId);
    const audit = (action: string, before: Hours, after: Hours) => auditChange(tx, storeId, actor, action, before, after);
    if ("deliveryPause" in which) {
      if (!row.deliveryPausedUntil) return false;
      await updateStoreOneOff(tx, storeId, { deliveryPausedUntil: null });
      await audit("store.delivery_pause", { deliveryPausedUntil: row.deliveryPausedUntil.toISOString() }, { deliveryPausedUntil: null });
      return true;
    }
    const hours = hoursObject(row.hours);
    const dates = storedDates(hours);
    if (!hours || !(which.date in dates)) return false;
    const { [which.date]: removed, ...rest } = dates;
    await updateStoreOneOff(tx, storeId, { hours: withDates(hours, rest) });
    await audit("store.hours_one_off", { date: which.date, hours: describe(removed) }, { date: which.date, hours: null });
    return true;
  });
  if (!cleared) return { ok: false, message: "That change was already removed." };
  revalidateStore(site);
  return { ok: true };
}
