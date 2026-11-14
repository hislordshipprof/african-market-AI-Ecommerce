import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import { DoorDashDriveProvider } from "./doordash";
import { fakeDoorDash } from "./doordash-fake";
import {
  COURIER_BOTH_FAILED,
  COURIER_DELIVERY_CREATED,
  COURIER_FAILOVER_TRIGGERED,
  courierFailoverFailed,
  courierRequest,
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
 * Stub courier with the providers' own rules: a delivery id is quoted once (DoorDash's 409); create needs a live
 * quote it issued, for the same delivery id; a delivery is created once and cancelled once.
 */
class StubProvider implements DeliveryProvider {
  readonly quotes = new Map<string, { externalDeliveryId: string; expiresAt: Date }>();
  readonly created = new Map<string, "active" | "picked_up" | "cancelled">();
  /** Thrown by the next cancel calls, in order, before the stub's own rules. */
  cancelErrors: Error[] = [];
  cancelCalls = 0;
  readonly requests: DeliveryRequest[] = [];
  quoteCalls = 0;
  externalId?: string;
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
    this.requests.push(req);
    if ([...this.quotes.values()].some((q) => q.externalDeliveryId === req.externalDeliveryId)) {
      throw new DeliveryProviderError(this.name, 409, "duplicate_delivery_id", "duplicate");
    }
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
    const externalId = this.externalId ?? `${this.name}-${req.externalDeliveryId}`;
    if (this.created.has(externalId)) throw new DeliveryProviderError(this.name, 409, "duplicate_delivery_id", "exists");
    this.created.set(externalId, "active");
    return { externalId, trackingUrl: `https://track.example/${externalId}` };
  }

  async cancel(externalId: string): Promise<void> {
    this.cancelCalls++;
    const err = this.cancelErrors.shift();
    if (err) throw err;
    const state = this.created.get(externalId);
    if (!state) throw new DeliveryProviderError(this.name, 404, "not_found", "unknown delivery");
    if (state !== "active") throw new DeliveryProviderError(this.name, 409, "cannot_be_cancelled", `delivery is ${state}`);
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

  async function courierOrder(flags: { pickupEnabled: boolean; storeDeliveryEnabled: boolean; uberLocationId?: string }) {
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

  it("the alternate failing after the cancel fires both-failed with no second switch; the second delivery's timeout does too", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const first = await dispatched(uber, doordash);
    doordash.failCreate = true;
    await runCourierFailover(makeFakeStep(), { storeId: first.storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit });
    expect([...uber.created.values()]).toEqual(["cancelled"]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_BOTH_FAILED]);

    const u2 = new StubProvider("uber", 749);
    const d2 = new StubProvider("doordash", 899);
    const second = await dispatched(u2, d2);
    await runCourierFailover(makeFakeStep(), { storeId: second.storeId, deliveryId: second.deliveryId }, { providers: [u2, d2], emit });
    const next = await storeScoped(second.storeId).delivery.findFirstOrThrow({ where: { orderId: second.orderId, provider: "doordash" } });
    events = [];
    await runCourierFailover(makeFakeStep(), { storeId: second.storeId, deliveryId: next.id }, { providers: [u2, d2], emit });
    expect([...d2.created.values()]).toEqual(["cancelled"]);
    expect(u2.quoteCalls).toBe(1);
    expect(events.map((e) => e.name)).toEqual([COURIER_BOTH_FAILED]);
  });

  it("a cancel the provider refuses because a courier has the order keeps the delivery and books no second courier", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, deliveryId } = await dispatched(uber, doordash);
    uber.created.set([...uber.created.keys()][0], "picked_up");

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

describe.skipIf(!hasDb)("courier dispatch: review round 1", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];
  let events: CourierEvent[] = [];
  const emit = async (event: CourierEvent) => {
    events.push(event);
  };

  async function courierOrder(store: { uberLocationId?: string; registerDoorDash?: boolean } = {}) {
    raw ??= testPrismaClient();
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await raw.store.create({
      data: {
        slug: `dispatch-r1-${stamp}`,
        name: "Dispatch Test Market",
        themePreset: "palm-and-shea",
        addressLine1: "8121 Georgia Ave",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
        pickupEnabled: true,
        uberLocationId: store.uberLocationId,
      },
    });
    storeIds.push(created.id);
    if (store.registerDoorDash) await raw.store.update({ where: { id: created.id }, data: { doordashStoreId: created.id } });
    const customer = await storeScoped(created.id).customer.create({
      data: { storeId: created.id, name: "Dispatch Buyer", email: `dispatch-${stamp}@example.com`, phone: "+13015550199" },
    });
    const order = await storeScoped(created.id).order.create({
      data: {
        storeId: created.id,
        customerId: customer.id,
        status: "READY",
        fulfillment: "courier",
        subtotalCents: 6000,
        bufferCents: 0,
        totalCents: 6000,
        totalAuthorizedCents: 6000,
        number: 8,
        deliveryLine1: "1100 Wayne Ave",
        deliveryCity: "Silver Spring",
        deliveryState: "MD",
        deliveryZip: "20910",
      },
    });
    return { storeId: created.id, orderId: order.id };
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

  it("B1: a failed row write after a booking cancels that courier and books no second one", async () => {
    const taken = await courierOrder();
    const externalId = `uber-taken-${taken.orderId}`;
    await storeScoped(taken.storeId).delivery.create({
      data: { storeId: taken.storeId, orderId: taken.orderId, provider: "uber", externalId, status: "requested", quoteFeeCents: 1 },
    });
    const { storeId, orderId } = await courierOrder();
    const uber = new StubProvider("uber", 749);
    uber.externalId = externalId;
    const doordash = new StubProvider("doordash", 899);

    await expect(selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, uber], emit })).rejects.toThrow(/Unique constraint/);

    expect([...uber.created.values()]).toEqual(["cancelled"]);
    expect(doordash.created.size).toBe(0);
    expect(events).toEqual([]);
  });

  it("B2: each adapter gets only its own registration (DoorDash: business and store id; Uber: none)", async () => {
    const { storeId, orderId } = await courierOrder({ uberLocationId: "org-uber-123", registerDoorDash: true });
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);

    await selectAndDispatch({ storeId, orderId, ...(await courierRequest(storeId, orderId)) }, { providers: [doordash, uber], emit });

    expect(doordash.requests[0].pickup).toMatchObject({ providerBusinessId: storeId, providerStoreId: storeId });
    expect(uber.requests[0].pickup.providerStoreId).toBeUndefined();
    expect(uber.requests[0].pickup.providerBusinessId).toBeUndefined();
  });

  it("B3: after an Uber timeout the real DoorDash adapter is quoted with a new delivery id and booked", async () => {
    const keys = {
      DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
      DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
      DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
    };
    const fake = fakeDoorDash({ developerId: keys.DOORDASH_DEVELOPER_ID, keyId: keys.DOORDASH_KEY_ID, signingSecret: keys.DOORDASH_SIGNING_SECRET, now: () => new Date(), quoteFeeCents: 899 });
    const doordash = new DoorDashDriveProvider({ env: keys, fetch: fake.fetch });
    const uber = new StubProvider("uber", 749);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, uber], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];

    await runCourierFailover(makeFakeStep(), { storeId, deliveryId: first.deliveryId }, { providers: [doordash, uber], emit });

    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.provider, r.status])).toEqual([["uber", "cancelled"], ["doordash", "requested"]]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED]);
  });

  it("N2: a replayed redispatch step after the alternate was booked books nothing and reports no failure", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [uber, doordash], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];
    const fake = makeFakeStep();
    const replaying = {
      ...fake,
      async run<T>(name: string, fn: () => Promise<T>) {
        const out = await fake.run(name, fn);
        return name === "courier-redispatch" ? fake.run(name, fn) : out;
      },
    };

    await runCourierFailover(replaying, { storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit });

    expect(doordash.created.size).toBe(1);
    expect(await storeScoped(storeId).delivery.count({ where: { orderId } })).toBe(2);
    // The replay re-sends the timer event for the same delivery; its event id makes Inngest drop the repeat.
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED, COURIER_DELIVERY_CREATED]);
    expect(events[1].data).toEqual(events[2].data);
  });
  it("R2-B1: a transient cancel error is retried and the failover completes", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [uber, doordash], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];
    uber.cancelErrors.push(new DeliveryProviderError("uber", 503, "service_unavailable", "down"));

    await runCourierFailover(makeFakeStep({ attempts: 3 }), { storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit });

    expect(uber.cancelCalls).toBe(2);
    expect([...uber.created.values()]).toEqual(["cancelled"]);
    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.provider, r.status])).toEqual([["uber", "cancelled"], ["doordash", "requested"]]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED]);
  });

  it("R2-B1: a cancel that keeps failing throws for Inngest, and the failure handler tells the store", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [uber, doordash], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];
    const down = () => new DeliveryProviderError("uber", 503, "service_unavailable", "down");
    uber.cancelErrors.push(down(), down(), down());
    const deps = { providers: [uber, doordash], emit };

    await expect(runCourierFailover(makeFakeStep({ attempts: 3 }), { storeId, deliveryId: first.deliveryId }, deps)).rejects.toThrow("down");
    await courierFailoverFailed({ storeId, deliveryId: first.deliveryId }, deps);

    expect(doordash.created.size).toBe(0);
    expect(events.map((e) => e.name)).toEqual([COURIER_BOTH_FAILED]);
    expect(events[0].data).toMatchObject({ orderId, options: ["pickup", "cancel"] });
  });

  it("R2-N1: a delivery the provider already cancelled itself fails over", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [uber, doordash], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];
    uber.created.set([...uber.created.keys()][0], "cancelled");
    await storeScoped(storeId).deliveryEvent.create({
      data: { storeId, orderId, deliveryId: first.deliveryId, externalEventId: "uber-evt-cancel", type: "cancelled" },
    });

    await runCourierFailover(makeFakeStep(), { storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit });

    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.provider, r.status])).toEqual([["uber", "cancelled"], ["doordash", "requested"]]);
    expect(events.map((e) => e.name)).toEqual([COURIER_FAILOVER_TRIGGERED, COURIER_DELIVERY_CREATED]);
  });

  it("R2-N3: a lost timer event for the alternate is sent again when Inngest retries the redispatch step", async () => {
    const uber = new StubProvider("uber", 749);
    const doordash = new StubProvider("doordash", 899);
    const { storeId, orderId } = await courierOrder();
    const first = await selectAndDispatch({ storeId, orderId, request }, { providers: [uber, doordash], emit });
    if (!first.ok) throw new Error("dispatch failed");
    events = [];
    let lost = false;
    const flaky = async (event: CourierEvent) => {
      if (event.name === COURIER_DELIVERY_CREATED && !lost) {
        lost = true;
        throw new Error("inngest send timed out");
      }
      events.push(event);
    };

    await runCourierFailover(makeFakeStep({ attempts: 2 }), { storeId, deliveryId: first.deliveryId }, { providers: [uber, doordash], emit: flaky });

    const alternate = await storeScoped(storeId).delivery.findFirstOrThrow({ where: { orderId, provider: "doordash" } });
    expect(doordash.created.size).toBe(1);
    expect(events.filter((e) => e.name === COURIER_DELIVERY_CREATED).map((e) => e.data)).toEqual([{ storeId, deliveryId: alternate.id }]);
  });
});
