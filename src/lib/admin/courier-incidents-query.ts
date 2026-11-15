import { findCourierIncidentEvents, findCourierIncidentNotes, findCourierIncidentRows, type CourierIncidentRaw } from "../db";
import type { DeliveryProviderName } from "../delivery/provider";

/**
 * Courier incident log (#536). An incident is derived on read from delivery_events, one per order: nothing about it is
 * stored except an admin's notes and resolutions (courier_incident_notes). Read straight from the database, so it shows
 * what happened even when Inngest is down, like Orders to check.
 */

export const INCIDENT_KINDS = ["failover", "both_failed", "provider_cancelled", "returned", "assigned_late", "delivered_no_proof"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_PROVIDERS = ["doordash", "uber"] as const satisfies readonly DeliveryProviderName[];
export const PAGE_SIZE = 50;
/** courier_incident_notes_body_check allows 1 to 1000 characters. */
export const NOTE_MAX = 1000;

export interface IncidentFilters {
  storeId?: string;
  provider?: DeliveryProviderName;
  kind?: IncidentKind;
  /** UTC calendar days, YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Keyset cursor: the last row of the previous page. */
  after?: string;
}

export interface IncidentRow {
  orderId: string;
  storeId: string;
  storeName: string;
  orderNumber: number;
  orderStatus: string;
  /** Every courier tried for the order, in the order they were tried. */
  providers: DeliveryProviderName[];
  kinds: IncidentKind[];
  /** The first incident event; the row's age counts from here. */
  openedAt: Date;
  lastAt: Date;
  /** Resolved when a resolving note is newer than the last incident event; a later event reopens it. */
  state: "open" | "resolved";
  deliveryStatus: string | null;
}

type Queryable = Parameters<typeof findCourierIncidentRows>[0];

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([A-Za-z0-9-]{1,64})$/;

export function encodeCursor(row: Pick<IncidentRow, "openedAt" | "orderId">): string {
  return `${row.openedAt.toISOString()}_${row.orderId}`;
}

function decodeCursor(value: string): { at: Date; orderId: string } | null {
  const match = CURSOR.exec(value);
  if (!match) return null;
  const at = new Date(match[1]);
  return Number.isNaN(at.getTime()) ? null : { at, orderId: match[2] };
}

/** The start of a UTC day, or null for anything but a real YYYY-MM-DD date. */
export function utcDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : day;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * One page of incidents, newest first, in one query. `tx` decides what is visible: a platform admin sees every store;
 * a store-scoped transaction sees only its own store, whatever the filters say (RLS).
 */
export async function findCourierIncidents(
  tx: Queryable,
  filters: IncidentFilters & { orderId?: string },
  pageSize: number = PAGE_SIZE,
): Promise<{ rows: IncidentRow[]; nextCursor: string | null }> {
  const cursor = filters.after ? decodeCursor(filters.after) : null;
  const from = filters.from ? utcDay(filters.from) : null;
  const to = filters.to ? utcDay(filters.to) : null;

  const raw = await findCourierIncidentRows(tx, {
    storeId: filters.storeId,
    orderId: filters.orderId,
    provider: filters.provider,
    kind: filters.kind,
    from: from ?? undefined,
    toExclusive: to ? new Date(to.getTime() + DAY_MS) : undefined,
    cursor: cursor ?? undefined,
    limit: pageSize + 1,
  });

  const rows = raw.slice(0, pageSize).map(({ resolvedAt, providers, kinds, ...row }: CourierIncidentRaw): IncidentRow => ({
    ...row,
    providers: (providers ?? []) as DeliveryProviderName[],
    kinds: kinds as IncidentKind[],
    state: resolvedAt && resolvedAt >= row.lastAt ? "resolved" : "open",
  }));
  return { rows, nextCursor: raw.length > pageSize ? encodeCursor(rows[rows.length - 1]) : null };
}

const REDACTED = "[redacted]";
/** Keys that hold a phone, or the customer's name, address or contact, in DoorDash and Uber webhooks. */
const CONTACT_KEY = /phone|email|given_name|family_name|first_name|last_name|full_name|customer|recipient|contact|address|instructions|location|notes|^lat$|^lng$/i;
/** Uber nests the customer's whole drop-off (name, phone, address, location) under one key. */
const CONTACT_OBJECT_KEY = /^dropoff$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_IN_TEXT = /(?<![\w+])\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g;

function looksLikePhone(value: string): boolean {
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

/**
 * A courier webhook payload with courier phone numbers and the customer's contact details replaced, before it renders.
 * Keys are matched by name; any other string that is a phone number or holds an email or US phone is scrubbed too.
 */
export function redactCourierPayload(value: unknown, key = ""): unknown {
  if (key && (CONTACT_KEY.test(key) || (CONTACT_OBJECT_KEY.test(key) && typeof value === "object" && value !== null))) return REDACTED;
  if (typeof value === "string") {
    if (looksLikePhone(value)) return REDACTED;
    return value.replace(EMAIL, REDACTED).replace(PHONE_IN_TEXT, REDACTED);
  }
  if (Array.isArray(value)) return value.map((item) => redactCourierPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactCourierPayload(v, k)]));
  }
  return value;
}

/** Order and store ids are cuids or UUIDs; anything else never reaches a query. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

export function isIncidentId(value: string): boolean {
  return ID.test(value);
}

/** The list's filters from the URL. A value that is not exactly one of the allowed ones is dropped. */
export function incidentFiltersFromSearchParams(params: Record<string, string | string[] | undefined>): IncidentFilters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const filters: IncidentFilters = {};
  const store = one("store");
  if (store && ID.test(store)) filters.storeId = store;
  const provider = one("provider");
  if (provider && (INCIDENT_PROVIDERS as readonly string[]).includes(provider)) filters.provider = provider as DeliveryProviderName;
  const kind = one("kind");
  if (kind && (INCIDENT_KINDS as readonly string[]).includes(kind)) filters.kind = kind as IncidentKind;
  const from = one("from");
  if (from && utcDay(from)) filters.from = from;
  const to = one("to");
  if (to && utcDay(to)) filters.to = to;
  const after = one("after");
  if (after && decodeCursor(after)) filters.after = after;
  return filters;
}

export interface IncidentEvent {
  id: string;
  type: string;
  at: Date;
  provider: DeliveryProviderName | null;
  /** Redacted (redactCourierPayload) before it leaves this module. */
  payload: unknown;
}

export interface IncidentNote {
  id: string;
  authorEmail: string;
  body: string;
  resolves: boolean;
  createdAt: Date;
}

export interface IncidentDetail {
  incident: IncidentRow;
  events: IncidentEvent[];
  notes: IncidentNote[];
}

/** One incident with its order's whole delivery timeline and the admins' notes; null when the order has no incident. */
export async function findCourierIncidentDetail(tx: Queryable, orderId: string): Promise<IncidentDetail | null> {
  if (!ID.test(orderId)) return null;
  const [incident] = (await findCourierIncidents(tx, { orderId }, 1)).rows;
  if (!incident) return null;
  const [events, notes] = [
    await findCourierIncidentEvents(tx, incident.storeId, orderId),
    await findCourierIncidentNotes(tx, incident.storeId, orderId),
  ];
  return {
    incident,
    events: events.map((e) => ({ ...e, provider: e.provider as DeliveryProviderName | null, payload: redactCourierPayload(e.payload) })),
    notes,
  };
}
