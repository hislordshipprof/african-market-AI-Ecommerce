import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import {
  COURIER_BOTH_FAILED,
  COURIER_DELIVERY_CREATED,
  COURIER_FAILOVER_TRIGGERED,
  runCourierFailover,
  selectAndDispatch,
  type CourierEvent,
} from "./dispatch";
import {
  DeliveryProviderError,
  type CreatedDelivery,
  type DeliveryProvider,
  type DeliveryProviderName,
  type DeliveryQuote,
  type DeliveryRequest,
  type DeliveryWebhookEvent,
} from "./provider";

const hasDb = !!process.env.DATABASE_URL;

/**
 * Stub courier with the providers' own rules: create needs a live quote it issued, for the same delivery id;
 * a delivery is created once and cancelled once.
 */
class StubProvider implements DeliveryProvider {
  readonly quotes = new Map<string, { externalDeliveryId: string; expiresAt: Date }>();
  readonly created = new Map<string, "active" | "cancelled">();
  quoteCalls = 0;
  failCreate = false;
  failQuote = false;
  expiresInMs = 5 * 60_000;

  constructor(
    readonly name: DeliveryProviderName,
    private readonly feeCents: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(req: DeliveryRequest): Promise<DeliveryQuote> {
    this.quoteCalls++;
    if (this.failQuote) throw new DeliveryProviderError(this.name, 503, "service_unavailable", "down");
    const quoteId = `${this.name}-q${this.quoteCalls}`;
    const expiresAt = new Date(this.now().getTime() + this.expiresInMs);
    this.quotes.set(quoteId, { externalDeliveryId: req.externalDeliveryId, expiresAt });
    return { quoteId, feeCents: this.feeCents, currency: "USD", pickupEta: null, dropoffEta: null, expiresAt };
  }

  async create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery> {
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.externalDeliveryId !== req.externalDeliveryId) throw new DeliveryProviderError(this.name, 404, "quote_not_found", "unknown quote");
    if (quote.expiresAt <= this.now()) throw new DeliveryProviderError(this.name, 400, "quote_expired", "quote expired");
    if (this.failCreate) throw new DeliveryProviderError(this.name, 422, "validation_error", "rejected");
    const externalId = `${this.name}-${req.externalDeliveryId}`;
    if (this.created.has(externalId)) throw new DeliveryProviderError(this.name, 409, "duplicate_delivery_id", "exists");
    this.created.set(externalId, "active");
    return { externalId, trackingUrl: `https://track.example/${externalId}` };
  }

  async cancel(externalId: string): Promise<void> {
    const state = this.created.get(externalId);
    if (!state) throw new DeliveryProviderError(this.name, 404, "not_found", "unknown delivery");
    if (state === "cancelled") throw new DeliveryProviderError(this.name, 409, "cannot_be_cancelled", "already cancelled");
    this.created.set(externalId, "cancelled");
  }

  handleWebhook(): DeliveryWebhookEvent {
    throw new Error("not used");
  }
}

const request = {
  pickup: {
    businessName: "Dispatch Test Market",
    address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" },
    phone: "+13015550100",
  },
  dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199" },
  orderValueCents: 6000,
  tipCents: 0,
};

describe.skipIf(!hasDb)("courier selection and failover", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];
  let events: CourierEvent[];
  const emit = async (event: CourierEvent) => {
    events.push(event);
  };

  async function courierOrder(flags: { pickupEnabled: boolean; storeDeliveryEnabled: boolean }) {
    raw ??= testPrismaClient();
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const store = await raw.store.create({
      data: {
        slug: `dispatch-${stamp}`,
        name: "Dispatch Test Market",
        themePreset: "palm-and-shea",
        addressLine1: "8121 Georgia Ave",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
        ...flags,
      },
    });
    storeIds.push(store.id);
    const customer = await storeScoped(store.id).customer.create({
      data: { storeId: store.id, name: "Dispatch Buyer", email: `dispatch-${stamp}@example.com`, phone: "+13015550199" },
    });
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        status: "READY",
        fulfillment: "courier",
        subtotalCents: 6000,
        bufferCents: 0,
        totalCents: 6000,
        totalAuthorizedCents: 6000,
        number: 7,
        deliveryLine1: "1100 Wayne Ave",
        deliveryCity: "Silver Spring",
        deliveryState: "MD",
        deliveryZip: "20910",
      },
    });
    return { storeId: store.id, orderId: order.id };
  }

  beforeEach(() => {
    events = [];
  });

  afterAll(async () => {
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
      await raw.$disconnect();
    }
  });

  it("AC1/AC2: quotes both, books the cheaper and records its provider, brand and quoted fee", async () => {
    const { storeId, orderId } = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const doordash = new StubProvider("doordash", 899);
    const uber = new StubProvider("uber", 749);

    const result = await selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, uber], emit });

    expect(result).toMatchObject({ ok: true, courierProvider: "Uber Direct" });
    expect(doordash.quoteCalls).toBe(1);
    expect(doordash.created.size).toBe(0);
    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId } });
    expect(rows).toMatchObject([{ provider: "uber", quoteFeeCents: 749, status: "requested" }]);
    expect(events).toEqual([{ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: rows[0].id } }]);
  });

  it("a provider that cannot quote, or quotes an expired price, is unavailable and the other is booked", async () => {
    const { storeId, orderId } = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const down = new StubProvider("uber", 500);
    down.failQuote = true;
    const doordash = new StubProvider("doordash", 899);
    expect(await selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, down], emit })).toMatchObject({ ok: true, provider: "doordash" });

    const other = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const stale = new StubProvider("uber", 500);
    stale.expiresInMs = -1;
    expect(
      await selectAndDispatch({ ...other, request }, { providers: [new StubProvider("doordash", 899), stale], emit }),
    ).toMatchObject({ ok: true, provider: "doordash", quoteFeeCents: 899 });
    expect(stale.quoteCalls).toBe(1);
    expect(stale.created.size).toBe(0);
  });

  it("AC4: a create error on the cheaper provider books the other at once and reports the failover", async () => {
    const { storeId, orderId } = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const uber = new StubProvider("uber", 749);
    uber.failCreate = true;
    const doordash = new StubProvider("doordash", 899);

    const result = await selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, uber], emit });

    expect(result).toMatchObject({ ok: true, provider: "doordash", courierProvider: "DoorDash Drive", quoteFeeCents: 899 });
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED]);
    expect(events[0].data).toMatchObject({ orderId, fromProvider: "uber", reason: "create_failed" });
  });

  it("AC5: both failing emits courier.both_failed with the store's options and always cancel", async () => {
    const both = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: true });
    const failing = () => {
      const a = new StubProvider("uber", 749);
      const b = new StubProvider("doordash", 899);
      a.failCreate = true;
      b.failQuote = true;
      return [a, b];
    };
    expect(await selectAndDispatch({ ...both, request }, { providers: failing(), emit })).toEqual({ ok: false, reason: "both_failed" });
    expect(events.at(-1)).toEqual({
      name: COURIER_BOTH_FAILED,
      data: { storeId: both.storeId, orderId: both.orderId, orderNumber: 7, options: ["store-delivery", "pickup", "cancel"] },
    });

    const pickupOnly = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    await selectAndDispatch({ ...pickupOnly, request }, { providers: failing(), emit });
    expect(events.at(-1)?.data).toMatchObject({ options: ["pickup", "cancel"] });

    const neither = await courierOrder({ pickupEnabled: false, storeDeliveryEnabled: false });
    await selectAndDispatch({ ...neither, request }, { providers: failing(), emit });
    expect(events.at(-1)?.data).toMatchObject({ options: ["cancel"] });
    expect(await storeScoped(neither.storeId).delivery.count({ where: { orderId: neither.orderId } })).toBe(0);
  });

  async function dispatched(cheaper: StubProvider, other: StubProvider) {
    const ids = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const result = await selectAndDispatch({ ...ids, request }, { providers: [cheaper, other], emit });
    if (!result.ok) throw new Error("dispatch failed");
    events = [];
    return { ...ids, deliveryId: result.deliveryId };
  }

  it("AC3: no courier 10 minutes after creation cancels with the first provider and books the other", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId, deliveryId } = await dispatched(uber, doordash);
    const step = makeFakeStep();

    await runCourierFailover(step, { storeId, deliveryId }, { providers: [uber, doordash], emit });

    const created = (await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: deliveryId } })).createdAt;
    expect(step.sleepUntils).toEqual([{ name: "courier-assignment-timeout", until: new Date(created.getTime() + 600_000).toISOString() }]);
    expect([...uber.created.values()]).toEqual(["cancelled"]);
    expect(doordash.created.size).toBe(1);
    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.provider, r.status])).toEqual([["uber", "cancelled"], ["doordash", "requested"]]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED]);
    expect(events[0].data).toMatchObject({ fromProvider: "uber", reason: "assignment_timeout" });
  });

  it("a courier assigned before the timeout leaves the delivery alone", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, deliveryId } = await dispatched(uber, doordash);
    await storeScoped(storeId).delivery.update({ where: { id: deliveryId }, data: { status: "courier_assigned" } });

    await runCourierFailover(makeFakeStep(), { storeId, deliveryId }, { providers: [uber, doordash], emit });

    expect([...uber.created.values()]).toEqual(["active"]);
    expect(doordash.quoteCalls).toBe(1);
    expect(events).toEqual([]);
  });

  it("the alternate failing after the cancel fires both-failed; the second delivery's timeout does too", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const first = await dispatched(uber, doordash);
    doordash.failCreate = true;
    await runCourierFailover(makeFakeStep(), { storeId: first.storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit });
    expect([...uber.created.values()]).toEqual(["cancelled"]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_FAILOVER_TRIGGERED, COURIER_BOTH_FAILED]);

    const u2 = new StubProvider("uber", 749);
    const d2 = new StubProvider("doordash", 899);
    const second = await dispatched(u2, d2);
    await runCourierFailover(makeFakeStep(), { storeId: second.storeId, deliveryId: second.deliveryId }, { providers: [u2, d2], emit });
    const next = await storeScoped(second.storeId).delivery.findFirstOrThrow({ where: { orderId: second.orderId, provider: "doordash" } });
    events = [];
    await runCourierFailover(makeFakeStep(), { storeId: second.storeId, deliveryId: next.id }, { providers: [u2, d2], emit });
    expect([...d2.created.values()]).toEqual(["cancelled"]);
    expect(u2.quoteCalls).toBe(1);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_BOTH_FAILED]);
  });

  it("a cancel the provider refuses keeps the delivery and books no second courier", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, deliveryId } = await dispatched(uber, doordash);
    uber.created.set([...uber.created.keys()][0], "cancelled");

    await runCourierFailover(makeFakeStep(), { storeId, deliveryId }, { providers: [uber, doordash], emit });

    expect((await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe("requested");
    expect(doordash.created.size).toBe(0);
    expect(events).toEqual([]);
  });

  it("RLS: the timer for store A's delivery run as store B finds nothing and changes nothing", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const a = await dispatched(uber, doordash);
    const b = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });

    await runCourierFailover(makeFakeStep(), { storeId: b.storeId, deliveryId: a.deliveryId }, { providers: [uber, doordash], emit });

    expect([...uber.created.values()]).toEqual(["active"]);
    expect((await storeScoped(a.storeId).delivery.findUniqueOrThrow({ where: { id: a.deliveryId } })).status).toBe("requested");
    expect(await storeScoped(b.storeId).delivery.findMany()).toEqual([]);
    expect(events).toEqual([]);
  });
});
