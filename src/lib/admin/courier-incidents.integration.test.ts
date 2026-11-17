import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScopedTransaction } from "../db";
import { applyCourierWebhook } from "../delivery/webhook";
import type { DeliveryWebhookEvent } from "../delivery/provider";
import { findCourierIncidentDetail, findCourierIncidents, type IncidentFilters } from "./courier-incidents-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t536-${Date.now().toString(36)}`;
const MIN = 60_000;
/** A fixed day, so no test depends on the clock. */
const BASE = new Date("2026-03-10T12:00:00.000Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * MIN);

let prisma: PrismaClient;
const storeIds: string[] = [];

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

type EventSpec = { type: string; minutes: number; payload?: Record<string, unknown>; externalEventId?: string };
type DeliverySpec = {
  provider: "doordash" | "uber";
  status: string;
  minutes: number;
  proofUrl?: string | null;
  pin?: string | null;
  events?: EventSpec[];
};

/** A store with a customer; each call to `order` adds a courier order with its deliveries and events. */
async function newStore(name: string) {
  const storeId = crypto.randomUUID();
  storeIds.push(storeId);
  const customerId = await asPlatformAdmin(async (tx) => {
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${name}, ${`${RUN}-${storeIds.length}`}, 'active', now())`;
    return (await tx.customer.create({ data: { storeId, name: "Ada Obi", phone: "+13015550199", email: `${RUN}@example.com` } })).id;
  });
  let number = 5000;
  const deliveryIds: Record<string, string> = {};
  return {
    storeId,
    deliveryIds,
    async order(spec: { status?: string; fulfillment?: string; deliveries?: DeliverySpec[]; orderEvents?: EventSpec[] }): Promise<{ orderId: string; number: number }> {
      const orderNumber = number++;
      const orderId = await asPlatformAdmin(async (tx) => {
        const order = await tx.order.create({
          data: {
            storeId,
            customerId,
            number: orderNumber,
            status: spec.status ?? "DELIVERED",
            fulfillment: spec.fulfillment ?? "courier",
            subtotalCents: 4000,
            bufferCents: 0,
            totalCents: 4000,
            totalAuthorizedCents: 4000,
          },
        });
        for (const [i, d] of (spec.deliveries ?? []).entries()) {
          const delivery = await tx.delivery.create({
            data: {
              storeId,
              orderId: order.id,
              provider: d.provider,
              externalId: `${RUN}-${order.id}-${i}`,
              status: d.status,
              quoteFeeCents: 899,
              proofUrl: d.proofUrl ?? null,
              pin: d.pin ?? null,
              createdAt: at(d.minutes),
            },
          });
          deliveryIds[`${orderNumber}-${i}`] = delivery.id;
          for (const e of d.events ?? []) {
            await tx.deliveryEvent.create({
              data: {
                storeId,
                orderId: order.id,
                deliveryId: delivery.id,
                externalEventId: e.externalEventId ?? `${e.type}-${e.minutes}`,
                type: e.type,
                payload: (e.payload ?? {}) as object,
                createdAt: at(e.minutes),
              },
            });
          }
        }
        for (const e of spec.orderEvents ?? []) {
          await tx.deliveryEvent.create({
            data: { storeId, orderId: order.id, type: e.type, payload: (e.payload ?? {}) as object, createdAt: at(e.minutes) },
          });
        }
        return order.id;
      });
      return { orderId, number: orderNumber };
    },
  };
}

function list(filters: IncidentFilters) {
  return platformAdminTransaction((tx) => findCourierIncidents(tx, filters));
}

beforeAll(() => {
  if (hasDb) prisma = testPrismaClient();
});

afterAll(async () => {
  if (!hasDb) return;
  // Notes are append-only for app_user; the owner role clears them.
  await prisma.$executeRaw`DELETE FROM courier_incident_notes WHERE store_id = ANY(${storeIds})`;
  await asPlatformAdmin(async (tx) => {
    await tx.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.deliveryEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.delivery.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
  });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("courier incident log (#536)", () => {
  it("AC1: one row per order with an incident, with store, number, providers, kinds, age and state; clean deliveries are left out", async () => {
    const store = await newStore(`Kinds Market ${RUN}`);
    const failover = await store.order({
      deliveries: [
        { provider: "uber", status: "cancelled", minutes: 0, events: [{ type: "failover_triggered", minutes: 30, payload: { fromProvider: "uber", reason: "assignment_timeout" }, externalEventId: "failover_triggered" }, { type: "cancelled", minutes: 31 }] },
        { provider: "doordash", status: "delivered", minutes: 32, proofUrl: "https://proof.example/1.jpg", events: [{ type: "courier_assigned", minutes: 35 }, { type: "delivered", minutes: 70 }] },
      ],
    });
    const bothFailed = await store.order({ status: "READY", orderEvents: [{ type: "failover_triggered", minutes: 1, payload: { fromProvider: "uber", reason: "create_failed" } }, { type: "both_failed", minutes: 2, payload: { options: ["pickup", "cancel"] } }] });
    const providerCancelled = await store.order({
      status: "COURIER_REQUESTED",
      deliveries: [{ provider: "doordash", status: "cancelled", minutes: 0, events: [{ type: "cancelled", minutes: 5, payload: { event_name: "DELIVERY_CANCELLED", cancellation_reason: "no_available_dashers" } }] }],
    });
    const returned = await store.order({
      status: "PICKED_UP",
      deliveries: [{ provider: "uber", status: "returned", minutes: 0, events: [{ type: "courier_assigned", minutes: 2 }, { type: "returned", minutes: 50 }] }],
    });
    const failedReturn = await store.order({
      status: "PICKED_UP",
      deliveries: [{ provider: "doordash", status: "cancelled", minutes: 0, events: [{ type: "cancelled", minutes: 60, payload: { event_name: "DELIVERY_CANCELLED", reason: "failed_to_return" } }] }],
    });
    const late = await store.order({
      deliveries: [{ provider: "uber", status: "delivered", minutes: 0, proofUrl: "https://proof.example/2.jpg", events: [{ type: "courier_assigned", minutes: 25 }, { type: "delivered", minutes: 60 }] }],
    });
    const noProof = await store.order({
      deliveries: [{ provider: "doordash", status: "delivered", minutes: 0, events: [{ type: "courier_assigned", minutes: 3 }, { type: "delivered", minutes: 40 }] }],
    });
    // Not incidents: assigned in time and delivered with a photo; a PIN delivery has its proof; the store cancelled the order.
    await store.order({ deliveries: [{ provider: "uber", status: "delivered", minutes: 0, proofUrl: "https://proof.example/3.jpg", events: [{ type: "courier_assigned", minutes: 2 }, { type: "delivered", minutes: 30 }] }] });
    await store.order({ deliveries: [{ provider: "uber", status: "delivered", minutes: 0, pin: "1234", events: [{ type: "courier_assigned", minutes: 2 }, { type: "delivered", minutes: 30 }] }] });
    await store.order({ status: "CANCELLED", deliveries: [{ provider: "uber", status: "cancelled", minutes: 0, events: [{ type: "cancelled", minutes: 4 }] }] });
    // A store's own driver writes "delivered" with no delivery row; its photo lives on the order (review 536 Blocking 1).
    await store.order({
      fulfillment: "store-delivery",
      orderEvents: [{ type: "out_for_delivery", minutes: 10 }, { type: "delivered", minutes: 20, payload: { proofKey: "proofs/x.jpg" } }],
    });

    const { rows, nextCursor } = await list({ storeId: store.storeId });

    expect(nextCursor).toBeNull();
    const byNumber = Object.fromEntries(rows.map((r) => [r.orderNumber, r]));
    expect(Object.keys(byNumber).map(Number).sort()).toEqual(
      [failover, bothFailed, providerCancelled, returned, failedReturn, late, noProof].map((o) => o.number).sort(),
    );
    expect(byNumber[failover.number]).toMatchObject({
      orderId: failover.orderId,
      storeId: store.storeId,
      storeName: `Kinds Market ${RUN}`,
      providers: ["uber", "doordash"],
      kinds: ["failover"],
      openedAt: at(30),
      state: "open",
    });
    expect(byNumber[bothFailed.number]).toMatchObject({ providers: ["uber"], kinds: ["both_failed", "failover"], openedAt: at(1) });
    expect(byNumber[providerCancelled.number]).toMatchObject({ providers: ["doordash"], kinds: ["provider_cancelled"], openedAt: at(5) });
    expect(byNumber[returned.number]).toMatchObject({ providers: ["uber"], kinds: ["returned"], openedAt: at(50) });
    expect(byNumber[failedReturn.number]).toMatchObject({ kinds: ["returned"], openedAt: at(60) });
    expect(byNumber[late.number]).toMatchObject({ kinds: ["assigned_late"], openedAt: at(25) });
    expect(byNumber[noProof.number]).toMatchObject({ kinds: ["delivered_no_proof"], openedAt: at(40) });
    // Newest first.
    expect(rows.map((r) => r.openedAt.getTime())).toEqual([...rows.map((r) => r.openedAt.getTime())].sort((a, b) => b - a));
  });

  it("#577: assigned after the timeout uses the store's metro timeout when its metro sets one", async () => {
    const metro = await platformAdminTransaction((tx) =>
      tx.metro.create({ data: { name: `Late ${RUN}`, states: ["TX"], centerLat: 29.76, centerLng: -95.37, radiusMi: 40, courierAssignmentTimeoutS: 1200 } }),
    );
    const store = await newStore(`Metro Late ${RUN}`);
    await platformAdminTransaction((tx) => tx.store.update({ where: { id: store.storeId }, data: { metroId: metro.id } }));
    const assigned = (minutes: number) =>
      store.order({ deliveries: [{ provider: "uber", status: "delivered", minutes: 0, pin: "1234", events: [{ type: "courier_assigned", minutes }, { type: "delivered", minutes: 60 }] }] });
    const inTime = await assigned(16);
    const late = await assigned(25);

    const { rows } = await list({ storeId: store.storeId });

    expect(rows.map((r) => [r.orderNumber, r.kinds])).toEqual([[late.number, ["assigned_late"]]]);
    expect(rows.some((r) => r.orderNumber === inTime.number)).toBe(false);
    await platformAdminTransaction(async (tx) => {
      await tx.store.update({ where: { id: store.storeId }, data: { metroId: null } });
      await tx.metro.delete({ where: { id: metro.id } });
    });
  });

  it("AC2: filters by store, provider, kind and UTC date range", async () => {
    const a = await newStore(`Filter A ${RUN}`);
    const b = await newStore(`Filter B ${RUN}`);
    const uberDay1 = await a.order({ status: "READY", orderEvents: [{ type: "both_failed", minutes: 0 }], deliveries: [{ provider: "uber", status: "cancelled", minutes: -5, events: [{ type: "cancelled", minutes: -1 }] }] });
    const doordashDay2 = await a.order({ deliveries: [{ provider: "doordash", status: "delivered", minutes: 24 * 60, events: [{ type: "delivered", minutes: 24 * 60 + 30 }] }] });
    const otherStore = await b.order({ status: "READY", orderEvents: [{ type: "both_failed", minutes: 10 }] });
    const both = [a.storeId, b.storeId];
    const numbers = async (filters: IncidentFilters) => (await list(filters)).rows.filter((r) => both.includes(r.storeId)).map((r) => r.orderNumber).sort();

    expect(await numbers({ storeId: a.storeId })).toEqual([uberDay1.number, doordashDay2.number]);
    expect(await numbers({ storeId: b.storeId })).toEqual([otherStore.number]);
    expect(await numbers({ storeId: a.storeId, provider: "uber" })).toEqual([uberDay1.number]);
    expect(await numbers({ storeId: a.storeId, provider: "doordash" })).toEqual([doordashDay2.number]);
    expect(await numbers({ storeId: a.storeId, kind: "delivered_no_proof" })).toEqual([doordashDay2.number]);
    expect(await numbers({ storeId: a.storeId, kind: "provider_cancelled" })).toEqual([uberDay1.number]);
    expect(await numbers({ storeId: a.storeId, from: "2026-03-11" })).toEqual([doordashDay2.number]);
    expect(await numbers({ storeId: a.storeId, to: "2026-03-10" })).toEqual([uberDay1.number]);
    expect(await numbers({ storeId: a.storeId, from: "2026-03-10", to: "2026-03-11" })).toEqual([uberDay1.number, doordashDay2.number]);
    expect(await numbers({ storeId: a.storeId, from: "2026-03-12" })).toEqual([]);
  });

  it("AC2: keyset pages of 50, newest first, with no row repeated or skipped across equal times", async () => {
    const store = await newStore(`Paging ${RUN}`);
    const made: number[] = [];
    // 52 incidents; pairs share a timestamp, and the page boundary splits one, so the order id must break the tie.
    for (let i = 0; i < 52; i++) made.push((await store.order({ status: "READY", orderEvents: [{ type: "both_failed", minutes: Math.floor((i + 1) / 2) }] })).number);

    const first = await list({ storeId: store.storeId });
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ storeId: store.storeId, after: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const all = [...first.rows, ...second.rows];
    expect(all.map((r) => r.orderNumber).sort()).toEqual([...made].sort());
    const keys = all.map((r) => [r.openedAt.getTime(), r.orderId] as const);
    for (let i = 1; i < keys.length; i++) {
      const [t0, id0] = keys[i - 1];
      const [t1, id1] = keys[i];
      expect(t0 > t1 || (t0 === t1 && id0 > id1), `row ${i} sorts after row ${i - 1}`).toBe(true);
    }
    // A malformed cursor is ignored, never matched loosely: it reads the first page.
    expect((await list({ storeId: store.storeId, after: "2026-03-10%' OR 1=1" })).rows).toHaveLength(50);
  });

  it("store isolation: run as one store, the query returns only that store's incidents, whatever the store filter says", async () => {
    const a = await newStore(`Isolation A ${RUN}`);
    const b = await newStore(`Isolation B ${RUN}`);
    const mine = await a.order({ status: "READY", orderEvents: [{ type: "both_failed", minutes: 0 }] });
    await b.order({ status: "READY", orderEvents: [{ type: "both_failed", minutes: 0 }] });

    const asA = (filters: IncidentFilters) => storeScopedTransaction(a.storeId, (tx) => findCourierIncidents(tx, filters));

    expect((await asA({})).rows.map((r) => [r.storeId, r.orderNumber])).toEqual([[a.storeId, mine.number]]);
    expect((await asA({ storeId: b.storeId })).rows).toEqual([]);
  });

  it("AC5: a replayed courier webhook adds no second incident row and no second timeline event", async () => {
    const store = await newStore(`Replay ${RUN}`);
    const { orderId, number } = await store.order({ status: "COURIER_REQUESTED", deliveries: [{ provider: "uber", status: "requested", minutes: 0 }] });
    const event: DeliveryWebhookEvent = {
      provider: "uber",
      externalDeliveryId: `${RUN}-${orderId}-0`,
      externalEventId: `evt-${RUN}`,
      type: "cancelled",
      occurredAt: at(12),
      trackingUrl: null,
      actualFeeCents: null,
      courier: null,
      proof: { photoUrl: null, pinEntered: null },
      payload: { kind: "event.delivery_status", status: "canceled", data: { undeliverable_reason: "customer_unavailable" } },
    };

    expect(await applyCourierWebhook(event)).toBe("recorded");
    expect(await applyCourierWebhook(event)).toBe("duplicate");

    const { rows } = await list({ storeId: store.storeId });
    expect(rows.map((r) => [r.orderNumber, r.kinds])).toEqual([[number, ["provider_cancelled"]]]);
    const detail = await platformAdminTransaction((tx) => findCourierIncidentDetail(tx, orderId));
    expect(detail?.events.filter((e) => e.type === "cancelled")).toHaveLength(1);
  });
});
