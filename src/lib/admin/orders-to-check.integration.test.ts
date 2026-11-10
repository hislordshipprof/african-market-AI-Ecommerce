import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
import { findOrdersToCheck } from "./orders-to-check-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t420-${Date.now()}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let prisma: PrismaClient;
const storeIds: string[] = [];

function newStore(): string {
  const id = crypto.randomUUID();
  storeIds.push(id);
  return id;
}

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

beforeAll(() => {
  if (hasDb) prisma = testPrismaClient();
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
  });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("orders to check (lane DB)", () => {
  const storeId = newStore();
  const storeName = `Check Market ${RUN}`;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${storeName}, ${RUN}, 'active', now())`;
      const customer = await tx.customer.create({ data: { storeId, name: "Check Customer" } });
      let number = 42000;
      const order = async (key: string, data: Partial<Prisma.OrderUncheckedCreateInput>) => {
        const created = await tx.order.create({
          data: {
            storeId,
            customerId: customer.id,
            number: number++,
            subtotalCents: 1000,
            bufferCents: 0,
            totalAuthorizedCents: 1000,
            inngestEventSentAt: ago(10 * DAY),
            ...data,
          },
        });
        ids[key] = created.id;
      };
      const audit = (orderId: string, action: string, createdAt: Date) =>
        tx.auditLog.create({
          data: { storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action, entityType: "order", entityId: orderId, createdAt },
        });

      await order("notStarted", { status: "AUTHORIZED", createdAt: ago(20 * MIN), inngestEventSentAt: null });
      await order("fresh", { status: "AUTHORIZED", createdAt: ago(5 * MIN), inngestEventSentAt: null });
      await order("timerOverdue", { status: "AUTHORIZED", createdAt: ago(2 * HOUR) });
      await order("cancelling", { status: "CANCELLING", createdAt: ago(2 * HOUR), updatedAt: ago(1 * MIN) });
      await audit(ids.cancelling, "cancel_retry", ago(40 * MIN));
      await audit(ids.cancelling, "cancel_retry", ago(2 * MIN));
      await order("picking", { status: "ACCEPTED", createdAt: ago(2 * HOUR + 5 * MIN), acceptedAt: ago(2 * HOUR), prepEstimateMinutes: 20 });
      await order("scheduled", {
        status: "ACCEPTED",
        createdAt: ago(2 * HOUR + 5 * MIN),
        acceptedAt: ago(2 * HOUR),
        prepEstimateMinutes: 20,
        pickupSlot: new Date(now.getTime() + 6 * HOUR).toISOString(),
      });
      await order("farSlot", {
        status: "ACCEPTED",
        createdAt: ago(2 * HOUR + 5 * MIN),
        acceptedAt: ago(2 * HOUR),
        prepEstimateMinutes: 20,
        pickupSlot: new Date(now.getTime() + 30 * DAY).toISOString(),
      });
      await order("hold", {
        status: "ACCEPTED",
        createdAt: ago(5 * DAY + HOUR),
        acceptedAt: ago(5 * DAY),
        prepEstimateMinutes: 20,
        pickupSlot: new Date(now.getTime() + HOUR).toISOString(),
      });
      await order("ready", { status: "READY", createdAt: ago(6 * HOUR), readyAt: ago(5 * HOUR), capturedAmountCents: 1000 });
      await order("awaitingPickup", { status: "AWAITING_PICKUP", createdAt: ago(3 * DAY), readyAt: ago(49 * HOUR), capturedAmountCents: 1000 });
      await order("outForDelivery", { status: "OUT_FOR_DELIVERY", createdAt: ago(6 * HOUR), readyAt: ago(5 * HOUR), outForDeliveryAt: ago(5 * HOUR), capturedAmountCents: 1000 });

      await order("released", { status: "CANCELLED", createdAt: ago(2 * DAY), cancelledAt: ago(DAY) });
      await audit(ids.released, "capture_released", ago(DAY));
      await order("unknownRefund", { status: "REFUND_FAILED", createdAt: ago(9 * DAY), capturedAmountCents: 1000 });
      await audit(ids.unknownRefund, "refund_request_unknown", ago(8 * DAY));
      await order("oldClosed", { status: "CANCELLED", createdAt: ago(9 * DAY), cancelledAt: ago(8 * DAY) });
      await audit(ids.oldClosed, "acceptance_alert", ago(8 * DAY));
    });
  });

  it("lists each stuck order once with its reason, and the alerts nothing else reads", async () => {
    const { stuck, cappedGroups, alerts, alertsCapped } = await findOrdersToCheck({ now, storeIds: [storeId] });
    const reasonOf = (key: string) => stuck.filter((row) => row.orderId === ids[key]).map((row) => row.reason);

    expect(reasonOf("notStarted")).toEqual(["timer not started"]);
    expect(reasonOf("timerOverdue")).toEqual(["timer overdue"]);
    expect(reasonOf("cancelling")).toEqual(["retry stalled"]);
    expect(reasonOf("picking")).toEqual(["picking overdue"]);
    expect(reasonOf("farSlot")).toEqual(["picking overdue"]);
    expect(reasonOf("hold")).toEqual(["card hold expiring"]);
    expect(reasonOf("ready")).toEqual(["ready too long"]);
    expect(reasonOf("awaitingPickup")).toEqual(["waiting for pickup too long"]);
    expect(reasonOf("outForDelivery")).toEqual(["out for delivery too long"]);
    expect(reasonOf("fresh")).toEqual([]);
    expect(reasonOf("scheduled")).toEqual([]);
    expect(stuck.find((row) => row.orderId === ids.cancelling)?.since).toEqual(ago(40 * MIN));
    expect(cappedGroups).toEqual([]);
    expect(alertsCapped).toBe(false);

    const released = alerts.find((row) => row.orderId === ids.released);
    expect(released).toMatchObject({ action: "capture_released", storeName, orderNumber: expect.any(Number) });
    expect(alerts.some((row) => row.orderId === ids.unknownRefund && row.action === "refund_request_unknown")).toBe(true);
    expect(alerts.some((row) => row.orderId === ids.oldClosed)).toBe(false);
  });
});

describe.skipIf(!hasDb)("orders to check: a full captured group does not hide uncaptured orders (lane DB)", () => {
  const storeId = newStore();
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let capturingId = "";

  beforeAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${`Backlog Market ${RUN}`}, ${`${RUN}-backlog`}, 'active', now())`;
      const customer = await tx.customer.create({ data: { storeId, name: "Backlog Customer" } });
      const base = { storeId, customerId: customer.id, subtotalCents: 1000, bufferCents: 0, totalAuthorizedCents: 1000, inngestEventSentAt: ago(20 * DAY) };
      await tx.order.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          ...base,
          number: 43000 + i,
          status: "AWAITING_PICKUP" as const,
          createdAt: ago(20 * DAY - i * MIN),
          readyAt: ago(19 * DAY),
          capturedAmountCents: 1000,
        })),
      });
      const capturing = await tx.order.create({ data: { ...base, number: 43500, status: "CAPTURING", createdAt: ago(4 * HOUR) } });
      capturingId = capturing.id;
      await tx.auditLog.create({
        data: { storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action: "capture_retry", entityType: "order", entityId: capturingId, createdAt: ago(3 * HOUR) },
      });
    });
  }, 30_000);

  it("lists a stalled capture behind 200 old uncollected pickups", async () => {
    const { stuck, cappedGroups } = await findOrdersToCheck({ now, storeIds: [storeId] });
    expect(stuck.some((row) => row.orderId === capturingId && row.reason === "retry stalled")).toBe(true);
    expect(cappedGroups).toEqual(["captured"]);
  });
});

describe.skipIf(!hasDb)("orders to check: orders not yet due do not fill a group's cap (lane DB)", () => {
  const storeId = newStore();
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let capturingId = "";
  let notStartedId = "";

  beforeAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${`Scheduled Market ${RUN}`}, ${`${RUN}-scheduled`}, 'active', now())`;
      const customer = await tx.customer.create({ data: { storeId, name: "Scheduled Customer" } });
      const base = { storeId, customerId: customer.id, subtotalCents: 1000, bufferCents: 0, totalAuthorizedCents: 1000, inngestEventSentAt: ago(2 * DAY) };
      await tx.order.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          ...base,
          number: 44000 + i,
          status: "ACCEPTED" as const,
          createdAt: ago(2 * DAY - i * MIN),
          acceptedAt: ago(2 * DAY - i * MIN - 10 * MIN),
          prepEstimateMinutes: 20,
          pickupSlot: new Date(now.getTime() + 2 * DAY).toISOString(),
        })),
      });
      const waiting = await tx.order.createManyAndReturn({
        select: { id: true },
        data: Array.from({ length: 200 }, (_, i) => ({
          ...base,
          number: 44300 + i,
          status: "AUTHORIZED" as const,
          createdAt: ago(DAY - i * MIN),
          acceptanceClockStartsAt: new Date(now.getTime() + DAY),
        })),
      });
      await tx.auditLog.createMany({
        data: waiting.map(({ id }) => ({ storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action: "acceptance_alert", entityType: "order", entityId: id, createdAt: ago(HOUR) })),
      });
      const capturing = await tx.order.create({ data: { ...base, number: 44600, status: "CAPTURING", createdAt: ago(4 * HOUR) } });
      capturingId = capturing.id;
      await tx.auditLog.create({
        data: { storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action: "capture_retry", entityType: "order", entityId: capturingId, createdAt: ago(3 * HOUR) },
      });
      const notStarted = await tx.order.create({ data: { ...base, number: 44601, status: "AUTHORIZED", createdAt: ago(20 * MIN), inngestEventSentAt: null } });
      notStartedId = notStarted.id;
    });
  }, 30_000);

  it("lists a stalled capture behind 200 scheduled orders and a timer not started behind 200 waiting orders", async () => {
    const { stuck, cappedGroups } = await findOrdersToCheck({ now, storeIds: [storeId] });
    expect(stuck.map((row) => [row.orderId, row.reason])).toEqual(
      expect.arrayContaining([
        [capturingId, "retry stalled"],
        [notStartedId, "timer not started"],
      ]),
    );
    expect(stuck).toHaveLength(2);
    expect(cappedGroups).toEqual(["authorized", "uncaptured"]);
  });

  it("says when the alert list hits its cap", async () => {
    const { alerts, alertsCapped } = await findOrdersToCheck({ now, storeIds: [storeId] });
    expect(alerts).toHaveLength(200);
    expect(alertsCapped).toBe(true);
  });
});
