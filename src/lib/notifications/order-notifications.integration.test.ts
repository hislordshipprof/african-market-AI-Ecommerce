import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import { computeQuote, recordAuthorizedOrder } from "../checkout/service";
import { acceptOrder, autoCancelOrder, completePickup, markLinePicked, markReady } from "../order/service";
import { setStripeProvider } from "../stripe/index";
import { fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests, TestSender } from "../email/send";
import { clearTestSentSms, getTestSentSms, setSmsSenderForTests, SmsTestSender } from "../notifications/sms";
import { NOTIFICATION_CHANNEL_KINDS } from "./channel-kinds";
import { notificationChannels } from "./channels";
import { findOrderForTracking } from "../notifications/lookup";
import { ProviderSendError } from "../notifications/provider-error";
import { sendCustomerNotification } from "../inngest/functions";
import { makeFakeStep } from "../inngest/fake-step";
import { inngest } from "../inngest/client";
import type { Contact } from "../customer-flow/contracts";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada", phone: "(301) 448-2210", email: "ada@example.com" };
const PRICE = 2000;
const RICE = 500;

type NotifyEvent = "placed" | "accepted" | "ready" | "completed" | "cancelled";

const handler = (sendCustomerNotification as unknown as {
  fn: (ctx: {
    event: { data: { storeId: string; orderId: string; event: NotifyEvent } };
    step: ReturnType<typeof makeFakeStep>;
  }) => Promise<unknown>;
}).fn;

describe.skipIf(!hasDb)("customer notifications", () => {
  let storeId = "";
  let otherStoreId = "";
  const createdStores: string[] = [];
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    setStripeProvider(fakeStripeProvider);
    const stamp = Date.now().toString(36);
    const store = await raw.store.create({
      data: {
        slug: `n128-${stamp}`,
        name: "Ada's Market",
        themePreset: "palm-and-shea",
        brandColor: "#1F5A43",
        logoUrl: "https://cdn.example.com/logo.png",
        timezone: "America/Chicago",
      },
    });
    const other = await raw.store.create({
      data: { slug: `n128b-${stamp}`, name: "Other Market", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    });
    storeId = store.id;
    otherStoreId = other.id;
    createdStores.push(store.id, other.id);
  });

  beforeEach(() => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    clearTestSentEmails();
    clearTestSentSms();
    setEmailSenderForTests(null);
    setSmsSenderForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setEmailSenderForTests(null);
    setSmsSenderForTests(null);
  });

  afterAll(async () => {
    setStripeProvider(null);
    for (const id of createdStores) {
      const scoped = storeScoped(id);
      await scoped.notificationLog.deleteMany({});
      await scoped.auditLog.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.cartLine.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    if (createdStores.length > 0) {
      await raw.auditLog.deleteMany({ where: { storeId: { in: createdStores } } });
      await raw.paymentIntentRelease.deleteMany({ where: { storeId: { in: createdStores } } });
      await raw.store.deleteMany({ where: { id: { in: createdStores } } });
    }
    await raw.$disconnect();
  });

  async function place(fulfillment: "pickup" | "store-delivery") {
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: "Egusi", price: PRICE, stockMode: "counted", qty: 20, frozen: false, perishable: false },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "bag", price: PRICE, weightG: 100 },
    });
    const rice = await storeScoped(storeId).listing.create({
      data: { storeId, customName: "Rice", price: RICE, stockMode: "counted", qty: 20, frozen: false, perishable: false },
    });
    const riceVariant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: rice.id, label: "bag", price: RICE, weightG: 100 },
    });
    const paymentIntentId = `pi_n128_${crypto.randomUUID()}`;
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, paymentIntentId } });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: riceVariant.id, qty: 1, swapRule: "exact_only" },
    });
    const quote = computeQuote(0, [
      { price: PRICE, qty: 1, maxPerOrder: null },
      { price: RICE, qty: 1, maxPerOrder: null },
    ], CONTACT, fulfillment);
    setAuthorizedAmount(paymentIntentId, quote.holdCents);
    const recorded = await recordAuthorizedOrder(storeId, {
      cartId: cart.id,
      contact: CONTACT,
      fulfillment,
      pickupSlot: null,
      notes: null,
      paymentIntentId,
      quote,
      lines: [
        { variantId: variant.id, qty: 1, price: PRICE, swapRule: "exact_only", substituteVariantId: null },
        { variantId: riceVariant.id, qty: 1, price: RICE, swapRule: "exact_only", substituteVariantId: null },
      ],
      minimumOrderCents: 0,
    });
    return recorded.orderId;
  }

  async function run(orderId: string, event: NotifyEvent, attempts = 1) {
    const pending = await storeScoped(storeId).notificationLog.findMany({
      where: { orderId, event, status: "pending" },
    });
    expect(pending.map((row) => row.channel).sort()).toEqual([...NOTIFICATION_CHANNEL_KINDS].sort());
    await handler({
      event: { data: { storeId, orderId, event } },
      step: makeFakeStep({ attempts }),
    });
  }

  it("a pickup order sends one branded email and one SMS at placed, accepted, ready and completed, and a timed-out order sends one cancelled message", async () => {
    const orderId = await place("pickup");
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await findOrderForTracking(storeId, order.trackingToken!))?.id).toBe(orderId);
    expect(await findOrderForTracking(otherStoreId, order.trackingToken!)).toBeNull();
    expect((await findOrderForTracking(storeId, orderId))?.id).toBe(orderId);

    await run(orderId, "placed");
    const placedMail = getTestSentEmails().at(-1)!;
    const placedSms = getTestSentSms().at(-1)!;
    expect(placedMail.to).toBe("ada@example.com");
    expect(placedMail.from).toContain("Ada's Market");
    expect(placedMail.html).toContain("Ada&#39;s Market");
    expect(placedMail.html).toContain("https://cdn.example.com/logo.png");
    expect(placedMail.html).toContain("#1F5A43");
    expect(placedMail.html).toContain("Powered by the Platform");
    expect(placedMail.html).toContain(String(order.number));
    expect(placedMail.html).toContain("$20.00");
    expect(placedMail.html).toContain("$5.00");
    expect(placedMail.html).toContain("Estimated total $25.00");
    expect(placedMail.html).toContain("Card hold $27.50");
    expect(notificationChannels.map((channel) => channel.kind)).toEqual([...NOTIFICATION_CHANNEL_KINDS]);
    expect(placedMail.html).toContain(order.trackingToken!);
    expect(placedSms.to).toBe("+13014482210");
    expect(placedSms.text).toContain("Ada's Market");
    expect(placedSms.text).toContain("Reply STOP to opt out.");
    expect(getTestSentEmails()).toHaveLength(1);
    expect(getTestSentSms()).toHaveLength(1);

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T18:50:00-06:00") });
    try {
      expect((await acceptOrder(storeId, orderId, 20)).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    clearTestSentEmails();
    clearTestSentSms();
    await run(orderId, "accepted");
    expect(getTestSentEmails().at(-1)!.html).toContain("7:10 PM");
    expect(getTestSentSms()).toHaveLength(1);
    expect(getTestSentSms().at(-1)!.text).not.toContain("STOP");

    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId } });
    for (const line of lines) expect((await markLinePicked(storeId, line.id)).ok).toBe(true);
    expect((await markReady(storeId, orderId)).ok).toBe(true);
    clearTestSentEmails();
    clearTestSentSms();
    await run(orderId, "ready");
    expect(getTestSentEmails().at(-1)!.html).toContain("Ready for pickup");
    expect(getTestSentEmails().at(-1)!.html).toContain("Charged $25.00");

    expect((await completePickup(storeId, orderId)).ok).toBe(true);
    clearTestSentEmails();
    clearTestSentSms();
    await run(orderId, "completed");
    expect(getTestSentEmails().at(-1)!.html).toContain("Completed");
    expect(getTestSentEmails()).toHaveLength(1);
    expect(getTestSentSms()).toHaveLength(1);

    const deliveryId = await place("store-delivery");
    await acceptOrder(storeId, deliveryId, 20);
    const deliveryLines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: deliveryId } });
    for (const line of deliveryLines) await markLinePicked(storeId, line.id);
    expect((await markReady(storeId, deliveryId)).ok).toBe(true);
    clearTestSentEmails();
    clearTestSentSms();
    await run(deliveryId, "ready");
    expect(getTestSentEmails().at(-1)!.html).toContain("Packed and ready");

    const cancelledId = await place("pickup");
    expect((await autoCancelOrder(storeId, cancelledId)).ok).toBe(true);
    clearTestSentEmails();
    clearTestSentSms();
    await run(cancelledId, "cancelled");
    const cancelled = getTestSentEmails().at(-1)!.html;
    expect(cancelled).toContain("You were not charged");
    expect(cancelled).not.toMatch(/\$\d/);
    expect(getTestSentSms()).toHaveLength(1);
  });

  it("a duplicate event and a lost provider response still send each message once", async () => {
    const orderId = await place("pickup");
    await run(orderId, "placed");
    await handler({ event: { data: { storeId, orderId, event: "placed" } }, step: makeFakeStep() });
    expect(getTestSentEmails()).toHaveLength(1);
    expect(getTestSentSms()).toHaveLength(1);

    clearTestSentEmails();
    clearTestSentSms();
    const again = await place("pickup");
    const emailSink = new TestSender();
    const smsSink = new SmsTestSender();
    const emailKeys: string[] = [];
    const smsKeys: string[] = [];
    let emailThrew = false;
    let smsThrew = false;
    setEmailSenderForTests({
      async send(message) {
        emailKeys.push(message.idempotencyKey ?? "");
        const result = await emailSink.send(message);
        if (!emailThrew) {
          emailThrew = true;
          throw new Error("lost_response");
        }
        return result;
      },
    });
    setSmsSenderForTests({
      async send(message, options) {
        smsKeys.push(options.idempotencyKey);
        const result = await smsSink.send(message, options);
        if (!smsThrew) {
          smsThrew = true;
          throw new Error("lost_response");
        }
        return result;
      },
    });
    await run(again, "placed", 5);
    expect(emailKeys).toEqual([emailKeys[0], emailKeys[0]]);
    expect(smsKeys).toEqual([smsKeys[0], smsKeys[0]]);
    expect(emailKeys[0]).toMatch(/^notif_[A-Za-z0-9_-]+$/);
    const rows = await storeScoped(storeId).notificationLog.findMany({ where: { orderId: again, event: "placed" } });
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "sent"]);
    expect(getTestSentEmails()).toHaveLength(1);
    expect(getTestSentSms()).toHaveLength(1);
  });

  it("each writer schedules `order-notify-<event>-<orderId>` after its rows are committed", async () => {
    const previous = process.env.INNGEST_EVENT_KEY;
    process.env.INNGEST_EVENT_KEY = "test-key";
    const seen: string[] = [];
    const send = vi.spyOn(inngest, "send").mockImplementation((payload) => {
      const event = (Array.isArray(payload) ? payload[0] : payload) as {
        id?: string;
        data?: { orderId?: string; event?: string };
      };
      const pending = (async () => {
        const rows = await storeScoped(storeId).notificationLog.findMany({
          where: { orderId: event.data?.orderId, event: event.data?.event as NotifyEvent },
        });
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "pending")).toBe(true);
        expect(event.id).toBe(`order-notify-${event.data?.event}-${event.data?.orderId}`);
        seen.push(event.data?.event ?? "");
      })();
      return pending.then(() => ({ ids: [event.id ?? ""] }));
    });
    try {
      const orderId = await place("pickup");
      await vi.waitFor(() => expect(seen).toContain("placed"));
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T18:50:00-06:00") });
      try {
        await acceptOrder(storeId, orderId, 20);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(seen).toContain("accepted"));
      const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId } });
      for (const line of lines) await markLinePicked(storeId, line.id);
      await markReady(storeId, orderId);
      await vi.waitFor(() => expect(seen).toContain("ready"));
      await completePickup(storeId, orderId);
      await vi.waitFor(() => expect(seen).toContain("completed"));
      const cancelledId = await place("pickup");
      await vi.waitFor(() => expect(seen.filter((event) => event === "placed").length).toBeGreaterThan(1));
      await autoCancelOrder(storeId, cancelledId);
      await vi.waitFor(() => expect(seen).toContain("cancelled"));
    } finally {
      send.mockRestore();
      if (previous == null) delete process.env.INNGEST_EVENT_KEY;
      else process.env.INNGEST_EVENT_KEY = previous;
    }
  });

  it("an email the provider rejects, or that runs out of retries, still sends the SMS", async () => {
    setEmailSenderForTests({
      async send() {
        throw new ProviderSendError(422, "validation_error");
      },
    });
    const rejected = await place("pickup");
    await run(rejected, "placed");
    const rejectedRows = await storeScoped(storeId).notificationLog.findMany({ where: { orderId: rejected, event: "placed" } });
    const emailRow = rejectedRows.find((row) => row.channel === "email");
    const smsRow = rejectedRows.find((row) => row.channel === "sms");
    expect(emailRow?.status).toBe("failed");
    expect(emailRow?.reason).toBe("validation_error");
    expect(smsRow?.status).toBe("sent");
    expect(getTestSentSms()).toHaveLength(1);

    clearTestSentSms();
    setEmailSenderForTests({
      async send() {
        throw new ProviderSendError(503, "resend_503");
      },
    });
    const exhausted = await place("pickup");
    await run(exhausted, "placed", 5);
    const exhaustedEmail = await storeScoped(storeId).notificationLog.findFirst({
      where: { orderId: exhausted, event: "placed", channel: "email" },
    });
    expect(exhaustedEmail?.status).toBe("failed");
    expect(exhaustedEmail?.reason).toBe("retries_exhausted");
    expect(getTestSentSms()).toHaveLength(1);
  });
});
