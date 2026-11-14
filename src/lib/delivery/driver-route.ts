import { createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { lockStoreRow, platform, storeScoped, storeScopedTransaction } from "../db";
import { haversineMiles } from "../address/geo";
import { normalizeUsPhone } from "../notifications/phone";
import { smsSender } from "../notifications/sms";
import { providerSinkMode } from "../email/send";
import { smsStoreName } from "../notifications/messages";
import { storePageUrl } from "../notifications/tracking-url";
import { getStoreLocalTime, isValidTimezone } from "../order/store-hours";
import { markDelivered, markOutForDelivery } from "../order/service";

const TOKEN_BYTES = 32;
const STEP_MS = 15 * 60_000;
const ROUTE_STATUSES = ["READY", "OUT_FOR_DELIVERY", "DELIVERED"];

export const ROUTE_NO_ORDERS = "No Ready store-delivery orders in this slot are waiting for a driver";
export const ROUTE_BAD_PHONE = "Enter the driver's US mobile number";
export const ROUTE_BAD_NAME = "Enter the driver's name";
export const ROUTE_SMS_FAILED = "The text to the driver could not be sent. Check the number and try again";
export const ROUTE_NOT_FOUND = "Route not found";

export function hashRouteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The instant the store's local day containing `at` ends. Local midnight sits on a UTC quarter hour in every US zone. */
export function storeDayEnd(timezone: string, at: Date): Date {
  const day = (ms: number) => Math.floor(getStoreLocalTime(timezone, new Date(ms)).wallMs / 86_400_000);
  const start = day(at.getTime());
  let t = Math.floor(at.getTime() / STEP_MS) * STEP_MS + STEP_MS;
  while (day(t) === start) t += STEP_MS;
  return new Date(t);
}

/** Greedy nearest-next from the store. Stops without coordinates keep their order at the end. */
export function nearestNext<T extends { lat: number | null; lng: number | null }>(
  origin: { lat: number | null; lng: number | null },
  stops: T[],
): T[] {
  const placed = stops.filter((s): s is T & { lat: number; lng: number } => s.lat !== null && s.lng !== null);
  const unplaced = stops.filter((s) => s.lat === null || s.lng === null);
  if (origin.lat === null || origin.lng === null) return [...placed, ...unplaced];
  const ordered: T[] = [];
  let here = { lat: origin.lat, lng: origin.lng };
  const left = [...placed];
  while (left.length > 0) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (haversineMiles(here, left[i]) < haversineMiles(here, left[best])) best = i;
    }
    const [next] = left.splice(best, 1);
    ordered.push(next);
    here = next;
  }
  return [...ordered, ...unplaced];
}

export function routeSlotLabel(timezone: string, slot: string): string {
  return new Date(slot).toLocaleString("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

/** Sent, not revoked, not expired. A route whose text never went out does not hold its orders. */
function liveRouteWhere(now: Date): Prisma.DriverRouteWhereInput {
  return { revokedAt: null, sentAt: { not: null }, expiresAt: { gt: now } };
}

type AssignResult = { ok: true; routeId: string; count: number } | { ok: false; error: string };

export async function assignDriverRoute(
  storeId: string,
  input: { slot: string; driverName: string; driverPhone: string },
  opts: { now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<AssignResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const name = input.driverName.trim();
  if (!name || name.length > 80) return { ok: false, error: ROUTE_BAD_NAME };
  const phone = normalizeUsPhone(input.driverPhone);
  if (!phone.ok) return { ok: false, error: ROUTE_BAD_PHONE };
  const slotAt = new Date(input.slot);
  if (Number.isNaN(slotAt.getTime()) || slotAt.toISOString() !== input.slot) return { ok: false, error: ROUTE_NO_ORDERS };

  const store = await platform.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true, timezone: true } });
  if (!store || !isValidTimezone(store.timezone)) return { ok: false, error: ROUTE_NOT_FOUND };
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const created = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const orders = await tx.order.findMany({
      where: {
        fulfillment: "store-delivery",
        status: "READY",
        pickupSlot: input.slot,
        OR: [{ driverRouteId: null }, { driverRoute: { NOT: liveRouteWhere(now) } }],
      },
      select: { id: true },
    });
    if (orders.length === 0) return null;
    const route = await tx.driverRoute.create({
      data: {
        storeId,
        slot: input.slot,
        driverName: name,
        driverPhone: phone.e164,
        tokenHash: hashRouteToken(token),
        // The later of today and the slot's day: a route sent the night before still works on the day.
        expiresAt: storeDayEnd(store.timezone, slotAt > now ? slotAt : now),
      },
    });
    await tx.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { driverRouteId: route.id } });
    return { route, count: orders.length };
  });
  if (!created) return { ok: false, error: ROUTE_NO_ORDERS };

  const { route, count } = created;
  const url = storePageUrl(store, `/driver/${token}`, env);
  const sender = smsSender(env);
  // A preview texts only the test number, as customer SMS does; the in-memory sink sends nothing real.
  const previewBlocked = env.VERCEL_ENV === "preview" && !providerSinkMode(env) && phone.e164 !== env.TELNYX_TEST_TO;
  let sent = false;
  if (url && sender && !previewBlocked) {
    const stops = count === 1 ? "1 delivery" : `${count} deliveries`;
    try {
      await sender.send({
        to: phone.e164,
        from: env.TELNYX_FROM_NUMBER ?? "test-from",
        text: `${smsStoreName(store.name)}: ${stops} for ${routeSlotLabel(store.timezone, input.slot)}. Your route: ${url} Works until midnight.`,
      }, { idempotencyKey: `driver-route-${route.id}` });
      sent = true;
    } catch (err) {
      console.error(JSON.stringify({ event: "driver_route_sms_failed", routeId: route.id, code: (err as { code?: string }).code ?? "unknown" }));
    }
  }
  const scoped = storeScoped(storeId);
  if (!sent) {
    await scoped.driverRoute.update({ where: { id: route.id }, data: { revokedAt: new Date() } });
    return { ok: false, error: ROUTE_SMS_FAILED };
  }
  await scoped.driverRoute.update({ where: { id: route.id }, data: { sentAt: new Date() } });
  return { ok: true, routeId: route.id, count };
}

export async function revokeDriverRoute(
  storeId: string,
  routeId: string,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { count } = await storeScoped(storeId).driverRoute.updateMany({
    where: { id: routeId, revokedAt: null },
    data: { revokedAt: now },
  });
  return count === 1 ? { ok: true } : { ok: false, error: ROUTE_NOT_FOUND };
}

export interface DriverStop {
  orderId: string;
  number: number;
  customerName: string;
  address: string;
  notes: string | null;
  leaveAtDoor: boolean;
  frozen: boolean;
  status: string;
  mapsUrl: string;
}

export interface DriverRouteView {
  storeName: string;
  driverName: string;
  slotLabel: string;
  expiresAt: Date;
  stops: DriverStop[];
}

async function liveRoute(storeId: string, token: string, now: Date) {
  if (!token || token.length > 200) return null;
  return storeScoped(storeId).driverRoute.findFirst({
    where: { tokenHash: hashRouteToken(token), ...liveRouteWhere(now) },
    select: { id: true, driverName: true, slot: true, expiresAt: true },
  });
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** The route the token opens, or null for an unknown, revoked or expired token, or one from another store. */
export async function readDriverRoute(storeId: string, token: string, now: Date = new Date()): Promise<DriverRouteView | null> {
  const route = await liveRoute(storeId, token, now);
  if (!route) return null;
  const [store, orders] = await Promise.all([
    platform.store.findUnique({ where: { id: storeId }, select: { name: true, timezone: true, lat: true, lng: true } }),
    storeScoped(storeId).order.findMany({
      where: { driverRouteId: route.id, status: { in: ROUTE_STATUSES } },
      orderBy: { number: "asc" },
      select: {
        id: true, number: true, status: true, notes: true, leaveAtDoor: true,
        deliveryLine1: true, deliveryLine2: true, deliveryCity: true, deliveryState: true, deliveryZip: true,
        deliveryLat: true, deliveryLng: true,
        customer: { select: { name: true } },
        lines: { select: { listingVariant: { select: { listing: { select: { frozen: true } } } } } },
      },
    }),
  ]);
  if (!store) return null;
  const stops = orders.map((o) => {
    const street = [o.deliveryLine1, o.deliveryLine2].filter(Boolean).join(" ");
    const address = `${street}, ${o.deliveryCity ?? ""}, ${o.deliveryState ?? ""} ${o.deliveryZip ?? ""}`.trim();
    const stop: DriverStop = {
      orderId: o.id,
      number: o.number,
      customerName: firstName(o.customer.name),
      address,
      notes: o.notes,
      leaveAtDoor: o.leaveAtDoor,
      frozen: o.lines.some((line) => line.listingVariant.listing.frozen),
      status: o.status,
      mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`,
    };
    return { stop, lat: o.deliveryLat, lng: o.deliveryLng };
  });
  return {
    storeName: store.name,
    driverName: route.driverName,
    slotLabel: routeSlotLabel(store.timezone, route.slot),
    expiresAt: route.expiresAt,
    stops: nearestNext(store, stops).map((placed) => placed.stop),
  };
}

type StepResult = { ok: true } | { ok: false; error: string };

async function onRoute(storeId: string, token: string, orderId: string, now: Date): Promise<boolean> {
  const route = await liveRoute(storeId, token, now);
  if (!route) return false;
  const order = await storeScoped(storeId).order.findFirst({ where: { id: orderId, driverRouteId: route.id }, select: { id: true } });
  return order !== null;
}

/** The order must be on the token's live route; anything else is not_found, so a token never learns about other orders. */
export async function driverMarkOutForDelivery(storeId: string, token: string, orderId: string, now: Date = new Date()): Promise<StepResult> {
  if (!(await onRoute(storeId, token, orderId, now))) return { ok: false, error: "not_found" };
  return markOutForDelivery(storeId, orderId);
}

export async function driverMarkDelivered(
  storeId: string,
  token: string,
  orderId: string,
  photo: Uint8Array | null,
  now: Date = new Date(),
): Promise<StepResult> {
  if (!(await onRoute(storeId, token, orderId, now))) return { ok: false, error: "not_found" };
  return markDelivered(storeId, orderId, photo);
}

export interface DriverRouteSlot {
  slot: string;
  label: string;
  /** Ready orders not on a live route: what Assign would send. */
  waiting: number;
  routes: Array<{ id: string; driverName: string; phoneLast4: string; orders: number; expiresAt: Date }>;
}

/** The owner's view: each slot with Ready store-delivery orders or a live route on it. */
export async function driverRouteBoard(storeId: string, timezone: string, now: Date = new Date()): Promise<DriverRouteSlot[]> {
  const scoped = storeScoped(storeId);
  const [routes, orders] = await Promise.all([
    scoped.driverRoute.findMany({
      where: liveRouteWhere(now),
      orderBy: { createdAt: "asc" },
      select: { id: true, slot: true, driverName: true, driverPhone: true, expiresAt: true },
    }),
    scoped.order.findMany({
      where: { fulfillment: "store-delivery", status: { in: ["READY", "OUT_FOR_DELIVERY"] }, pickupSlot: { not: null } },
      select: { pickupSlot: true, status: true, driverRouteId: true },
    }),
  ]);
  const live = new Set(routes.map((r) => r.id));
  const slots = new Map<string, DriverRouteSlot>();
  const slotFor = (slot: string) => {
    let row = slots.get(slot);
    if (!row) {
      row = { slot, label: routeSlotLabel(timezone, slot), waiting: 0, routes: [] };
      slots.set(slot, row);
    }
    return row;
  };
  for (const route of routes) {
    const count = orders.filter((o) => o.driverRouteId === route.id).length;
    slotFor(route.slot).routes.push({ id: route.id, driverName: route.driverName, phoneLast4: route.driverPhone.slice(-4), orders: count, expiresAt: route.expiresAt });
  }
  for (const order of orders) {
    if (order.status === "READY" && (!order.driverRouteId || !live.has(order.driverRouteId))) slotFor(order.pickupSlot!).waiting += 1;
  }
  return [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}
