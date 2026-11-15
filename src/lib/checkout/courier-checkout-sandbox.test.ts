import { afterAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform, platformAdminTransaction, storeScoped } from "../db";
import { writeGeocodeCache } from "../address/cache";
import { registerStoreCouriers } from "../delivery/courier-registration";
import { dispatchReadyOrder } from "../delivery/dispatch";
import { readCourierSettings } from "../delivery/courier-settings";
import { DoorDashDriveProvider } from "../delivery/doordash";
import { fakeDoorDash } from "../delivery/doordash-fake";
import { UberDirectProvider } from "../delivery/uber-direct";
import { getCheckoutPayments } from "../stripe/checkout-payments";
import { createPaymentIntent, placeOrder, quoteCheckout, saveDeliverySnapshot } from "./service";

const hasKeys = Boolean(process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET && process.env.UBER_DIRECT_CUSTOMER_ID);

// Opt-in (COURIER_CHECKOUT_SANDBOX=1 E2E_FAKE_STRIPE=1): registers a store with the real Uber Direct sandbox, takes a real
// quote at checkout, places the order on the Stripe test harness and books a real sandbox delivery at Ready, then cancels
// it. No DoorDash keys exist yet, so DoorDash runs on the fake, priced above Uber so Uber is the cheapest.
describe.skipIf(!hasKeys || !process.env.DATABASE_URL || process.env.COURIER_CHECKOUT_SANDBOX !== "1" || process.env.E2E_FAKE_STRIPE !== "1")(
  "courier checkout against the Uber Direct sandbox (#527)",
  () => {
    const raw = testPrismaClient();
    let storeId = "";

    afterAll(async () => {
      if (storeId) {
        const scoped = storeScoped(storeId);
        await scoped.deliveryEvent.deleteMany({});
        await scoped.delivery.deleteMany({});
        await scoped.orderLine.deleteMany({});
        await scoped.stockEvent.deleteMany({});
        await scoped.notificationLog.deleteMany({});
        await scoped.order.deleteMany({});
        await scoped.cartLine.deleteMany({});
        await scoped.cart.deleteMany({});
        await scoped.customer.deleteMany({});
        await scoped.listingVariant.deleteMany({});
        await scoped.listing.deleteMany({});
        await platformAdminTransaction((tx) => tx.storeSubscription.deleteMany({ where: { storeId } }));
        await raw.store.deleteMany({ where: { id: storeId } });
      }
      await raw.$disconnect();
    });

    it("quotes, places and dispatches a courier order through Uber Direct", async () => {
      const stamp = Date.now().toString(36);
      const store = await raw.store.create({
        data: {
          slug: `courier-checkout-sandbox-${stamp}`,
          name: `Courier Checkout Probe ${stamp}`,
          themePreset: "palm-and-shea",
          stripeAccountId: `acct_fake_t527_${stamp}`,
          stripeOnboardingStatus: "complete",
          pickupEnabled: true,
          addressLine1: "8121 Georgia Ave",
          city: "Silver Spring",
          state: "MD",
          zip: "20910",
          phone: "+13015550100",
          lat: 38.9907,
          lng: -77.0261,
          deliveryRadiusMi: 8,
        },
      });
      storeId = store.id;
      await platformAdminTransaction((tx) => tx.storeSubscription.create({ data: { storeId, plan: "pro", status: "active" } }));

      const keys = {
        DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
        DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
        DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
      };
      const fake = fakeDoorDash({ developerId: keys.DOORDASH_DEVELOPER_ID, keyId: keys.DOORDASH_KEY_ID, signingSecret: keys.DOORDASH_SIGNING_SECRET, now: () => new Date(), quoteFeeCents: 2500 });
      await registerStoreCouriers(storeId, { doordash: { env: keys, fetch: fake.fetch } });
      const registered = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
      expect(registered.uberLocationId).toMatch(/^[0-9a-f-]{36}$/);

      const listing = await storeScoped(storeId).listing.create({ data: { storeId, customName: "Goat meat", price: 6000, stockMode: "unlimited" } });
      const variant = await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label: "2 lb", price: 6000, weightG: 900 } });
      const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
      await storeScoped(storeId).cartLine.create({ data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" } });
      const address = { line1: "1100 WAYNE AVE", line2: null, city: "SILVER SPRING", state: "MD", zip: "20910", leaveAtDoor: false };
      const point = { lat: 38.9946, lng: -77.0247 };
      await writeGeocodeCache(address, { ...address, formattedAddress: "1100 WAYNE AVE, SILVER SPRING, MD, 20910", ...point });
      const contact = { name: "Sandbox Buyer", phone: "+13015550199", email: `sandbox-${stamp}@example.com` };
      const couriers = [new DoorDashDriveProvider({ env: keys, fetch: fake.fetch }), new UberDirectProvider()];

      const shown = await quoteCheckout(storeId, 0, cart.id, contact, "courier", address, { couriers });
      expect(shown.problems).toEqual([]);
      expect(shown.courierProvider).toBe("Uber Direct");
      let atPay = await quoteCheckout(storeId, 0, cart.id, contact, "courier", address, { couriers, recheckCourier: true });
      if (atPay.problems.some((p) => p.code === "quote-changed")) {
        atPay = await quoteCheckout(storeId, 0, cart.id, contact, "courier", address, { couriers, recheckCourier: true });
      }
      expect(atPay.problems).toEqual([]);

      const intent = await createPaymentIntent(storeId, cart.id, atPay.holdCents);
      await saveDeliverySnapshot(storeId, cart.id, { ...address, ...point });
      await getCheckoutPayments().confirmPaymentIntent(intent.paymentIntentId, { payment_method: "pm_card_visa" });
      const placed = await placeOrder(storeId, 0, cart.id, contact, "courier", null, null, intent.paymentIntentId);
      const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.token } });
      expect(order).toMatchObject({ fulfillment: "courier", deliveryFeeCents: atPay.courierFeeCents, totalAuthorizedCents: atPay.holdCents });

      await storeScoped(storeId).order.update({ where: { id: order.id }, data: { status: "READY" } });
      const dispatched = await dispatchReadyOrder(storeId, order.id, { providers: couriers, emit: async () => {}, settings: () => readCourierSettings() });
      const delivery = await storeScoped(storeId).delivery.findFirst({ where: { orderId: order.id } });
      console.log(JSON.stringify({
        event: "uber_direct_sandbox_courier_checkout",
        uberOrganization: Boolean(registered.uberLocationId),
        shownFeeCents: shown.courierFeeCents,
        payFeeCents: atPay.courierFeeCents,
        holdCents: atPay.holdCents,
        order: { fulfillment: order.fulfillment, deliveryFeeCents: order.deliveryFeeCents, totalCents: order.totalCents, totalAuthorizedCents: order.totalAuthorizedCents },
        dispatched,
        delivery: delivery && { provider: delivery.provider, externalId: delivery.externalId, quoteFeeCents: delivery.quoteFeeCents, status: delivery.status, trackingUrl: delivery.trackingUrl },
      }));
      expect(dispatched).toMatchObject({ ok: true, provider: "uber" });
      await new UberDirectProvider().cancel(delivery!.externalId);
    }, 60_000);
  },
);
