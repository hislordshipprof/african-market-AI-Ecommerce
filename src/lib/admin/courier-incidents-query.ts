import { Prisma } from "@prisma/client";
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

type Queryable = Pick<Prisma.TransactionClient, "$queryRaw">;

type RawRow = Omit<IncidentRow, "state" | "providers" | "kinds"> & {
  providers: string[] | null;
  kinds: string[];
  resolvedAt: Date | null;
};

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
  const eventScope = [
    filters.storeId ? Prisma.sql`AND e.store_id = ${filters.storeId}` : Prisma.empty,
    filters.orderId ? Prisma.sql`AND e.order_id = ${filters.orderId}` : Prisma.empty,
  ];
  const where = [
    filters.provider ? Prisma.sql`AND ${filters.provider} = ANY(p.providers)` : Prisma.empty,
    filters.kind ? Prisma.sql`AND ${filters.kind} = ANY(i.kinds)` : Prisma.empty,
    from ? Prisma.sql`AND i.opened_at >= ${from}::timestamp(3)` : Prisma.empty,
    to ? Prisma.sql`AND i.opened_at < ${new Date(to.getTime() + DAY_MS)}::timestamp(3)` : Prisma.empty,
    cursor ? Prisma.sql`AND (i.opened_at, i.order_id) < (${cursor.at}::timestamp(3), ${cursor.orderId})` : Prisma.empty,
  ];

  const raw = await tx.$queryRaw<RawRow[]>`
    WITH signals AS (
      SELECT e.store_id, e.order_id, e.created_at AS at,
        CASE
          WHEN e.type = 'failover_triggered' THEN 'failover'
          WHEN e.type = 'both_failed' THEN 'both_failed'
          WHEN e.type = 'returned'
            OR (e.type = 'cancelled' AND COALESCE(e.payload->>'cancellation_reason', e.payload->>'reason') = 'failed_to_return')
            THEN 'returned'
          -- A cancel the platform made itself (failover replaced the delivery, or the order was cancelled) is not the provider's.
          WHEN e.type = 'cancelled' AND o.status <> 'CANCELLED' AND NOT EXISTS (
              SELECT 1 FROM delivery_events f
              WHERE f.store_id = e.store_id AND f.order_id = e.order_id AND f.delivery_id = e.delivery_id AND f.type = 'failover_triggered'
            ) THEN 'provider_cancelled'
          -- The deadline the assignment timer uses: the later of the timeout after booking and the ready time.
          WHEN e.type = 'courier_assigned'
            AND e.created_at > GREATEST(d.created_at + make_interval(secs => ps.courier_assignment_timeout_s), d.pickup_ready_at)
            THEN 'assigned_late'
          WHEN e.type = 'delivered' AND d.proof_url IS NULL AND d.pin IS NULL THEN 'delivered_no_proof'
        END AS kind
      FROM delivery_events e
      JOIN orders o ON o.id = e.order_id AND o.store_id = e.store_id
      LEFT JOIN deliveries d ON d.id = e.delivery_id AND d.store_id = e.store_id
      CROSS JOIN (SELECT courier_assignment_timeout_s FROM platform_settings WHERE id = 'platform') ps
      WHERE e.type IN ('failover_triggered', 'both_failed', 'cancelled', 'returned', 'courier_assigned', 'delivered')
        ${eventScope[0]} ${eventScope[1]}
    ),
    incidents AS (
      SELECT store_id, order_id, min(at) AS opened_at, max(at) AS last_at, array_agg(DISTINCT kind ORDER BY kind) AS kinds
      FROM signals
      WHERE kind IS NOT NULL
      GROUP BY store_id, order_id
    )
    SELECT i.order_id AS "orderId", i.store_id AS "storeId", s.name AS "storeName", o.number AS "orderNumber",
      o.status AS "orderStatus", p.providers, i.kinds, i.opened_at AS "openedAt", i.last_at AS "lastAt",
      r.resolved_at AS "resolvedAt", ld.status AS "deliveryStatus"
    FROM incidents i
    JOIN orders o ON o.id = i.order_id AND o.store_id = i.store_id
    JOIN stores s ON s.id = i.store_id
    LEFT JOIN LATERAL (
      SELECT array_agg(provider ORDER BY first_at) AS providers
      FROM (
        SELECT provider, min(at) AS first_at
        FROM (
          SELECT d.provider, d.created_at AS at FROM deliveries d WHERE d.store_id = i.store_id AND d.order_id = i.order_id
          UNION ALL
          -- A create error leaves no delivery row; its failover event names the courier that refused.
          SELECT f.payload->>'fromProvider', f.created_at FROM delivery_events f
          WHERE f.store_id = i.store_id AND f.order_id = i.order_id AND f.type = 'failover_triggered' AND f.delivery_id IS NULL
        ) tried
        WHERE provider IS NOT NULL
        GROUP BY provider
      ) firsts
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT max(n.created_at) AS resolved_at FROM courier_incident_notes n
      WHERE n.store_id = i.store_id AND n.order_id = i.order_id AND n.resolves
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT d.status FROM deliveries d WHERE d.store_id = i.store_id AND d.order_id = i.order_id ORDER BY d.created_at DESC LIMIT 1
    ) ld ON true
    WHERE true ${where[0]} ${where[1]} ${where[2]} ${where[3]} ${where[4]}
    ORDER BY i.opened_at DESC, i.order_id DESC
    LIMIT ${pageSize + 1}
  `;

  const rows = raw.slice(0, pageSize).map(({ resolvedAt, providers, kinds, ...row }): IncidentRow => ({
    ...row,
    providers: (providers ?? []) as DeliveryProviderName[],
    kinds: kinds as IncidentKind[],
    state: resolvedAt && resolvedAt >= row.lastAt ? "resolved" : "open",
  }));
  return { rows, nextCursor: raw.length > pageSize ? encodeCursor(rows[rows.length - 1]) : null };
}

const REDACTED = "[redacted]";
/** Keys that hold a phone, or the customer's name, address or contact, in DoorDash and Uber webhooks. */
const CONTACT_KEY = /phone|email|given_name|family_name|contact|address|instructions|location|notes|^lat$|^lng$/i;
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
