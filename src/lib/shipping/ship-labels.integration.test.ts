import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction, storeScoped } from "../db";
import { writeGeocodeCache } from "../address/cache";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { setStripeProvider } from "../stripe";
import { capturedFees, capturedPayments, fakeStripeProvider, refundedPayments, setAuthorizedAmount } from "../stripe/fake";
import { fakeTaxCalculator, setTaxCalculatorForTests } from "../tax/calculator";
import { cancelShipment, markReady } from "../order/service";
import { buyShippingLabel, LABEL_PDF_NOT_SAVED, SHIPMENT_SCANNED } from "./label";
import { platformFeeLedger } from "../admin/fee-ledger-query";
import { createPaymentIntent, placeOrder, quoteCheckout, saveDeliverySnapshot, type DeliveryRequest } from "../checkout/service";
import { ShippoProvider, signShippoWebhook } from "./shippo";
import { fakeShippo } from "./shippo-fake";
import type { LabelDeps } from "./label";

vi.mock("../inngest/send", () => ({ sendOrderAuthorized: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../inngest/notify", async (original) => ({ ...(await original<object>()), scheduleOrderNotification: vi.fn() }));
const member = vi.hoisted(() => ({ storeId: "" }));
vi.mock("@/lib/store-admin/session", () => ({ requireStoreMember: vi.fn(async () => ({ store: { id: member.storeId } })) }));
vi.mock("@/lib/r2", async (original) => ({
  ...(await original<object>()),
  streamShippingLabel: vi.fn(async () => ({ body: new Blob(["%PDF-1.4 label"]).stream(), contentType: "application/pdf" })),
}));

const { POST: shippoWebhook } = await import("@/app/api/webhooks/shippo/route");
const { GET: labelRoute } = await import("@/app/api/shipping-label/[orderId]/route");

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `t568-${Date.now().toString(36)}`;
const CONTACT = { name: "Ada Buyer", phone: "+15015550199", email: "ada@t568.test" };
// Oklahoma, so this file never shares an allowlisted state with ship-checkout's (which adds and removes AR).
const OK: DeliveryRequest = { line1: "200 N WALKER AVE", line2: null, city: "OKLAHOMA CITY", state: "OK", zip: "73102", leaveAtDoor: false };
const OK_POINT = { lat: 35.4688, lng: -97.5199 };
const ALLOWED = "OK";
const TOKEN = "shippo_test_t568";
const SECRET = "whsec_t568";
// 2 × 4 lb = 8 lb: the fake's USPS Ground Advantage is $5.45 + 8 × $0.95 = $13.05.
const POSTAGE = 1305;

describe.skipIf(!hasDb)("shipping labels, tracking and the Shipped state (#568, lane DB)", () => {
  const raw = testPrismaClient();
  const storeIds: string[] = [];
  const uploads = new Map<string, Uint8Array>();
  let staff = { id: "", email: `${RUN}-staff@t568.test` };

  /** A shipped order picked and waiting at Ready, quoted and paid through checkout with this fake. */
  async function pickedShipOrder(fake = fakeShippo({ token: TOKEN })) {
    const stamp = crypto.randomUUID().slice(0, 8);
    const store = await platformAdmin.store.create({
      data: {
        slug: `${RUN}-${stamp}`, name: "Ship Market", pickupEnabled: true, stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        addressLine1: "100 Main St", city: "Houston", state: "TX", zip: "77002", lat: 29.7604, lng: -95.3698, deliveryRadiusMi: 8,
        phone: "+17135550100", shippingHandlingDays: 2,
      },
    });
    storeIds.push(store.id);
    const scoped = storeScoped(store.id);
    const listing = await scoped.listing.create({ data: { storeId: store.id, customName: "Garri", price: 1200, stockMode: "unlimited", shippable: true } });
    const variant = await scoped.listingVariant.create({ data: { listingId: listing.id, label: "4 lb", price: 1200, weightG: 1814 } });
    const cart = await scoped.cart.create({ data: { storeId: store.id } });
    await scoped.cartLine.create({ data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 2, swapRule: "exact_only" } });
    const provider = new ShippoProvider({ apiKey: TOKEN, fetch: fake });
    const quote = await quoteCheckout(store.id, 0, cart.id, CONTACT, "ship", OK, { shipping: provider });
    expect(quote.shipping?.feeCents).toBe(POSTAGE);
    const pi = await createPaymentIntent(store.id, cart.id, quote.holdCents);
    await getCheckoutPayments().confirmPaymentIntent(pi.paymentIntentId, { payment_method: "pm_card_visa" });
    await saveDeliverySnapshot(store.id, cart.id, { ...OK, line2: null, ...OK_POINT });
    const placed = await placeOrder(store.id, 0, cart.id, CONTACT, "ship", null, null, pi.paymentIntentId);
    await scoped.order.update({ where: { id: placed.token }, data: { status: "PICKING", acceptedAt: new Date() } });
    await scoped.orderLine.updateMany({ where: { orderId: placed.token }, data: { status: "picked", qtyPicked: 2 } });
    setAuthorizedAmount(pi.paymentIntentId, quote.holdCents);
    const deps: LabelDeps = { provider, hasStorage: () => true, upload: async (key, body) => void uploads.set(key, body) };
    return { store, orderId: placed.token, paymentIntentId: pi.paymentIntentId, quote, fake, provider, deps, scoped };
  }

  async function readyShipOrder() {
    const order = await pickedShipOrder();
    const ready = await markReady(order.store.id, order.orderId, { label: order.deps });
    expect(ready).toEqual({ ok: true, capturedAmountCents: order.quote.totalCents });
    const row = await order.scoped.order.findUniqueOrThrow({ where: { id: order.orderId } });
    return { ...order, labelId: row.shippingLabelId as string };
  }

  /** A fake that quotes the parcel `riseCents` above the checkout rate. */
  function requoting(riseCents: number) {
    return new ShippoProvider({
      apiKey: TOKEN,
      fetch: fakeShippo({ token: TOKEN, services: [{ provider: "USPS", name: "Ground Advantage", baseCents: 545 + riseCents, perLbCents: 95, days: 5 }] }),
    });
  }

  let trackSeq = 0;
  function track(labelId: string, status: string, opts: { eventId?: string; secret?: string; signedAt?: Date } = {}) {
    const body = JSON.stringify({
      event: "track_updated",
      test: true,
      data: { transaction: labelId, tracking_number: "9400", carrier: "usps", tracking_status: { object_id: opts.eventId ?? `ts_${RUN}_${++trackSeq}`, status, substatus: null } },
    });
    return shippoWebhook(new Request("https://market.test/api/webhooks/shippo", {
      method: "POST",
      body,
      headers: { "shippo-auth-signature": signShippoWebhook(body, opts.secret ?? SECRET, opts.signedAt) },
    }) as never);
  }

  async function notices(storeId: string, orderId: string, event: string) {
    return storeScoped(storeId).notificationLog.count({ where: { orderId, event, channel: "email" } });
  }

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    vi.stubEnv("SHIPPO_WEBHOOK_SECRET", SECRET);
    resetFakeCheckoutPayments();
    staff = { ...staff, id: (await raw.user.create({ data: { id: crypto.randomUUID(), email: staff.email, name: "Staff", emailVerified: true } })).id };
    setStripeProvider(fakeStripeProvider);
    setTaxCalculatorForTests(fakeTaxCalculator({ OK: { rate: 0.065 }, TX: { rate: 0.0825 } }));
    await writeGeocodeCache(OK, { ...OK, formattedAddress: "200 N WALKER AVE, OKLAHOMA CITY, OK, 73102", ...OK_POINT });
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_append(array_remove(shipping_states, ${ALLOWED}), ${ALLOWED}) WHERE id = 'platform'`));
  });

  afterEach(() => uploads.clear());

  afterAll(async () => {
    vi.unstubAllEnvs();
    setTaxCalculatorForTests(null);
    setStripeProvider(null);
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_remove(shipping_states, ${ALLOWED}) WHERE id = 'platform'`));
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.refundRequest.deleteMany({});
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
    await raw.user.deleteMany({ where: { id: staff.id } });
    resetFakeCheckoutPayments();
    await raw.$disconnect();
  });

  it("AC1, AC2, AC5: Ready captures, buys the label on the locked rate, keeps the PDF privately, and passes the postage through to the ledger", async () => {
    const { store, orderId, paymentIntentId, quote, fake, scoped, labelId } = await readyShipOrder();

    const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "READY", shippingPostageCents: POSTAGE, shippingLabelStatus: "bought", shippingTrackingNumber: expect.stringMatching(/^9400/) });
    expect(fake.labels.get(labelId)?.rateId).toBe(order.shippingRateId);
    expect(uploads.get(order.shippingLabelKey as string)).toBeDefined();
    // Goods 2400, service fee 99, postage 1305, tax 156 the platform collects. The application fee now carries the
    // postage: service fee + the store's 2.9% + 30¢ on the goods only + the postage + the tax.
    expect(capturedPayments.get(paymentIntentId)).toBe(quote.totalCents);
    const storeCardFee = Math.round(2400 * 0.029) + 30;
    expect(order.platformFeeCents).toBe(99 + storeCardFee);
    expect(capturedFees.get(paymentIntentId)).toBe(99 + storeCardFee + POSTAGE + 156);

    const ledger = await platformFeeLedger(new Date().toISOString().slice(0, 7));
    const row = ledger.rows.find((r) => r.storeId === store.id && r.kind === "capture");
    // Postage passes through like a courier fee: the platform keeps the service fee less its 2.9% on fee and postage.
    expect(row).toMatchObject({ courierFeeCents: POSTAGE, applicationFeeCents: 99 + storeCardFee + POSTAGE + 156 });
    expect(row?.platformNetCents).toBe(99 - Math.round(99 * 0.029) - Math.round(POSTAGE * 0.029) - Math.round(156 * 0.029));
  });

  it("AC1: an expired rate is quoted again; the store absorbs up to $2, above that staff confirm the exact postage", async () => {
    for (const [rise, asks] of [[200, false], [201, true]] as const) {
      const { store, orderId, paymentIntentId, quote, deps, scoped } = await pickedShipOrder();
      await scoped.order.update({ where: { id: orderId }, data: { shippingRateExpiresAt: new Date(Date.now() - 1000) } });
      const label = { ...deps, provider: requoting(rise) };

      const first = await markReady(store.id, orderId, { label });
      if (!asks) {
        expect(first).toMatchObject({ ok: true, capturedAmountCents: quote.totalCents });
      } else {
        expect(first).toMatchObject({ ok: false, confirmPostageCents: POSTAGE + rise });
        expect((await scoped.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PICKING");
        expect(capturedPayments.has(paymentIntentId)).toBe(false);
        // Confirming a different amount than quoted asks again.
        expect(await markReady(store.id, orderId, { label, confirmPostageCents: POSTAGE + rise - 1 })).toMatchObject({ ok: false, confirmPostageCents: POSTAGE + rise });
        expect(await markReady(store.id, orderId, { label, confirmPostageCents: POSTAGE + rise })).toMatchObject({ ok: true, capturedAmountCents: quote.totalCents });
      }
      const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
      // The shopper still pays what checkout showed; the higher postage comes out of the store's part.
      expect(order).toMatchObject({ status: "READY", deliveryFeeCents: POSTAGE, shippingPostageCents: POSTAGE + rise, shippingLabelStatus: "bought" });
      expect(capturedPayments.get(paymentIntentId)).toBe(quote.totalCents);
      // The store's card fee is on its own part, which the rise made smaller.
      expect(capturedFees.get(paymentIntentId)).toBe(99 + Math.round((2400 - rise) * 0.029) + 30 + POSTAGE + rise + 156);
    }
  });

  it("AC3: verified tracking webhooks move Ready → Shipped → In transit → Delivered once each, one notification per step, never backwards", async () => {
    const { store, orderId, labelId, scoped } = await readyShipOrder();
    const status = async () => (await scoped.order.findUniqueOrThrow({ where: { id: orderId } })).status;

    expect((await track(labelId, "TRANSIT", { secret: "wrong" })).status).toBe(401);
    expect((await track(labelId, "TRANSIT", { signedAt: new Date(Date.now() - 10 * 60_000) })).status).toBe(401);
    expect((await track("txn_unknown", "TRANSIT")).status).toBe(404);
    expect(await status()).toBe("READY");

    expect((await track(labelId, "PRE_TRANSIT")).status).toBe(200);
    expect(await status()).toBe("READY");

    expect((await track(labelId, "TRANSIT", { eventId: `first-${RUN}` })).status).toBe(200);
    expect(await status()).toBe("SHIPPED");
    // Shippo retries the same status: nothing moves and no second message.
    expect(await (await track(labelId, "TRANSIT", { eventId: `first-${RUN}` })).json()).toEqual({ received: true, recorded: false });
    expect(await status()).toBe("SHIPPED");
    expect(await notices(store.id, orderId, "shipped")).toBe(1);

    await track(labelId, "TRANSIT");
    expect(await status()).toBe("IN_TRANSIT");
    await track(labelId, "TRANSIT");
    expect(await notices(store.id, orderId, "in_transit")).toBe(1);

    await track(labelId, "DELIVERED");
    await track(labelId, "TRANSIT");
    const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "DELIVERED", deliveredAt: expect.any(Date), shippedAt: expect.any(Date) });
    expect(await notices(store.id, orderId, "delivered")).toBe(1);
  });

  it("AC2 isolation: the label PDF opens for the store's members and is a 404 for another store", async () => {
    const a = await readyShipOrder();
    const b = await pickedShipOrder();
    const open = (storeId: string, orderId: string) => {
      member.storeId = storeId;
      return labelRoute(new Request("https://market.test"), { params: Promise.resolve({ orderId }) });
    };
    const mine = await open(a.store.id, a.orderId);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("application/pdf");
    expect((await open(b.store.id, a.orderId)).status).toBe(404);
    // An order without a bought label is a 404 too.
    expect((await open(b.store.id, b.orderId)).status).toBe(404);
  });

  it("AC4: cancelling before the first scan voids the label and refunds everything; after a scan it is refused and nothing changes", async () => {
    const before = await readyShipOrder();
    expect(await cancelShipment(before.store.id, before.orderId, staff, { provider: before.provider })).toEqual({ ok: true });
    const cancelled = await before.scoped.order.findUniqueOrThrow({ where: { id: before.orderId } });
    expect(cancelled).toMatchObject({ status: "CANCELLED", shippingLabelStatus: "voided" });
    expect(before.fake.labels.get(before.labelId)?.refunded).toBe(true);
    expect(refundedPayments.get(before.paymentIntentId)).toBe(before.quote.totalCents);

    // The carrier scanned it, but Shippo's webhook has not arrived: Shippo refuses the void.
    const scanned = await readyShipOrder();
    scanned.fake.scan(scanned.labelId);
    expect(await cancelShipment(scanned.store.id, scanned.orderId, staff, { provider: scanned.provider })).toEqual({ ok: false, error: SHIPMENT_SCANNED });
    expect(await scanned.scoped.order.findUniqueOrThrow({ where: { id: scanned.orderId } })).toMatchObject({ status: "READY", shippingLabelStatus: "bought" });
    expect(refundedPayments.has(scanned.paymentIntentId)).toBe(false);

    // Shipped: refused without asking Shippo.
    await track(scanned.labelId, "TRANSIT");
    const calls = scanned.fake.calls.length;
    expect(await cancelShipment(scanned.store.id, scanned.orderId, staff, { provider: scanned.provider })).toEqual({ ok: false, error: SHIPMENT_SCANNED });
    expect(scanned.fake.calls.length).toBe(calls);
  });
  it("B1: a label Shippo sold is kept when saving its PDF fails; a retry saves only the PDF and a cancel voids the label", async () => {
    for (const next of ["retry", "cancel"] as const) {
      const { store, orderId, paymentIntentId, quote, fake, deps, scoped } = await pickedShipOrder();
      const failing = { ...deps, upload: async () => { throw new Error("R2 PutObject 503"); } };

      // The capture stands and staff are told the PDF is missing, not that Ready failed.
      expect(await markReady(store.id, orderId, { label: failing })).toEqual({ ok: true, capturedAmountCents: quote.totalCents, labelError: LABEL_PDF_NOT_SAVED });
      const [labelId] = [...fake.labels.keys()];
      expect(await scoped.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
        status: "READY", shippingLabelStatus: "bought", shippingLabelId: labelId, shippingLabelKey: null, shippingTrackingNumber: expect.stringMatching(/^9400/),
      });

      if (next === "retry") {
        expect(await buyShippingLabel(store.id, orderId, deps)).toEqual({ ok: true });
        const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
        expect(order).toMatchObject({ shippingLabelStatus: "bought", shippingLabelId: labelId });
        expect(uploads.get(order.shippingLabelKey as string)).toBeDefined();
        // No second purchase.
        expect(fake.calls.filter((call) => "rate" in call && !("parcels" in call))).toHaveLength(1);
        expect(fake.labels.size).toBe(1);
      } else {
        expect(await cancelShipment(store.id, orderId, staff, { provider: deps.provider })).toEqual({ ok: true });
        expect(fake.labels.get(labelId)?.refunded).toBe(true);
        expect(refundedPayments.get(paymentIntentId)).toBe(quote.totalCents);
      }
    }
  });
  it("B1: a label Shippo sold whose answer was lost is found by its rate; a retry buys no second label and a cancel voids it", async () => {
    for (const next of ["retry", "cancel"] as const) {
      // Shippo sells the label, then the answer never arrives (the 30 s timeout).
      const inner = fakeShippo({ token: TOKEN });
      const lost = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        if (init?.method === "POST" && String(input).endsWith("/transactions/")) throw new DOMException("The operation timed out.", "TimeoutError");
        return res;
      }, inner);
      const { store, orderId, paymentIntentId, quote, fake, deps, scoped } = await pickedShipOrder(lost);

      expect(await markReady(store.id, orderId, { label: deps })).toEqual({ ok: true, capturedAmountCents: quote.totalCents });
      const [labelId] = [...fake.labels.keys()];
      const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({ status: "READY", shippingLabelStatus: "bought", shippingLabelId: labelId, shippingTrackingNumber: expect.stringMatching(/^9400/) });
      expect(uploads.get(order.shippingLabelKey as string)).toBeDefined();

      if (next === "retry") {
        expect(await buyShippingLabel(store.id, orderId, deps)).toEqual({ ok: true });
        expect(fake.labels.size).toBe(1);
      } else {
        expect(await cancelShipment(store.id, orderId, staff, { provider: deps.provider })).toEqual({ ok: true });
        expect(fake.labels.get(labelId)?.refunded).toBe(true);
        expect(refundedPayments.get(paymentIntentId)).toBe(quote.totalCents);
      }
    }
  });
  it("B1: a stale claim whose label was sold but never saved is taken again without buying a second label", async () => {
    const { store, orderId, fake, provider, deps, scoped } = await pickedShipOrder();
    await markReady(store.id, orderId, { label: { ...deps, provider: null } });
    // A label sold, then the "bought" write failed: the row is left "buying" with no label id.
    const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId } });
    const sold = await provider.buyLabel(order.shippingRateId as string, orderId);
    await scoped.order.update({ where: { id: orderId }, data: { shippingLabelStatus: "buying", shippingLabelClaimedAt: new Date(Date.now() - 6 * 60_000) } });

    expect(await buyShippingLabel(store.id, orderId, deps)).toEqual({ ok: true });
    expect(await scoped.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ shippingLabelStatus: "bought", shippingLabelId: sold.labelId });
    expect(fake.labels.size).toBe(1);
  });
});
