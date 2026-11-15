import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { authPrisma, isWhatsAppOptedOut, storeScoped, storeScopedTransaction } from "../db";
import { computeQuote, recordAuthorizedOrder } from "../checkout/service";
import { acceptOrder } from "../order/service";
import { setStripeProvider } from "../stripe/index";
import { fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests } from "../email/send";
import { clearTestSentSms, getTestSentSms, setSmsSenderForTests } from "./sms";
import { sendCustomerNotification } from "../inngest/functions";
import { makeFakeStep } from "../inngest/fake-step";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";
import { fakeWhatsAppProvider, getFakeOutbox, resetFake, revokeFakeTemplate } from "../whatsapp/fake";
import { WhatsAppApiError } from "../whatsapp/errors";
import { setWhatsAppProvider } from "../whatsapp/index";
import { linkStoreNumber } from "../whatsapp/store-number";
import { handleStoreInboundMessage } from "../whatsapp/store-inbound";
import type { Contact } from "../customer-flow/contracts";
import type { OrderNotifyEvent } from "./record";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada", phone: "(301) 448-2210", email: "ada@example.com" };
const WA_ID = "13014482210";
const KEY = randomBytes(32).toString("base64");
const base = Number(String(Date.now()).slice(-9));
const PHONE_A = String(1_100_000_000 + base);
const PHONE_B = String(2_100_000_000 + base);
const WABA_A = String(4_100_000_000 + base);
const WABA_B = String(5_100_000_000 + base);
const PRICE = 2000;

const handler = (sendCustomerNotification as unknown as {
  fn: (ctx: {
    event: { data: { storeId: string; orderId: string; event: OrderNotifyEvent } };
    step: ReturnType<typeof makeFakeStep>;
  }) => Promise<unknown>;
}).fn;

async function asPlatformAdmin(fn: (tx: typeof authPrisma) => Promise<unknown>): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await fn(tx as unknown as typeof authPrisma);
  });
}

let seq = 0;
function inbound(text: string, from = WA_ID) {
  return { id: `wamid.w560-${base}-${++seq}`, from, fromUserId: null, type: "text", text, timestamp: null, replyId: null };
}

describe.skipIf(!hasDb)("WhatsApp order updates (#560)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let plain = "";
  const stores: string[] = [];
  const actorId = `w560-${base}`;
  const actorEmail = `${actorId}@example.com`;

  beforeAll(async () => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", KEY);
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    setStripeProvider(fakeStripeProvider);
    setWhatsAppProvider(fakeWhatsAppProvider);
    await raw.user.create({ data: { id: actorId, name: "Owner", email: actorEmail } });
    const make = (slug: string, name: string) => raw.store.create({
      data: { slug: `${slug}-${base}`, name, themePreset: "palm-and-shea", timezone: "America/Chicago" },
    });
    storeA = (await make("w560a", "Ada's Market")).id;
    storeB = (await make("w560b", "Bola Market")).id;
    plain = (await make("w560p", "Plain Market")).id;
    stores.push(storeA, storeB, plain);
    for (const [storeId, wabaId, phoneNumberId] of [[storeA, WABA_A, PHONE_A], [storeB, WABA_B, PHONE_B]]) {
      expect(await linkStoreNumber({ storeId, actorId, actorEmail }, {
        wabaId, phoneNumberId, coexistence: true, displayNumber: "+1 404 555 0100",
      })).toEqual({ ok: true });
    }
    vi.unstubAllEnvs();
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", KEY);
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    setWhatsAppProvider(fakeWhatsAppProvider);
    resetFake();
    clearTestSentEmails();
    clearTestSentSms();
    setEmailSenderForTests(null);
    setSmsSenderForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setWhatsAppProvider(null);
  });

  afterAll(async () => {
    setStripeProvider(null);
    for (const id of stores) {
      const scoped = storeScoped(id);
      await scoped.notificationLog.deleteMany({});
      await scoped.whatsAppOptOut.deleteMany({});
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
    await asPlatformAdmin(async (tx) => {
      for (const id of stores) await tx.$executeRaw`DELETE FROM store_whatsapp_numbers WHERE store_id = ${id}`;
    });
    await raw.auditLog.deleteMany({ where: { storeId: { in: stores } } });
    await raw.store.deleteMany({ where: { id: { in: stores } } });
    await raw.user.deleteMany({ where: { id: actorId } });
    await raw.$disconnect();
  });

  async function place(storeId: string, whatsappUpdates: boolean, contact: Contact = CONTACT) {
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: "Egusi", price: PRICE, stockMode: "counted", qty: 20, frozen: false, perishable: false },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "bag", price: PRICE, weightG: 100 },
    });
    const paymentIntentId = `pi_w560_${crypto.randomUUID()}`;
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, paymentIntentId } });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const quote = computeQuote(0, [{ price: PRICE, qty: 1, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE, null);
    setAuthorizedAmount(paymentIntentId, quote.holdCents);
    const recorded = await recordAuthorizedOrder(storeId, {
      cartId: cart.id,
      contact,
      fulfillment: "pickup",
      pickupSlot: null,
      notes: null,
      paymentIntentId,
      quote,
      lines: [{ variantId: variant.id, qty: 1, price: PRICE, swapRule: "exact_only", substituteVariantId: null }],
      minimumOrderCents: 0,
      whatsappUpdates,
    });
    return storeScoped(storeId).order.findUniqueOrThrow({ where: { id: recorded.orderId } });
  }

  async function run(storeId: string, orderId: string, event: OrderNotifyEvent) {
    await handler({ event: { data: { storeId, orderId, event } }, step: makeFakeStep() });
  }

  async function rows(storeId: string, orderId: string, event: OrderNotifyEvent) {
    const found = await storeScoped(storeId).notificationLog.findMany({ where: { orderId, event } });
    return Object.fromEntries(found.map((row) => [row.channel, `${row.status}${row.reason ? `:${row.reason}` : ""}`]));
  }

  it("keeps the opt-in with its time only when the store has a registered number", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T15:00:00Z") });
    try {
      const opted = await place(storeA, true);
      expect(opted.whatsappOptInAt?.toISOString()).toBe("2026-11-14T15:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
    expect((await place(storeA, false)).whatsappOptInAt).toBeNull();
    // A forged tick for a store with no number is dropped.
    expect((await place(plain, true)).whatsappOptInAt).toBeNull();
  });

  it("an opted-in order hears from the store's own number instead of SMS, with the tracking link and no order id", async () => {
    const order = await place(storeA, true);
    expect(await rows(storeA, order.id, "placed")).toEqual({ email: "pending", sms: "pending", whatsapp: "pending" });
    await run(storeA, order.id, "placed");

    const outbox = getFakeOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].from).toBe(PHONE_A);
    const message = outbox[0].message;
    expect(message).toMatchObject({ type: "template", to: "+13014482210", name: "order_placed", language: "en_US" });
    expect(JSON.stringify(message)).toContain(`"order/${order.trackingToken}"`);
    expect(JSON.stringify(message)).toContain("Ada's Market");
    expect(JSON.stringify(message)).not.toContain(order.id);
    expect(JSON.stringify(message)).not.toContain(`#${order.number}`);
    expect(getTestSentSms()).toHaveLength(0);
    expect(getTestSentEmails()).toHaveLength(1);
    expect(await rows(storeA, order.id, "placed")).toEqual({ email: "sent", sms: "skipped:whatsapp_sent", whatsapp: "sent" });

    // A redelivered event sends nothing again.
    await run(storeA, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(1);
    expect(getTestSentSms()).toHaveLength(0);

    expect((await acceptOrder(storeA, order.id, 20)).ok).toBe(true);
    await run(storeA, order.id, "accepted");
    expect(getFakeOutbox().map((entry) => (entry.message as { name: string }).name)).toEqual(["order_placed", "order_accepted"]);
    expect(getTestSentSms()).toHaveLength(0);
  });

  it("a customer who did not opt in gets SMS as before, with no whatsapp row", async () => {
    const order = await place(storeA, false);
    expect(await rows(storeA, order.id, "placed")).toEqual({ email: "pending", sms: "pending" });
    await run(storeA, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(1);
  });

  it("a send failure falls back to SMS once for that event; email is unchanged", async () => {
    const order = await place(storeA, true);
    let calls = 0;
    setWhatsAppProvider({
      send: async () => {
        calls += 1;
        throw new WhatsAppApiError(131000, 500);
      },
      connectStoreNumber: fakeWhatsAppProvider.connectStoreNumber,
    });
    await run(storeA, order.id, "placed");
    await run(storeA, order.id, "placed");
    expect(calls).toBe(1);
    expect(getTestSentSms()).toHaveLength(1);
    expect(getTestSentSms()[0].text).toContain(order.trackingToken!);
    expect(getTestSentEmails()).toHaveLength(1);
    expect(await rows(storeA, order.id, "placed")).toEqual({ email: "sent", sms: "sent", whatsapp: "failed:whatsapp_131000" });
  });

  it("a template not approved falls back to SMS once", async () => {
    const order = await place(storeA, true);
    revokeFakeTemplate("order_placed");
    await run(storeA, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(1);
    expect(await rows(storeA, order.id, "placed")).toMatchObject({ sms: "sent", whatsapp: "failed:whatsapp_132001" });
  });

  it("a WhatsApp attempt that may have reached Meta is not repeated; SMS covers it", async () => {
    const order = await place(storeA, true);
    await storeScopedTransaction(storeA, (tx) => tx.notificationLog.updateMany({
      where: { orderId: order.id, event: "placed", channel: "whatsapp" },
      data: { status: "sending", attempts: 1 },
    }));
    await run(storeA, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(1);
    expect(await rows(storeA, order.id, "placed")).toMatchObject({ sms: "sent", whatsapp: "failed:outcome_unknown" });
  });

  it("a later step already sent by SMS supersedes an earlier one on WhatsApp, and the reverse", async () => {
    const order = await place(storeA, true);
    expect((await acceptOrder(storeA, order.id, 20)).ok).toBe(true);
    // A later step that went by SMS fallback.
    await storeScoped(storeA).notificationLog.create({
      data: { storeId: storeA, orderId: order.id, event: "completed", channel: "sms", status: "sent" },
    });
    await run(storeA, order.id, "accepted");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(0);
    expect(await rows(storeA, order.id, "accepted")).toMatchObject({ sms: "skipped:superseded", whatsapp: "skipped:superseded" });

    const other = await place(storeA, true);
    expect((await acceptOrder(storeA, other.id, 20)).ok).toBe(true);
    await storeScoped(storeA).notificationLog.create({
      data: { storeId: storeA, orderId: other.id, event: "completed", channel: "whatsapp", status: "sent" },
    });
    setWhatsAppProvider({
      send: async () => { throw new WhatsAppApiError(131000, 500); },
      connectStoreNumber: fakeWhatsAppProvider.connectStoreNumber,
    });
    await run(storeA, other.id, "accepted");
    expect(getTestSentSms()).toHaveLength(0);
    expect(await rows(storeA, other.id, "accepted")).toMatchObject({ sms: "skipped:superseded", whatsapp: "skipped:superseded" });
  });

  it("an inbound STOP opts that customer out at that store only", async () => {
    const order = await place(storeA, true);
    expect(await handleStoreInboundMessage(PHONE_A, inbound(" stop "))).toEqual({ kind: "customer", storeId: storeA });
    expect(await isWhatsAppOptedOut(storeA, WA_ID)).toBe(true);
    expect(await isWhatsAppOptedOut(storeB, WA_ID)).toBe(false);
    // A word that only contains STOP is not an opt-out.
    await handleStoreInboundMessage(PHONE_B, inbound("stop please"));
    expect(await isWhatsAppOptedOut(storeB, WA_ID)).toBe(false);

    await run(storeA, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(1);
    expect(await rows(storeA, order.id, "placed")).toMatchObject({ sms: "sent", whatsapp: "skipped:opted_out" });

    const atB = await place(storeB, true);
    await run(storeB, atB.id, "placed");
    expect(getFakeOutbox()).toHaveLength(1);
    expect(getFakeOutbox()[0].from).toBe(PHONE_B);
  });

  it("store B never reads or writes store A's opt-outs", async () => {
    await handleStoreInboundMessage(PHONE_A, inbound("STOP", "14045550177"));
    expect(await storeScoped(storeA).whatsAppOptOut.count({ where: { waId: "14045550177" } })).toBe(1);
    expect(await storeScoped(storeB).whatsAppOptOut.count({ where: { waId: "14045550177" } })).toBe(0);
    await expect(storeScoped(storeB).whatsAppOptOut.create({ data: { storeId: storeA, waId: "14045550188" } })).rejects.toThrow();
    expect(await storeScoped(storeB).whatsAppOptOut.deleteMany({ where: { storeId: storeA } })).toEqual({ count: 0 });
    expect(await isWhatsAppOptedOut(storeA, "14045550177")).toBe(true);
  });

  it("a store that disconnected its number falls back to SMS", async () => {
    const store = (await raw.store.create({
      data: { slug: `w560d-${base}`, name: "Dele Market", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    })).id;
    stores.push(store);
    const phone = String(3_100_000_000 + base);
    expect(await linkStoreNumber({ storeId: store, actorId, actorEmail }, {
      wabaId: String(6_100_000_000 + base), phoneNumberId: phone, coexistence: true, displayNumber: "+1 404 555 0101",
    })).toEqual({ ok: true });
    const order = await place(store, true);
    await asPlatformAdmin((tx) => tx.$executeRaw`UPDATE store_whatsapp_numbers SET status = 'disconnected', business_token = NULL WHERE store_id = ${store}`);
    await run(store, order.id, "placed");
    expect(getFakeOutbox()).toHaveLength(0);
    expect(getTestSentSms()).toHaveLength(1);
    expect(await rows(store, order.id, "placed")).toMatchObject({ whatsapp: "skipped:store_number_unavailable" });
  });
});
