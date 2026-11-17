import type { Prisma, PrismaClient } from "@prisma/client";
import { lockMetroRow, metroAssignmentMedian, metroQuoteTotals, platformAdminTransaction } from "../db";
import type { CourierSelectionMode } from "../delivery/courier-settings";
import type { DeliveryProviderName } from "../delivery/provider";
import { DIRECTORY_STORE_WHERE } from "../directory/stores";
import { placeSlug, statePages, stateSlug } from "../directory/places";
import { isStateCode, STATE_NAMES, type StateCode } from "../directory/us-states";

/** Decisions taken in #577: a metro spans 1 to 10 states and a radius of 1 to 250 miles. */
export const METRO_RADIUS_MI = { min: 1, max: 250 } as const;
export const METRO_MAX_STATES = 10;
/** The readiness report's window: the last 30 days, and for quote counts the last 30 UTC days. */
const WINDOW_DAYS = 30;

/** What a platform admin sets on a metro (#577). A null mode or timeout follows the platform courier settings. */
export interface MetroInput {
  name: string;
  states: StateCode[];
  centerLat: number;
  centerLng: number;
  radiusMi: number;
  courierSelectionMode: CourierSelectionMode | null;
  courierAssignmentTimeoutS: number | null;
  doordashEnabled: boolean;
  uberEnabled: boolean;
}

const METRO_FIELDS = {
  name: true,
  states: true,
  centerLat: true,
  centerLng: true,
  radiusMi: true,
  courierSelectionMode: true,
  courierAssignmentTimeoutS: true,
  doordashEnabled: true,
  uberEnabled: true,
} satisfies Prisma.MetroSelect;

type Tx = Pick<PrismaClient, "metro" | "store" | "auditLog" | "$queryRaw">;
type Actor = { id: string; email: string };

/** Every metro, A to Z, with how many stores are in each. */
export function listMetros() {
  return platformAdminTransaction((tx) =>
    tx.metro.findMany({ orderBy: { name: "asc" }, select: { id: true, ...METRO_FIELDS, _count: { select: { stores: true } } } }),
  );
}

export function getMetro(id: string) {
  return platformAdminTransaction((tx) => tx.metro.findUnique({ where: { id }, select: { id: true, ...METRO_FIELDS } }));
}

/**
 * Creates a metro, or updates one under its row lock so each audit row's "before" is what that save replaced. One
 * audit row with before and after; an unchanged save writes none. Returns the metro id, or null when it is gone.
 */
export async function saveMetro(tx: Tx, actor: Actor, id: string | null, input: MetroInput): Promise<string | null> {
  if (!id) {
    const created = await tx.metro.create({ data: input, select: { id: true } });
    await tx.auditLog.create({
      data: { storeId: null, actorId: actor.id, actorEmail: actor.email, action: "platform.metro_create", entityType: "metro", entityId: created.id, after: { ...input } },
    });
    return created.id;
  }
  await lockMetroRow(tx, id);
  const before = await tx.metro.findUnique({ where: { id }, select: METRO_FIELDS });
  if (!before) return null;
  const unchanged = (Object.keys(input) as Array<keyof MetroInput>).every((key) => JSON.stringify(before[key]) === JSON.stringify(input[key]));
  if (unchanged) return id;
  await tx.metro.update({ where: { id }, data: input });
  await tx.auditLog.create({
    data: { storeId: null, actorId: actor.id, actorEmail: actor.email, action: "platform.metro_update", entityType: "metro", entityId: id, before: { ...before }, after: { ...input } },
  });
  return id;
}

/** Puts a store in a metro, or in none, with one audit row on the store. False when the store or metro is not found. */
export async function setStoreMetro(tx: Tx, actor: Actor, storeId: string, metroId: string | null): Promise<boolean> {
  const before = await tx.store.findUnique({ where: { id: storeId }, select: { metroId: true } });
  if (!before) return false;
  if (metroId && !(await tx.metro.findUnique({ where: { id: metroId }, select: { id: true } }))) return false;
  if (before.metroId === metroId) return true;
  await tx.store.update({ where: { id: storeId }, data: { metroId } });
  await tx.auditLog.create({
    data: { storeId, actorId: actor.id, actorEmail: actor.email, action: "store.metro_set", entityType: "store", entityId: storeId, before: { metroId: before.metroId }, after: { metroId } },
  });
  return true;
}

export type CourierRegistration = "registered" | "failed" | "not_registered";

function registration(id: string | null, error: string | null): CourierRegistration {
  if (id) return "registered";
  return error ? "failed" : "not_registered";
}

export interface MetroReadiness {
  stores: Array<{ id: string; name: string; status: string; city: string | null; state: string | null; couriers: Record<DeliveryProviderName, CourierRegistration> }>;
  counts: { live: number; setup: number; suspended: number };
  /** Last 30 UTC days, per courier. */
  quotes: Array<{ provider: DeliveryProviderName; attempts: number; successes: number }>;
  /** Courier deliveries booked in the last 30 days that got a courier: the median wait, from the later of booking and the ready time. */
  assignment: { medianSeconds: number | null; deliveries: number };
  taxStates: Array<{ code: StateCode; name: string; signedOff: boolean }>;
  cityPages: Array<{ state: string; city: string; href: string; present: boolean }>;
}

/** The readiness report for one metro (#577 AC3), in a fixed number of queries whatever the number of stores. */
export async function metroReadiness(metroId: string, now: Date = new Date()): Promise<MetroReadiness | null> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const firstDay = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  return platformAdminTransaction(async (tx) => {
    const metro = await tx.metro.findUnique({ where: { id: metroId }, select: { states: true } });
    if (!metro) return null;
    const [stores, quotes, assignment, settings] = await Promise.all([
      tx.store.findMany({
        where: { metroId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, status: true, city: true, state: true, doordashStoreId: true, doordashRegistrationError: true, uberLocationId: true, uberRegistrationError: true },
      }),
      metroQuoteTotals(tx, metroId, firstDay) as Promise<Array<{ provider: DeliveryProviderName; attempts: number; successes: number }>>,
      metroAssignmentMedian(tx, metroId, since),
      tx.platformSettings.findUniqueOrThrow({ where: { id: "platform" }, select: { taxSignedOffStates: true } }),
    ]);

    // A city page exists while one directory store is in that city (#451), whichever metro that store is in.
    const places = new Set(stores.flatMap((s) => (s.state && s.city && isStateCode(s.state) ? [`${s.state}|${placeSlug(s.city)}`] : [])));
    const placeStates = [...new Set([...places].map((p) => p.split("|")[0]))];
    const directoryStores = placeStates.length > 0
      ? await tx.store.findMany({ where: { ...DIRECTORY_STORE_WHERE, state: { in: placeStates } }, select: { slug: true, city: true, state: true } })
      : [];
    const pages = new Set(statePages(directoryStores).flatMap((state) => state.cities.map((city) => `${state.code}|${city.slug}`)));
    const cityPages = [...places].sort().map((place) => {
      const [code, slug] = place.split("|") as [StateCode, string];
      const city = stores.find((s) => s.state === code && s.city && placeSlug(s.city) === slug)?.city?.trim() ?? slug;
      return { state: code, city, href: `/stores/${stateSlug(code)}/${slug}`, present: pages.has(place) };
    });

    return {
      stores: stores.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        city: s.city,
        state: s.state,
        couriers: { doordash: registration(s.doordashStoreId, s.doordashRegistrationError), uber: registration(s.uberLocationId, s.uberRegistrationError) },
      })),
      counts: {
        live: stores.filter((s) => s.status === "active").length,
        setup: stores.filter((s) => s.status === "setup").length,
        suspended: stores.filter((s) => s.status === "suspended").length,
      },
      quotes,
      assignment,
      taxStates: metro.states.filter(isStateCode).map((code) => ({ code, name: STATE_NAMES[code], signedOff: settings.taxSignedOffStates.includes(code) })),
      cityPages,
    };
  });
}
