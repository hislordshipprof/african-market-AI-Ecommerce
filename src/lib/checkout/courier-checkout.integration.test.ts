import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped } from "../db";
import type { Contact } from "../customer-flow/contracts";
import type { CreatedDelivery, DeliveryProvider, DeliveryProviderName, DeliveryQuote, DeliveryRequest, DeliveryWebhookEvent } from "../delivery/provider";

const { retrieve, cancel, paymentIntents } = vi.hoisted(() => {
  const paymentIntents = new Map<string, Record<string, unknown>>();
  const retrieve = vi.fn(async (id: string) => {
    const fixture = paymentIntents.get(id);
    if (!fixture) throw new Error(`No such payment_intent: '${id}'`);
    return fixture;
  });
  const cancel = vi.fn(async (id: string) => {
    const fixture = paymentIntents.get(id);
    if (!fixture) throw new Error(`No such payment_intent: '${id}'`);
    fixture.status = "canceled";
    return fixture;
  });
  return { retrieve, cancel, paymentIntents };
});

vi.mock("../stripe/provider", () => ({ getStripeClient: () => ({ paymentIntents: { retrieve, cancel } }) }));
vi.mock("../inngest/send", () => ({ sendOrderAuthorized: vi.fn().mockResolvedValue(undefined) }));

import { writeGeocodeCache } from "../address/cache";
import { dispatchReadyOrder } from "../delivery/dispatch";
import { placeOrder, quoteCheckout, type DeliveryRequest as CheckoutAddress } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada Buyer", phone: "+13015550199", email: "ada@t527.test" };
const STORE_POINT = { lat: 38.9907, lng: -77.0261 };
const ADDRESS: CheckoutAddress = { line1: "1100 WAYNE AVE", line2: null, city: "SILVER SPRING", state: "MD", zip: "20910", leaveAtDoor: false };

/** A courier with the providers' rules: a quote is for one delivery id, create needs that live quote. */
class StubCourier implements DeliveryProvider {
  readonly quotes = new Map<string, string>();
  readonly created: string[] = [];
  quoteCalls = 0;
  failQuote = false;
  constructor(readonly name: DeliveryProviderName, public feeCents: number) {}
  async quote(req: DeliveryRequest): Promise<DeliveryQuote> {
    this.quoteCalls++;
    if (this.failQuote) throw new Error("provider down");
    const quoteId = `${this.name}-q${this.quoteCalls}`;
    this.quotes.set(quoteId, req.externalDeliveryId);
    return { quoteId, feeCents: this.feeCents, currency: "USD", pickupEta: null, dropoffEta: null, expiresAt: new Date(Date.now() + 5 * 60_000) };
  }
  async create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery> {
    if (this.quotes.get(quoteId) !== req.externalDeliveryId) throw new Error("unknown quote");
    this.created.push(req.externalDeliveryId);
    return { externalId: `${this.name}-${req.externalDeliveryId}`, trackingUrl: null };
  }
  async cancel(): Promise<void> {}
  handleWebhook(): DeliveryWebhookEvent {
    throw new Error("not used");
  }
}

describe.skipIf(!hasDb)("courier delivery at checkout (#527, lane DB)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    await writeGeocodeCache(ADDRESS, { ...ADDRESS, formattedAddress: "1100 WAYNE AVE, SILVER SPRING, MD, 20910", lat: 38.9946, lng: -77.0247 });
  }, 30_000);

  afterEach(() => {
    paymentIntents.clear();
  });

  afterAll(async () => {
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.cartLine.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await platformAdminTransaction((tx) => tx.storeSubscription.deleteMany({ where: { storeId: { in: storeIds } } }));
    await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    await raw.$disconnect();
  }, 30_000);

  async function seed(opts: { plan?: "pro" | "starter"; registered?: boolean; weightG?: number; frozen?: boolean; perishable?: boolean } = {}) {
    const stamp = crypto.randomUUID().slice(0, 8);
    const store = await raw.store.create({
      data: {
        slug: `t527-${stamp}`,
        name: "Courier Market",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_t527_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
        addressLine1: "8121 Georgia Ave",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
        lat: STORE_POINT.lat,
        lng: STORE_POINT.lng,
        deliveryRadiusMi: 8,
        uberLocationId: opts.registered === false ? null : `org-${stamp}`,
      },
    });
    storeIds.push(store.id);
    await platformAdminTransaction((tx) => tx.storeSubscription.create({ data: { storeId: store.id, plan: opts.plan ?? "pro", status: "active" } }));
    const scoped = storeScoped(store.id);
    const listing = await scoped.listing.create({
      data: { storeId: store.id, customName: "Goat meat", price: 4000, stockMode: "unlimited", frozen: opts.frozen ?? false, perishable: opts.perishable ?? false },
    });
    const variant = await scoped.listingVariant.create({ data: { listingId: listing.id, label: "2 lb", price: 4000, weightG: opts.weightG ?? 900 } });
    const cart = await scoped.cart.create({ data: { storeId: store.id } });
    await scoped.cartLine.create({ data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" } });
    return { store, cart };
  }

  it("AC1: an eligible order shows the cheapest real quote, unmarked, and the brand", async () => {
    const { store, cart } = await seed();
    const uber = new StubCourier("uber", 749);
    const doordash = new StubCourier("doordash", 899);

    const quote = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [doordash, uber] });

    expect(quote.problems).toEqual([]);
    expect(quote).toMatchObject({ courierFeeCents: 749, courierProvider: "Uber Direct", deliveryFeeCents: 0 });
    expect(quote.totalCents).toBe(4000 + 120 + 749);
    expect(uber.created).toEqual([]);
  });

  it("AC1: an ineligible order says why and asks no courier", async () => {
    const uber = new StubCourier("uber", 749);
    const cases = [
      { opts: { weightG: 23_000 }, message: /item in your basket is over the 50 lb courier limit/ },
      { opts: { registered: false }, message: /isn't set up for courier delivery/ },
      { opts: { plan: "starter" as const }, message: /does not offer courier delivery/ },
    ];
    for (const { opts, message } of cases) {
      const { store, cart } = await seed(opts);
      const quote = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
      expect(quote.problems).toEqual([expect.objectContaining({ code: "ineligible", message: expect.stringMatching(message) })]);
      expect(quote.courierFeeCents).toBe(0);
    }
    const { store, cart } = await seed();
    const unconfirmed = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", { ...ADDRESS, line1: "1 NOWHERE RD" }, { couriers: [uber] });
    expect(unconfirmed.problems).toEqual([expect.objectContaining({ message: "We couldn't find that address" })]);
    expect(uber.quoteCalls).toBe(0);
  });

  it("AC1: a frozen or perishable order goes by courier hand to hand, never left at the door", async () => {
    const { store, cart } = await seed({ perishable: true });
    const uber = new StubCourier("uber", 749);
    const atDoor = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", { ...ADDRESS, leaveAtDoor: true }, { couriers: [uber] });
    expect(atDoor.problems).toEqual([expect.objectContaining({ code: "ineligible", message: expect.stringMatching(/hand-to-hand/) })]);
    const handoff = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
    expect(handoff.problems).toEqual([]);
  });

  it("AC2: Pay asks again; a changed fee or no courier is shown before any hold", async () => {
    const { store, cart } = await seed();
    const uber = new StubCourier("uber", 749);
    await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
    const repeat = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
    expect(repeat.courierFeeCents).toBe(749);
    expect(uber.quoteCalls).toBe(1);

    const same = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber], recheckCourier: true });
    expect(same.problems).toEqual([]);
    expect(uber.quoteCalls).toBe(2);

    uber.feeCents = 1049;
    const changed = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber], recheckCourier: true });
    expect(changed.problems).toEqual([expect.objectContaining({ code: "quote-changed", message: expect.stringContaining("$10.49") })]);
    expect(changed.totalCents).toBe(4000 + 120 + 1049);
    const accepted = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber], recheckCourier: true });
    expect(accepted.problems).toEqual([]);

    uber.failQuote = true;
    const failed = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber], recheckCourier: true });
    expect(failed.problems).toEqual([expect.objectContaining({ code: "ineligible", message: expect.stringMatching(/No courier can take this order/) })]);
    expect(failed.courierFeeCents).toBe(0);
  });

  async function authorize(store: { id: string; stripeAccountId: string | null }, cartId: string, amount: number) {
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    await storeScoped(store.id).cart.update({ where: { id: cartId }, data: { paymentIntentId } });
    paymentIntents.set(paymentIntentId, {
      status: "requires_capture",
      amount,
      on_behalf_of: store.stripeAccountId,
      transfer_data: { destination: store.stripeAccountId },
      metadata: { store_id: store.id },
    });
    return paymentIntentId;
  }

  async function saveAddress(storeId: string, cartId: string) {
    await storeScoped(storeId).cart.update({
      where: { id: cartId },
      data: { deliveryLine1: ADDRESS.line1, deliveryCity: ADDRESS.city, deliveryState: ADDRESS.state, deliveryZip: ADDRESS.zip, deliveryLat: 38.9946, deliveryLng: -77.0247 },
    });
  }

  it("AC3/AC4: placing creates a courier order whose hold covers the fee; Ready dispatches through #136", async () => {
    const { store, cart } = await seed();
    const uber = new StubCourier("uber", 749);
    const quote = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
    await saveAddress(store.id, cart.id);
    const paymentIntentId = await authorize(store, cart.id, quote.holdCents);

    const placed = await placeOrder(store.id, 0, cart.id, CONTACT, "courier", null, null, paymentIntentId);

    const order = await storeScoped(store.id).order.findUniqueOrThrow({ where: { id: placed.token } });
    expect(order).toMatchObject({
      fulfillment: "courier",
      deliveryFeeCents: 749,
      totalCents: 4000 + 120 + 749,
      totalAuthorizedCents: quote.holdCents,
      deliveryLine1: ADDRESS.line1,
      deliveryZip: ADDRESS.zip,
    });
    // #495: the platform fee is the service fee plus the store's card fee on its own part; the courier fee passes through.
    expect(order.platformFeeCents).toBe(120 + Math.round(4000 * 0.029) + 30);

    await storeScoped(store.id).order.update({ where: { id: order.id }, data: { status: "READY" } });
    const dispatched = await dispatchReadyOrder(store.id, order.id, { providers: [uber], emit: async () => {} });
    expect(dispatched).toMatchObject({ ok: true, provider: "uber" });
    expect(uber.created).toHaveLength(1);
    expect(await storeScoped(store.id).order.findUnique({ where: { id: order.id }, select: { status: true } })).toEqual({ status: "COURIER_REQUESTED" });
  });

  it("AC3: a hold that does not cover the shown courier fee places no order", async () => {
    const { store, cart } = await seed();
    const uber = new StubCourier("uber", 749);
    const quote = await quoteCheckout(store.id, 0, cart.id, CONTACT, "courier", ADDRESS, { couriers: [uber] });
    await saveAddress(store.id, cart.id);
    const paymentIntentId = await authorize(store, cart.id, quote.holdCents - 749);

    await expect(placeOrder(store.id, 0, cart.id, CONTACT, "courier", null, null, paymentIntentId)).rejects.toThrow(/basket changed/i);
    expect(await storeScoped(store.id).order.count()).toBe(0);
  });
});
