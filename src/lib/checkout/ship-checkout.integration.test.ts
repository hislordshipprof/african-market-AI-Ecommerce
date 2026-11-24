import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction, storeScoped } from "../db";
import { writeGeocodeCache } from "../address/cache";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { setStripeProvider } from "../stripe";
import { capturedPayments, fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { fakeTaxCalculator, setTaxCalculatorForTests } from "../tax/calculator";
import { markReady } from "../order/service";
import { updateListing } from "../listing/service";
import { ShippoProvider } from "../shipping/shippo";
import { fakeShippo } from "../shipping/shippo-fake";
import { saveStoreShipping } from "../shipping/store-shipping";
import { BasketChangedError, createPaymentIntent, placeOrder, quoteCheckout, saveDeliverySnapshot, type DeliveryRequest } from "./service";

vi.mock("../inngest/send", () => ({ sendOrderAuthorized: vi.fn().mockResolvedValue(undefined) }));

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `t567-${Date.now().toString(36)}`;
const CONTACT = { name: "Ada Buyer", phone: "+15015550199", email: "ada@t567.test" };
// The store is in Houston; the shopper is in Little Rock, far outside any delivery radius.
const AR: DeliveryRequest = { line1: "500 W MARKHAM ST", line2: null, city: "LITTLE ROCK", state: "AR", zip: "72201", leaveAtDoor: false };
const AR_POINT = { lat: 34.7465, lng: -92.2896 };
const NV: DeliveryRequest = { line1: "200 S VIRGINIA ST", line2: null, city: "RENO", state: "NV", zip: "89501", leaveAtDoor: false };
// Only this file allows Arkansas; the e2e seed allows Maryland.
const ALLOWED = "AR";
const RATES = { AR: { rate: 0.065 }, TX: { rate: 0.0825 } };
const TOKEN = "shippo_test_t567";

function shippo() {
  const fetch = fakeShippo({ token: TOKEN });
  return { fetch, provider: new ShippoProvider({ apiKey: TOKEN, fetch }) };
}

describe.skipIf(!hasDb)("shipping at checkout (#567, lane DB)", () => {
  const raw = testPrismaClient();
  const storeIds: string[] = [];
  let actor = { id: "", email: `${RUN}-owner@t567.test` };

  async function seed(opts: { handlingDays?: number | null; frozen?: boolean; weightG?: number; shippable?: boolean; qty?: number; weightPlaceholder?: boolean } = {}) {
    const stamp = crypto.randomUUID().slice(0, 8);
    const store = await platformAdmin.store.create({
      data: {
        slug: `${RUN}-${stamp}`, name: "Ship Market", pickupEnabled: true, stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        addressLine1: "100 Main St", city: "Houston", state: "TX", zip: "77002", lat: 29.7604, lng: -95.3698, deliveryRadiusMi: 8,
        phone: "+17135550100", shippingHandlingDays: opts.handlingDays === undefined ? 2 : opts.handlingDays,
      },
    });
    storeIds.push(store.id);
    const scoped = storeScoped(store.id);
    const listing = await scoped.listing.create({
      data: { storeId: store.id, customName: "Garri", price: 1200, stockMode: "unlimited", frozen: opts.frozen ?? false, shippable: opts.shippable ?? true },
    });
    const variant = await scoped.listingVariant.create({ data: { listingId: listing.id, label: "4 lb", price: 1200, weightG: opts.weightG ?? 1814, weightPlaceholder: opts.weightPlaceholder ?? false } });
    const cart = await scoped.cart.create({ data: { storeId: store.id } });
    await scoped.cartLine.create({ data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: opts.qty ?? 2, swapRule: "exact_only" } });
    return { store, cartId: cart.id, listingId: listing.id, variantId: variant.id };
  }

  /** The order of createPaymentIntentAction: quote, hold, card, then the confirmed address is saved on the cart. */
  async function payAndSave(storeId: string, cartId: string, holdCents: number) {
    const pi = await createPaymentIntent(storeId, cartId, holdCents);
    await getCheckoutPayments().confirmPaymentIntent(pi.paymentIntentId, { payment_method: "pm_card_visa" });
    await saveDeliverySnapshot(storeId, cartId, { ...AR, line2: null, ...AR_POINT });
    return pi.paymentIntentId;
  }

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    // Placement asks whether a label can be bought and kept (#765): the allowed Shippo fake and a proof bucket.
    vi.stubEnv("E2E_FAKE_SHIPPO", "1");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    resetFakeCheckoutPayments();
    actor = { ...actor, id: (await raw.user.create({ data: { id: crypto.randomUUID(), email: actor.email, name: "Owner", emailVerified: true } })).id };
    await writeGeocodeCache(AR, { ...AR, formattedAddress: "500 W MARKHAM ST, LITTLE ROCK, AR, 72201", ...AR_POINT });
    await writeGeocodeCache(NV, { ...NV, formattedAddress: "200 S VIRGINIA ST, RENO, NV, 89501", lat: 39.5262, lng: -119.8128 });
    // Appended and removed, never overwritten, so the e2e seed's states are left alone.
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_append(array_remove(shipping_states, ${ALLOWED}), ${ALLOWED}) WHERE id = 'platform'`));
  });

  afterEach(() => {
    setTaxCalculatorForTests(null);
    setStripeProvider(null);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_remove(shipping_states, ${ALLOWED}) WHERE id = 'platform'`));
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.stockEvent.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.cartLine.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await platformAdminTransaction((tx) => tx.auditLog.deleteMany({ where: { storeId: { in: storeIds } } }));
    await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    await raw.user.deleteMany({ where: { id: actor.id } });
    resetFakeCheckoutPayments();
    await raw.$disconnect();
  });

  it("AC3–AC5: a shippable basket to an allowed state gets the cheapest rate, unmarked, taxed at the destination, and places with it", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const { store, cartId } = await seed();
    const { fetch, provider } = shippo();

    const quote = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: provider });

    // 2 × 4 lb = 8 lb. Fake USPS Ground Advantage: $5.45 + 8 × $0.95 = $13.05, cheaper than Priority ($18.55) and UPS ($17.30).
    expect(quote.problems).toEqual([]);
    expect(quote.shipping).toEqual({ feeCents: 1305, carrier: "USPS", service: "Ground Advantage", days: 5, handlingDays: 2 });
    // Goods 2400, service fee 3% = 72 held at its $0.99 minimum, tax 6.5% of goods = 156.
    expect(quote.taxCents).toBe(156);
    expect(quote.totalCents).toBe(2400 + 99 + 1305 + 156);
    expect(tax.calls.map((call) => (call.input as { address: { state: string } }).address.state)).toEqual(["AR"]);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ address_from: { state: "TX", zip: "77002" }, address_to: { state: "AR", zip: "72201", name: "Ada Buyer" }, async: false });

    const paymentIntentId = await payAndSave(store.id, cartId, quote.holdCents);
    const placed = await placeOrder(store.id, 0, cartId, CONTACT, "ship", null, null, paymentIntentId);

    const order = await storeScoped(store.id).order.findUniqueOrThrow({ where: { id: placed.token } });
    expect(order).toMatchObject({
      fulfillment: "ship", status: "AUTHORIZED",
      deliveryFeeCents: 1305, totalCents: quote.totalCents, totalAuthorizedCents: quote.holdCents, taxCents: 156,
      deliveryState: "AR", deliveryZip: "72201", deliveryDistanceMi: null,
      shippingCarrier: "USPS", shippingService: "Ground Advantage", shippingDays: 5, shippingRateId: "rate_fake_1_0",
    });
    // Placement charged the locked rate; Shippo was not asked again.
    expect(fetch.calls).toHaveLength(1);
  });

  it("AC4: the rate is locked until it expires; an expired rate that came back different is shown before Pay", async () => {
    const { store, cartId } = await seed();
    const { fetch, provider } = shippo();
    await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: provider });
    const again = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: provider });
    expect(again.shipping?.feeCents).toBe(1305);
    expect(fetch.calls).toHaveLength(1);

    const cart = await storeScoped(store.id).cart.findUniqueOrThrow({ where: { id: cartId } });
    expect(cart.shippingQuoteExpiresAt!.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3600_000);
    // Expired, and the carrier now charges more.
    await storeScoped(store.id).cart.update({ where: { id: cartId }, data: { shippingQuoteExpiresAt: new Date(Date.now() - 1000) } });
    const pricier = new ShippoProvider({ apiKey: TOKEN, fetch: fakeShippo({ token: TOKEN, services: [{ provider: "USPS", name: "Ground Advantage", baseCents: 645, perLbCents: 95, days: 5 }] }) });
    const changed = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: pricier });
    expect(changed.problems).toEqual([expect.objectContaining({ code: "quote-changed", message: expect.stringContaining("$14.05") })]);
    expect(changed.totalCents).toBe(2400 + 99 + 1405);
    const accepted = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: pricier });
    expect(accepted.problems).toEqual([]);
  });

  it("AC2–AC4: no rate unless every line ships, the store ships, the state is allowed and the order is at most 50 lb", async () => {
    const cases = [
      { opts: { shippable: false }, address: AR, message: /can't ship/ },
      // Marked shippable before it was frozen: it still does not ship.
      { opts: { frozen: true }, address: AR, message: /can't ship/ },
      // A CSV import's made-up 100 g never prices a parcel, even on a listing marked shippable (#752).
      { opts: { weightG: 100, weightPlaceholder: true }, address: AR, message: /can't ship/ },
      { opts: { handlingDays: null }, address: AR, message: /doesn't ship orders/ },
      { opts: {}, address: NV, message: /can't ship to that state/ },
      // 23 kg × 1 = 50.7 lb.
      { opts: { weightG: 23_000, qty: 1 }, address: AR, message: /up to 50 lb/ },
    ];
    for (const { opts, address, message } of cases) {
      const { store, cartId } = await seed(opts);
      const { fetch, provider } = shippo();
      const quote = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", address, { shipping: provider });
      expect(quote.problems).toEqual([expect.objectContaining({ code: "ineligible", message: expect.stringMatching(message) })]);
      expect(quote.shipping).toBeUndefined();
      expect(fetch.calls).toHaveLength(0);
    }
  });

  it("#765 AC1: Ship is refused at the quote and at placement while a label cannot be bought and kept (no Shippo, or no proof bucket)", async () => {
    const unavailable = [expect.objectContaining({ code: "ineligible", message: expect.stringMatching(/^Shipping isn't available/) })];
    try {
      vi.stubEnv("R2_PROOF_BUCKET", "");
      const noBucket = await seed();
      const { fetch, provider } = shippo();
      const refused = await quoteCheckout(noBucket.store.id, 0, noBucket.cartId, CONTACT, "ship", AR, { shipping: provider });
      expect(refused.problems).toEqual(unavailable);
      expect(refused.shipping).toBeUndefined();
      expect(fetch.calls).toHaveLength(0);
      vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");

      const noShippo = await seed();
      const withoutShippo = await quoteCheckout(noShippo.store.id, 0, noShippo.cartId, CONTACT, "ship", AR, { shipping: null });
      expect(withoutShippo.problems).toEqual(unavailable);

      // The hold was taken with both in place; either one gone before placement makes no order.
      for (const [name, value] of [["R2_PROOF_BUCKET", "proof-bucket"], ["E2E_FAKE_SHIPPO", "1"]] as const) {
        const { store, cartId } = await seed();
        const quote = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: shippo().provider });
        expect(quote.problems).toEqual([]);
        const paymentIntentId = await payAndSave(store.id, cartId, quote.holdCents);
        vi.stubEnv(name, "");
        await expect(placeOrder(store.id, 0, cartId, CONTACT, "ship", null, null, paymentIntentId)).rejects.toThrow(BasketChangedError);
        expect(await storeScoped(store.id).order.count()).toBe(0);
        vi.stubEnv(name, value);
      }
    } finally {
      vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
      vi.stubEnv("E2E_FAKE_SHIPPO", "1");
    }
  });

  it("placement refuses a rate that expired, or a line that stopped shipping, after the hold; no order is made", async () => {
    for (const change of ["expired", "frozen", "placeholder"] as const) {
      const { store, cartId, listingId } = await seed();
      const { provider } = shippo();
      const quote = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: provider });
      const paymentIntentId = await payAndSave(store.id, cartId, quote.holdCents);
      if (change === "expired") {
        await storeScoped(store.id).cart.update({ where: { id: cartId }, data: { shippingQuoteExpiresAt: new Date(Date.now() - 1000) } });
      } else if (change === "frozen") {
        await storeScoped(store.id).listing.update({ where: { id: listingId }, data: { frozen: true } });
      } else {
        await storeScoped(store.id).listingVariant.updateMany({ where: { listingId }, data: { weightPlaceholder: true } });
      }
      await expect(placeOrder(store.id, 0, cartId, CONTACT, "ship", null, null, paymentIntentId)).rejects.toThrow(BasketChangedError);
      expect(await storeScoped(store.id).order.count()).toBe(0);
    }
  });

  it("AC6: a shipped order is captured at Ready (Packed) for goods, service fee, postage and tax", async () => {
    setTaxCalculatorForTests(fakeTaxCalculator(RATES));
    const { store, cartId } = await seed();
    const { provider } = shippo();
    const quote = await quoteCheckout(store.id, 0, cartId, CONTACT, "ship", AR, { shipping: provider });
    const paymentIntentId = await payAndSave(store.id, cartId, quote.holdCents);
    const placed = await placeOrder(store.id, 0, cartId, CONTACT, "ship", null, null, paymentIntentId);

    const scoped = storeScoped(store.id);
    await scoped.order.update({ where: { id: placed.token }, data: { status: "PICKING", acceptedAt: new Date() } });
    await scoped.orderLine.updateMany({ where: { orderId: placed.token }, data: { status: "picked", qtyPicked: 2 } });
    setStripeProvider(fakeStripeProvider);
    setAuthorizedAmount(paymentIntentId, quote.holdCents);

    const result = await markReady(store.id, placed.token, { label: { provider, hasStorage: () => true, upload: async () => {} } });

    expect(result).toEqual({ ok: true, capturedAmountCents: quote.totalCents });
    expect(capturedPayments.get(paymentIntentId)).toBe(2400 + 99 + 1305 + 156);
    const order = await scoped.order.findUniqueOrThrow({ where: { id: placed.token } });
    expect(order).toMatchObject({ status: "READY", capturedAmountCents: quote.totalCents });
    // Postage passes through to the platform, which buys the label (#568): the store's card fee is on the goods only.
    expect(order.platformFeeCents).toBe(99 + Math.round(2400 * 0.029) + 30);
  });

  it("isolation: one store's quote never reads or writes another store's cart, and a store's shipping setting changes only that store", async () => {
    const a = await seed();
    const b = await seed();
    const { fetch, provider } = shippo();

    const crossed = await quoteCheckout(a.store.id, 0, b.cartId, CONTACT, "ship", AR, { shipping: provider });
    expect(crossed.shipping).toBeUndefined();
    expect(fetch.calls).toHaveLength(0);
    expect(await storeScoped(b.store.id).cart.findUniqueOrThrow({ where: { id: b.cartId }, select: { shippingFeeCents: true } })).toEqual({ shippingFeeCents: null });

    expect(await saveStoreShipping(a.store.id, 5, actor)).toEqual({ ok: true });
    expect(await saveStoreShipping(a.store.id, 11, actor)).toEqual({ ok: false, message: expect.stringMatching(/1 to 10/) });
    const rows = await platformAdmin.store.findMany({ where: { id: { in: [a.store.id, b.store.id] } }, select: { id: true, shippingHandlingDays: true } });
    expect(Object.fromEntries(rows.map((row) => [row.id, row.shippingHandlingDays]))).toEqual({ [a.store.id]: 5, [b.store.id]: 2 });
  });

  it("AC2: a listing is marked shippable only when not frozen, not perishable, not prepared food and every size has a real weight; a later disqualifying edit stops it shipping", async () => {
    const { store, listingId, variantId } = await seed({ shippable: false });
    const shippable = async () => (await storeScoped(store.id).listing.findUniqueOrThrow({ where: { id: listingId } })).shippable;

    await storeScoped(store.id).listingVariant.update({ where: { id: variantId }, data: { weightPlaceholder: true } });
    await expect(updateListing({ storeId: store.id, listingId, shippable: true, actor })).rejects.toThrow(/real weight/);
    await storeScoped(store.id).listingVariant.update({ where: { id: variantId }, data: { weightPlaceholder: false } });
    await expect(updateListing({ storeId: store.id, listingId, perishable: true, shippable: true, actor })).rejects.toThrow(/Perishable/);
    await expect(updateListing({ storeId: store.id, listingId, prepared: "cold", prepMinutes: 10, shippable: true, actor })).rejects.toThrow(/Prepared food/);
    expect(await shippable()).toBe(false);

    await updateListing({ storeId: store.id, listingId, perishable: false, shippable: true, actor });
    expect(await shippable()).toBe(true);
    await updateListing({ storeId: store.id, listingId, frozen: true, actor });
    expect(await shippable()).toBe(false);

    await updateListing({ storeId: store.id, listingId, frozen: false, shippable: true, actor });
    await updateListing({ storeId: store.id, listingId, prepared: "hot", prepMinutes: 10, actor });
    expect(await shippable()).toBe(false);
  });
});
