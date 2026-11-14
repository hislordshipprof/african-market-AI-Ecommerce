import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import { DoorDashDriveProvider } from "./doordash";
import { fakeDoorDash } from "./doordash-fake";
import { UberDirectProvider } from "./uber-direct";
import { fakeUberDirect } from "./uber-direct-fake";
import {
  COURIER_DELIVERY_CREATED,
  cancelOrderCouriers,
  dispatchPackingOrder,
  dispatchReadyOrder,
  pushReadyTime,
  runCourierFailover,
  type CourierEvent,
} from "./dispatch";
import { DEFAULT_SECONDS_PER_ITEM, READY_CAP_MINUTES, READY_FLOOR_MINUTES, readyMinutes } from "./ready-estimate";
import { DeliveryProviderError } from "./provider";
import { courierLine } from "../order/staff-copy";

const hasDb = !!process.env.DATABASE_URL;
const MIN = 60_000;

describe("ready time estimate (#562 AC1)", () => {
  it("uses the default pace without enough history, between the floor and the cap", () => {
    expect(DEFAULT_SECONDS_PER_ITEM).toBe(90);
    expect(readyMinutes(12, [])).toBe(18);
    expect(readyMinutes(1, [])).toBe(READY_FLOOR_MINUTES);
    expect(readyMinutes(200, [])).toBe(READY_CAP_MINUTES);
    // Two samples are not enough history.
    expect(readyMinutes(12, [{ items: 1, seconds: 3600 }, { items: 1, seconds: 3600 }])).toBe(18);
  });

  it("uses the store's median pace per item from its recent orders", () => {
    const recent = [
      { items: 10, seconds: 1200 }, // 120 s/item
      { items: 20, seconds: 3600 }, // 180 s/item
      { items: 5, seconds: 300 }, // 60 s/item
      { items: 0, seconds: 900 }, // ignored: no items
    ];
    expect(readyMinutes(10, recent)).toBe(20);
    expect(readyMinutes(30, recent)).toBe(READY_CAP_MINUTES);
  });
});

describe("fakes take the providers' ready-time fields (#562 AC1)", () => {
  const now = new Date("2026-11-14T15:00:00.000Z");
  const ready = new Date("2026-11-14T15:22:00.000Z");
  const request = {
    externalDeliveryId: "ord-562-a",
    pickup: { businessName: "Timing Market", address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550100" },
    dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199", givenName: "Ada" },
    orderValueCents: 6000,
    tipCents: 0,
    pickupReadyAt: ready,
  };

  it("Uber Direct: pickup_ready_dt on quote and create, moved by update delivery", async () => {
    const keys = { UBER_DIRECT_CLIENT_ID: `client-562-${Date.now()}`, UBER_DIRECT_CLIENT_SECRET: "s", UBER_DIRECT_CUSTOMER_ID: "a418e2aa-0000-4000-8000-000000000562" };
    const fake = fakeUberDirect({ clientId: keys.UBER_DIRECT_CLIENT_ID, clientSecret: keys.UBER_DIRECT_CLIENT_SECRET, customerId: keys.UBER_DIRECT_CUSTOMER_ID, now: () => now });
    const uber = new UberDirectProvider({ env: keys, fetch: (input, init) => fake.fetch(input as string, init), now: () => now });

    const quote = await uber.quote(request);
    const created = await uber.create(quote.quoteId, request);
    expect(fake.calls.filter((c) => c.body).map((c) => c.body?.pickup_ready_dt)).toEqual([ready.toISOString(), ready.toISOString()]);

    const pushed = new Date(ready.getTime() + 5 * MIN);
    await uber.reschedule(created.externalId, pushed);
    expect(fake.deliveries.get(created.externalId)?.pickupReadyDt).toBe(pushed.toISOString());

    await uber.cancel(created.externalId);
    await expect(uber.reschedule(created.externalId, pushed)).rejects.toMatchObject({ status: 400 });
  });

  it("DoorDash Drive: pickup_time on the quote, moved by PATCH", async () => {
    const keys = { DOORDASH_DEVELOPER_ID: "dev-562", DOORDASH_KEY_ID: "key-562", DOORDASH_SIGNING_SECRET: Buffer.from("signing-secret-562-bytes-0123456789").toString("base64url") };
    const fake = fakeDoorDash({ developerId: keys.DOORDASH_DEVELOPER_ID, keyId: keys.DOORDASH_KEY_ID, signingSecret: keys.DOORDASH_SIGNING_SECRET, now: () => now });
    const doordash = new DoorDashDriveProvider({ env: keys, fetch: fake.fetch, now: () => now });

    const quote = await doordash.quote(request);
    const created = await doordash.create(quote.quoteId, request);
    expect(fake.calls[0].body).toMatchObject({ pickup_time: ready.toISOString() });

    const pushed = new Date(ready.getTime() + 5 * MIN);
    await doordash.reschedule(created.externalId, pushed);
    expect(fake.calls.at(-1)).toMatchObject({ method: "PATCH", path: `/drive/v2/deliveries/${created.externalId}`, body: { pickup_time: pushed.toISOString() } });
    expect(fake.quotes.get(created.externalId)?.body.pickup_time).toBe(pushed.toISOString());
  });

  it("the webhook's pickup ETA reaches the store (AC3)", () => {
    const env = { DOORDASH_WEBHOOK_AUTHORIZATION: "Basic abc" };
    const event = new DoorDashDriveProvider({ env }).handleWebhook(
      JSON.stringify({ event_name: "DASHER_CONFIRMED", external_delivery_id: "d1", created_at: now.toISOString(), dasher_name: "Sam", pickup_time_estimated: ready.toISOString() }),
      new Headers({ authorization: "Basic abc" }),
    );
    expect(event.courier).toMatchObject({ name: "Sam", pickupEta: ready });
  });
});

describe.skipIf(!hasDb)("courier booked when packing starts (#562)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];
  let events: CourierEvent[];
  const emit = async (event: CourierEvent) => {
    events.push(event);
  };
  // Fixed offsets from one clock read, so nothing depends on the hour the suite runs.
  const T0 = new Date(Math.ceil(Date.now() / MIN) * MIN);
  const now = () => T0;

  const ddKeys = { DOORDASH_DEVELOPER_ID: "dev-562", DOORDASH_KEY_ID: "key-562", DOORDASH_SIGNING_SECRET: Buffer.from("signing-secret-562-bytes-0123456789").toString("base64url") };
  function doordash(fee = 899) {
    const fake = fakeDoorDash({ developerId: ddKeys.DOORDASH_DEVELOPER_ID, keyId: ddKeys.DOORDASH_KEY_ID, signingSecret: ddKeys.DOORDASH_SIGNING_SECRET, now, quoteFeeCents: fee });
    return { fake, provider: new DoorDashDriveProvider({ env: ddKeys, fetch: fake.fetch, now }) };
  }
  function uber(fee = 749) {
    const keys = { UBER_DIRECT_CLIENT_ID: `client-562-${Math.random()}`, UBER_DIRECT_CLIENT_SECRET: "s", UBER_DIRECT_CUSTOMER_ID: "a418e2aa-0000-4000-8000-000000000562" };
    const fake = fakeUberDirect({ clientId: keys.UBER_DIRECT_CLIENT_ID, clientSecret: keys.UBER_DIRECT_CLIENT_SECRET, customerId: keys.UBER_DIRECT_CUSTOMER_ID, now, quoteFeeCents: fee });
    return { fake, provider: new UberDirectProvider({ env: keys, fetch: (input, init) => fake.fetch(input as string, init), now }) };
  }

  async function packingOrder(opts: { plan?: "pro" | "starter"; qty?: number; status?: string; fulfillment?: string } = {}) {
    raw ??= testPrismaClient();
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const store = await raw.store.create({
      data: { slug: `timing-${stamp}`, name: "Timing Market", themePreset: "palm-and-shea", addressLine1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910", phone: "+13015550100" },
    });
    storeIds.push(store.id);
    await platformAdminTransaction((tx) => tx.storeSubscription.create({ data: { storeId: store.id, plan: opts.plan ?? "pro", status: "active" } }));
    const scoped = storeScoped(store.id);
    const customer = await scoped.customer.create({ data: { storeId: store.id, name: "Timing Buyer", email: `timing-${stamp}@example.com`, phone: "+13015550199" } });
    const listing = await scoped.listing.create({ data: { storeId: store.id, customName: "Yam", price: 500, stockMode: "counted", qty: 100 } });
    const variant = await scoped.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 500, weightG: 450 } });
    const order = await scoped.order.create({
      data: {
        storeId: store.id, customerId: customer.id, status: opts.status ?? "PICKING", fulfillment: opts.fulfillment ?? "courier", number: 11,
        subtotalCents: 6000, bufferCents: 0, totalCents: 6000, totalAuthorizedCents: 6000, pickingStartedAt: T0,
        deliveryLine1: "1100 Wayne Ave", deliveryCity: "Silver Spring", deliveryState: "MD", deliveryZip: "20910",
        lines: { create: [{ listingVariantId: variant.id, qtyOrdered: opts.qty ?? 12, unitPriceCents: 500, status: "pending" }] },
      },
    });
    return { storeId: store.id, orderId: order.id };
  }

  const deliveries = (storeId: string, orderId: string) => storeScoped(storeId).delivery.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const order = (storeId: string, orderId: string) => storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } });

  beforeEach(() => {
    events = [];
  });

  afterAll(async () => {
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.listing.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await platformAdminTransaction((tx) => tx.storeSubscription.deleteMany({ where: { storeId: { in: storeIds } } }));
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
      await raw.$disconnect();
    }
  });

  it("AC1: packing start books the cheaper courier for the estimated ready time, through each provider's own field", async () => {
    const { storeId, orderId } = await packingOrder({ qty: 12 });
    const dd = doordash(899);
    const ub = uber(749);

    const result = await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider, ub.provider], emit, now });

    const ready = new Date(T0.getTime() + 18 * MIN); // 12 items × 90 s, no history yet
    expect(result).toMatchObject({ ok: true, provider: "uber" });
    expect(dd.fake.calls[0].body).toMatchObject({ pickup_time: ready.toISOString() });
    expect(ub.fake.calls.find((c) => c.path.endsWith("/deliveries"))?.body).toMatchObject({ pickup_ready_dt: ready.toISOString() });
    expect(await deliveries(storeId, orderId)).toMatchObject([{ provider: "uber", status: "requested", pickupReadyAt: ready }]);
    expect(await order(storeId, orderId)).toMatchObject({ status: "PICKING", readyEstimateAt: ready });
    expect(events.map((e) => e.name)).toEqual([COURIER_DELIVERY_CREATED]);

    const again = await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider, ub.provider], emit, now });
    expect(again).toMatchObject({ ok: true, existing: true });
    expect(await deliveries(storeId, orderId)).toHaveLength(1);
  });

  it("AC1: the store's recent packing times set the pace", async () => {
    const { storeId, orderId } = await packingOrder({ qty: 10 });
    const scoped = storeScoped(storeId);
    const base = await scoped.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true, lines: { select: { listingVariantId: true } } } });
    for (const [i, seconds] of [1200, 1200, 1200].entries()) {
      await scoped.order.create({
        data: {
          storeId, customerId: base.customerId, status: "DELIVERED", fulfillment: "courier", number: 100 + i,
          subtotalCents: 500, bufferCents: 0, totalCents: 500, totalAuthorizedCents: 500,
          pickingStartedAt: new Date(T0.getTime() - 86_400_000), readyAt: new Date(T0.getTime() - 86_400_000 + seconds * 1000),
          lines: { create: [{ listingVariantId: base.lines[0].listingVariantId, qtyOrdered: 10, unitPriceCents: 50, status: "picked" }] },
        },
      });
    }

    await dispatchPackingOrder(storeId, orderId, { providers: [doordash().provider], emit, now });

    // 120 s per item × 10 items.
    expect((await order(storeId, orderId)).readyEstimateAt).toEqual(new Date(T0.getTime() + 20 * MIN));
  });

  it("only a courier order that is packing is booked, and a Starter store never is", async () => {
    const accepted = await packingOrder({ status: "ACCEPTED" });
    const pickup = await packingOrder({ fulfillment: "pickup" });
    const starter = await packingOrder({ plan: "starter" });
    const dd = doordash();
    expect(await dispatchPackingOrder(accepted.storeId, accepted.orderId, { providers: [dd.provider], emit, now })).toEqual({ ok: false, reason: "not_packing" });
    expect(await dispatchPackingOrder(pickup.storeId, pickup.orderId, { providers: [dd.provider], emit, now })).toEqual({ ok: false, reason: "not_packing" });
    expect(await dispatchPackingOrder(starter.storeId, starter.orderId, { providers: [dd.provider], emit, now })).toEqual({ ok: false, reason: "plan" });
    expect(dd.fake.calls).toEqual([]);
  });

  it("AC3: marking ready moves the order on to its courier's step with no second booking", async () => {
    const { storeId, orderId } = await packingOrder();
    const dd = doordash();
    const booked = await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider], emit, now });
    if (!booked.ok) throw new Error("booking failed");
    await storeScoped(storeId).delivery.update({ where: { id: booked.deliveryId }, data: { status: "courier_assigned" } });
    await storeScoped(storeId).order.update({ where: { id: orderId }, data: { status: "READY", readyAt: T0 } });

    expect(await dispatchReadyOrder(storeId, orderId, { providers: [dd.provider], emit, now })).toMatchObject({ ok: true, existing: true });

    expect((await order(storeId, orderId)).status).toBe("COURIER_ASSIGNED");
    expect(dd.fake.calls.filter((c) => c.path === "/drive/v2/quotes")).toHaveLength(1);
  });

  it("AC2: the store pushes the ready time once; DoorDash moves the booked delivery", async () => {
    const { storeId, orderId } = await packingOrder();
    const dd = doordash();
    await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider], emit, now });
    const later = () => new Date(T0.getTime() + 2 * MIN);

    const pushed = await pushReadyTime(storeId, orderId, { providers: [dd.provider], emit, now: later });

    const ready = new Date(T0.getTime() + 23 * MIN);
    expect(pushed).toEqual({ ok: true, readyEstimateAt: ready, courier: "moved" });
    expect(dd.fake.calls.at(-1)).toMatchObject({ method: "PATCH", body: { pickup_time: ready.toISOString() } });
    expect(await deliveries(storeId, orderId)).toMatchObject([{ status: "requested", pickupReadyAt: ready }]);
    expect(await pushReadyTime(storeId, orderId, { providers: [dd.provider], emit, now: later })).toEqual({ ok: false, error: "The ready time was already pushed once" });
  });

  it("AC2: a past-due ready time is pushed from now", async () => {
    const { storeId, orderId } = await packingOrder();
    const dd = doordash();
    await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider], emit, now });
    const late = new Date(T0.getTime() + 30 * MIN);
    const pushed = await pushReadyTime(storeId, orderId, { providers: [dd.provider], emit, now: () => late });
    expect(pushed).toEqual({ ok: true, readyEstimateAt: new Date(late.getTime() + 5 * MIN), courier: "moved" });
  });

  it("AC2: a provider that will not move the delivery is cancelled and re-booked through the failover selection", async () => {
    const { storeId, orderId } = await packingOrder();
    const ub = uber(749);
    const dd = doordash(899);
    await dispatchPackingOrder(storeId, orderId, { providers: [ub.provider, dd.provider], emit, now });
    const refusing = Object.assign(Object.create(Object.getPrototypeOf(ub.provider)), ub.provider, {
      reschedule: async () => {
        throw new DeliveryProviderError("uber", 400, "invalid_params", "cannot update");
      },
    });

    const pushed = await pushReadyTime(storeId, orderId, { providers: [refusing, dd.provider], emit, now });

    const ready = new Date(T0.getTime() + 23 * MIN);
    expect(pushed).toEqual({ ok: true, readyEstimateAt: ready, courier: "rebooked" });
    const rows = await deliveries(storeId, orderId);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "requested"]);
    expect(rows[1]).toMatchObject({ pickupReadyAt: ready });
    expect([...ub.fake.deliveries.values()].map((d) => d.status)).toContain("canceled");
  });

  it("AC2: an assigned courier the provider will not move keeps its time", async () => {
    const { storeId, orderId } = await packingOrder();
    const dd = doordash();
    const booked = await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider], emit, now });
    if (!booked.ok) throw new Error("booking failed");
    await storeScoped(storeId).delivery.update({ where: { id: booked.deliveryId }, data: { status: "courier_assigned" } });
    const refusing = { ...dd.provider, name: "doordash" as const, quote: dd.provider.quote.bind(dd.provider), create: dd.provider.create.bind(dd.provider), cancel: dd.provider.cancel.bind(dd.provider), handleWebhook: dd.provider.handleWebhook.bind(dd.provider), reschedule: async () => { throw new Error("refused"); } };

    expect(await pushReadyTime(storeId, orderId, { providers: [refusing], emit, now })).toMatchObject({ ok: true, courier: "kept" });
    expect((await deliveries(storeId, orderId)).map((r) => r.status)).toEqual(["courier_assigned"]);
  });

  it("AC4: a cancelled order cancels its courier with the provider; another store's courier is untouched", async () => {
    const mine = await packingOrder();
    const other = await packingOrder();
    const dd = doordash();
    await dispatchPackingOrder(mine.storeId, mine.orderId, { providers: [dd.provider], emit, now });
    await dispatchPackingOrder(other.storeId, other.orderId, { providers: [dd.provider], emit, now });

    expect(await cancelOrderCouriers(mine.storeId, mine.orderId, { providers: [dd.provider] })).toEqual({ skipped: "order_not_cancelled" });
    await storeScoped(mine.storeId).order.update({ where: { id: mine.orderId }, data: { status: "CANCELLED" } });
    // Another store cannot reach this order's courier.
    expect(await cancelOrderCouriers(other.storeId, mine.orderId, { providers: [dd.provider] })).toEqual({ skipped: "order_not_cancelled" });

    expect(await cancelOrderCouriers(mine.storeId, mine.orderId, { providers: [dd.provider] })).toEqual({ cancelled: 1, refused: 0 });
    expect(dd.fake.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/cancel"))).toHaveLength(1);
    expect((await deliveries(mine.storeId, mine.orderId)).map((r) => r.status)).toEqual(["cancelled"]);
    expect((await deliveries(other.storeId, other.orderId)).map((r) => r.status)).toEqual(["requested"]);
    // A repeat run cancels nothing twice.
    expect(await cancelOrderCouriers(mine.storeId, mine.orderId, { providers: [dd.provider] })).toEqual({ cancelled: 0, refused: 0 });
  });

  it("AC4: a refused cancel keeps the delivery and is reported; a transient error restores it and throws for a retry", async () => {
    const refusedOrder = await packingOrder();
    const ub = uber();
    await dispatchPackingOrder(refusedOrder.storeId, refusedOrder.orderId, { providers: [ub.provider], emit, now });
    await storeScoped(refusedOrder.storeId).order.update({ where: { id: refusedOrder.orderId }, data: { status: "CANCELLED" } });
    const refusing = Object.assign(Object.create(Object.getPrototypeOf(ub.provider)), ub.provider, {
      cancel: async () => {
        throw new DeliveryProviderError("uber", 409, "noncancelable_delivery", "Delivery cannot be canceled.");
      },
    });
    expect(await cancelOrderCouriers(refusedOrder.storeId, refusedOrder.orderId, { providers: [refusing] })).toEqual({ cancelled: 0, refused: 1 });
    expect((await deliveries(refusedOrder.storeId, refusedOrder.orderId)).map((r) => r.status)).toEqual(["requested"]);

    const flaky = Object.assign(Object.create(Object.getPrototypeOf(ub.provider)), ub.provider, {
      cancel: async () => {
        throw new DeliveryProviderError("uber", 503, "unavailable", "down");
      },
    });
    await expect(cancelOrderCouriers(refusedOrder.storeId, refusedOrder.orderId, { providers: [flaky] })).rejects.toThrow("down");
    expect((await deliveries(refusedOrder.storeId, refusedOrder.orderId)).map((r) => r.status)).toEqual(["requested"]);
    expect(await cancelOrderCouriers(refusedOrder.storeId, refusedOrder.orderId, { providers: [ub.provider] })).toEqual({ cancelled: 1, refused: 0 });
  });

  it("the assignment timer waits for the ready time, and again after a push", async () => {
    const { storeId, orderId } = await packingOrder({ qty: 30 }); // 45 min, the cap
    const dd = doordash();
    const booked = await dispatchPackingOrder(storeId, orderId, { providers: [dd.provider], emit, now });
    if (!booked.ok) throw new Error("booking failed");
    await storeScoped(storeId).delivery.update({ where: { id: booked.deliveryId }, data: { status: "courier_assigned" } });
    const ready = new Date(T0.getTime() + 45 * MIN);
    const pushedTo = new Date(ready.getTime() + 5 * MIN);
    const step = makeFakeStep({
      onSleepUntil: async (until) => {
        if (until.getTime() === ready.getTime()) await storeScoped(storeId).delivery.update({ where: { id: booked.deliveryId }, data: { pickupReadyAt: pushedTo } });
      },
    });

    await runCourierFailover(step, { storeId, deliveryId: booked.deliveryId }, { providers: [dd.provider], emit, now });

    expect(step.sleepUntils).toEqual([
      { name: "courier-assignment-timeout", until: ready.toISOString() },
      { name: "courier-assignment-timeout-pushed", until: pushedTo.toISOString() },
    ]);
  });

  it("a timer that fires on a cancelled order's courier cancels it and books no other", async () => {
    const { storeId, orderId } = await packingOrder();
    const ub = uber(749);
    const dd = doordash(899);
    const booked = await dispatchPackingOrder(storeId, orderId, { providers: [ub.provider, dd.provider], emit, now });
    if (!booked.ok) throw new Error("booking failed");
    await storeScoped(storeId).order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });

    await runCourierFailover(makeFakeStep(), { storeId, deliveryId: booked.deliveryId }, { providers: [ub.provider, dd.provider], emit, now });

    expect((await deliveries(storeId, orderId)).map((r) => [r.provider, r.status])).toEqual([["uber", "cancelled"]]);
    expect(dd.fake.calls.filter((c) => c.path.endsWith("/accept"))).toHaveLength(0);
  });
});

describe("store's courier line (#562 AC3)", () => {
  const time = (v: Date | string) => new Date(v).toISOString().slice(11, 16);
  it("shows the booked time, then the driver's ETA, then the pickup", () => {
    const base = { provider: "uber", pickupReadyAt: "2026-11-14T15:22:00.000Z", courierJson: null };
    expect(courierLine(null, time)).toBeNull();
    expect(courierLine({ ...base, status: "requested" }, time)).toBe("Uber Direct booked for 15:22, finding a driver");
    expect(courierLine({ ...base, provider: "doordash", pickupReadyAt: null, status: "requested" }, time)).toBe("DoorDash Drive: finding a driver");
    expect(courierLine({ ...base, status: "courier_assigned", courierJson: { name: "Sam", pickupEta: "2026-11-14T15:19:00.000Z" } }, time)).toBe("Driver Sam arriving about 15:19");
    expect(courierLine({ ...base, status: "courier_assigned", courierJson: { name: null } }, time)).toBe("Driver on the way");
    expect(courierLine({ ...base, status: "picked_up" }, time)).toBe("Uber Direct: picked up");
  });
});
