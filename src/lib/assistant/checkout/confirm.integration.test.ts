import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storeScoped } from "../../db";
import { customerCancelOrder, getStoreOrders } from "../../order/service";
import { fakeCheckoutIntentCount, fakeLastCancelKey, failNextFakePaymentCancel, getCheckoutPayments, markFakeIntentAuthenticationFailed, resetFakeCheckoutPayments } from "../../stripe/checkout-payments";
import { createPaymentIntent, placeOrder } from "../../checkout/service";
import { checkoutTestHooks } from "../../checkout/test-hooks";
import { confirmCheckout, mintCheckoutToken } from "./confirm";
import { prepareCheckout, saveGuestContact, setFulfillment } from "./prepare";
import { offerPickupSlots } from "./slots";

const hasDb = !!process.env.DATABASE_URL;

function openNow(): Date {
  return new Date("2026-11-02T15:00:00.000Z");
}

describe.skipIf(!hasDb)("assistant confirm", () => {
  let raw: PrismaClient;
  let storeId = "";
  let cartId = "";
  let conversationId = "";

  beforeAll(async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T15:00:00.000Z"), toFake: ["Date"] });
    process.env.E2E_FAKE_STRIPE = "1";
    process.env.ASSISTANT_CHAT_ENABLED = "1";
    delete process.env.VERCEL;
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const store = await raw.store.create({
      data: {
        slug: `ai-pay-${suffix}`,
        name: "Pay Store",
        themePreset: "palm-and-shea",
        status: "active",
        minimumOrderCents: 0,
        pickupEnabled: true,
        prepTimeMinutes: 0,
        timezone: "America/New_York",
        hours: {
          sun: { open: "08:00", close: "22:00" },
          mon: { open: "08:00", close: "22:00" },
          tue: { open: "08:00", close: "22:00" },
          wed: { open: "08:00", close: "22:00" },
          thu: { open: "08:00", close: "22:00" },
          fri: { open: "08:00", close: "22:00" },
          sat: { open: "08:00", close: "22:00" },
        },
        stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_test_${suffix}`,
      },
    });
    storeId = store.id;
    cartId = (await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } })).id;
    conversationId = (await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId, model: "claude-haiku-5-5", messages: [] },
    })).id;
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Egusi",
        price: 800,
        stockMode: "unlimited",
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 800, weightG: 100 },
    });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId, variantId: variant.id, qty: 1 },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (!storeId) return;
    await storeScoped(storeId).orderLine.deleteMany({});
    await storeScoped(storeId).auditLog.deleteMany({});
    await storeScoped(storeId).order.deleteMany({});
    await storeScoped(storeId).customer.deleteMany({});
    await storeScoped(storeId).assistantCheckoutToken.deleteMany({});
    await storeScoped(storeId).assistantCheckoutAttempt.deleteMany({});
    await storeScoped(storeId).assistantCheckoutDraft.deleteMany({});
    await storeScoped(storeId).cartLine.deleteMany({});
    await storeScoped(storeId).aiAction.deleteMany({});
    await storeScoped(storeId).aiConversation.deleteMany({});
    await storeScoped(storeId).cart.deleteMany({});
    await storeScoped(storeId).listingVariant.deleteMany({});
    await storeScoped(storeId).listing.deleteMany({});
    await raw.auditLog.deleteMany({ where: { storeId } });
    await raw.store.delete({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("concurrent and repeated confirms of one token place one order and one hold", async () => {
    const now = openNow();
    const offer = offerPickupSlots({
      now,
      timeZone: "America/New_York",
      hours: { fri: { open: "08:00", close: "22:00" }, sun: { open: "08:00", close: "22:00" }, mon: { open: "08:00", close: "22:00" }, tue: { open: "08:00", close: "22:00" }, wed: { open: "08:00", close: "22:00" }, thu: { open: "08:00", close: "22:00" }, sat: { open: "08:00", close: "22:00" } },
      prepMinutes: 0,
      windowMinutes: 10,
      pickupEnabled: true,
    });
    const slot = offer.slots.find((item) => item.id !== "asap");
    expect(slot).toBeTruthy();
    const ctx = { storeId, cartId, conversationId, actorUserId: null, now };
    await saveGuestContact(ctx, { name: "Ada Okonkwo", email: "ada@example.com", phone: "2025550147" });
    const saved = await setFulfillment(ctx, slot!.id);
    expect(saved.ok).toBe(true);
    const prepared = await prepareCheckout(ctx);
    expect(prepared.kind).toBe("confirm");
    const minted = await mintCheckoutToken({ storeId, cartId, actorUserId: null, conversationId });
    expect(minted?.token).toBeTruthy();
    const reserved = await confirmCheckout({ ...ctx, token: minted!.token, phase: "reserve" });
    expect(reserved.ok, JSON.stringify(reserved)).toBe(true);
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error("expected a client secret");
    const again = await confirmCheckout({ ...ctx, token: minted!.token, phase: "reserve" });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok || again.kind !== "client_secret") throw new Error("a second reserve returns the same client secret");
    expect(again.paymentIntentId).toBe(reserved.paymentIntentId);
    expect(again.clientSecret).toBe(reserved.clientSecret);
    await getCheckoutPayments().confirmPaymentIntent(reserved.paymentIntentId, { payment_method: "pm_card_visa" });
    const [first, second] = await Promise.all([
      confirmCheckout({ ...ctx, token: minted!.token, phase: "complete" }),
      confirmCheckout({ ...ctx, token: minted!.token, phase: "complete" }),
    ]);
    expect(first.ok && first.kind === "order" && second.ok && second.kind === "order" && first.orderId === second.orderId).toBe(true);
    const orders = await storeScoped(storeId).order.findMany({ where: { sourceCartId: cartId } });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.cancellableUntil).toBeTruthy();
    const attempts = await storeScoped(storeId).assistantCheckoutAttempt.findMany({ where: { cartId, paymentIntentId: { not: null } } });
    expect(new Set(attempts.map((attempt) => attempt.paymentIntentId)).size).toBe(1);
    const cancelled = await customerCancelOrder({
      storeId,
      orderId: orders[0]!.id,
      cartId,
      actorUserId: null,
      actorEmail: "guest@checkout",
    });
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    const after = await storeScoped(storeId).order.findUnique({ where: { id: orders[0]!.id } });
    expect(after?.status).toBe("CANCELLED");
  });

  it("a price change retires the hold, and placing without the attempt id still keeps the cancel window", async () => {
    const now = openNow();
    const hours = {
      sun: { open: "08:00", close: "22:00" },
      mon: { open: "08:00", close: "22:00" },
      tue: { open: "08:00", close: "22:00" },
      wed: { open: "08:00", close: "22:00" },
      thu: { open: "08:00", close: "22:00" },
      fri: { open: "08:00", close: "22:00" },
      sat: { open: "08:00", close: "22:00" },
    };
    const slot = offerPickupSlots({
      now,
      timeZone: "America/New_York",
      hours,
      prepMinutes: 0,
      windowMinutes: 10,
      pickupEnabled: true,
    }).slots.find((item) => item.id !== "asap");
    expect(slot).toBeTruthy();
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const conversation = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Stocked rice",
        price: 900,
        stockMode: "counted",
        qty: 4,
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Bag", price: 900, weightG: 100 },
    });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1 },
    });
    const ctx = { storeId, cartId: cart.id, conversationId: conversation.id, actorUserId: null, now };
    await saveGuestContact(ctx, { name: "Ada Okonkwo", email: "ada@example.com", phone: "2025550147" });
    expect((await setFulfillment(ctx, slot!.id)).ok).toBe(true);
    expect((await prepareCheckout(ctx)).kind).toBe("confirm");
    await storeScoped(storeId).listing.update({ where: { id: listing.id }, data: { qty: 3 } });
    const stockMint = await mintCheckoutToken({ storeId, cartId: cart.id, actorUserId: null, conversationId: conversation.id });
    const stockReserve = await confirmCheckout({ ...ctx, token: stockMint!.token, phase: "reserve" });
    expect(stockReserve.ok).toBe(false);
    if (stockReserve.ok) throw new Error("stock change");
    expect(stockReserve.code).toBe("stale");
    const attempts = await storeScoped(storeId).assistantCheckoutAttempt.findMany({ where: { cartId: cart.id } });
    expect(attempts.every((attempt) => !attempt.paymentIntentId)).toBe(true);

    const fresh = await prepareCheckout(ctx);
    expect(fresh.kind).toBe("confirm");
    const minted = await mintCheckoutToken({
      storeId,
      cartId: cart.id,
      actorUserId: null,
      conversationId: conversation.id,
      attemptId: fresh.attemptId,
    });
    const reserved = await confirmCheckout({ ...ctx, token: minted!.token, phase: "reserve" });
    expect(reserved.ok, JSON.stringify(reserved)).toBe(true);
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error("expected a client secret");
    await storeScoped(storeId).listingVariant.update({ where: { id: variant.id }, data: { price: 1100 } });
    await getCheckoutPayments().confirmPaymentIntent(reserved.paymentIntentId, { payment_method: "pm_card_visa" });
    const changed = await confirmCheckout({ ...ctx, token: minted!.token, phase: "complete" });
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error("price change");
    expect(changed.code).toBe("basket_changed");
    const retired = await storeScoped(storeId).assistantCheckoutAttempt.findFirst({ where: { id: fresh.attemptId } });
    expect(retired?.status).toBe("superseded");
    const replacement = await prepareCheckout(ctx);
    expect(replacement.kind).toBe("confirm");
    expect(replacement.attemptId).not.toBe(fresh.attemptId);

    await storeScoped(storeId).listingVariant.update({ where: { id: variant.id }, data: { price: 900 } });
    const rebound = await prepareCheckout(ctx);
    const reboundMint = await mintCheckoutToken({
      storeId,
      cartId: cart.id,
      actorUserId: null,
      conversationId: conversation.id,
      attemptId: rebound.attemptId,
    });
    const reboundReserve = await confirmCheckout({ ...ctx, token: reboundMint!.token, phase: "reserve" });
    if (!reboundReserve.ok || reboundReserve.kind !== "client_secret") throw new Error(JSON.stringify(reboundReserve));
    await getCheckoutPayments().confirmPaymentIntent(reboundReserve.paymentIntentId, { payment_method: "pm_card_visa" });
    const placed = await placeOrder(
      storeId,
      0,
      cart.id,
      { name: "Ada Okonkwo", email: "ada@example.com", phone: "2025550147" },
      "pickup",
      null,
      slot!.id,
      reboundReserve.paymentIntentId,
      null,
    );
    const order = await storeScoped(storeId).order.findFirst({ where: { sourceCartId: cart.id } });
    expect(order?.cancellableUntil).toBeTruthy();
    expect(placed.token).toBeTruthy();
    const supersededMint = await mintCheckoutToken({
      storeId,
      cartId: cart.id,
      actorUserId: null,
      conversationId: conversation.id,
      attemptId: fresh.attemptId,
    });
    expect(supersededMint).toBeNull();
    const hidden = await getStoreOrders(storeId);
    expect(hidden.some((row) => row.id === order?.id)).toBe(false);
  });

  it("overlapping reserves create one provider hold, and a bad phone or a new contact never starts one", async () => {
    const now = openNow();
    const hours = {
      sun: { open: "08:00", close: "22:00" },
      mon: { open: "08:00", close: "22:00" },
      tue: { open: "08:00", close: "22:00" },
      wed: { open: "08:00", close: "22:00" },
      thu: { open: "08:00", close: "22:00" },
      fri: { open: "08:00", close: "22:00" },
      sat: { open: "08:00", close: "22:00" },
    };
    const slot = offerPickupSlots({
      now, timeZone: "America/New_York", hours, prepMinutes: 0, windowMinutes: 10, pickupEnabled: true,
    }).slots.find((item) => item.id !== "asap");
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const conversation = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId, customName: "Concurrent rice", price: 800, stockMode: "unlimited", confidence: 1, active: true, frozen: false, perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Bag", price: 800, weightG: 100 },
    });
    await storeScoped(storeId).cartLine.create({ data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1 } });
    const ctx = { storeId, cartId: cart.id, conversationId: conversation.id, actorUserId: null, now };
    const badPhone = await saveGuestContact(ctx, { name: "Ada Okonkwo", email: "ada@example.com", phone: "1234567" });
    expect(badPhone.ok).toBe(false);
    await saveGuestContact(ctx, { name: "Ada Okonkwo", email: "ada@example.com", phone: "2025550147" });
    expect((await setFulfillment(ctx, slot!.id)).ok).toBe(true);
    const prepared = await prepareCheckout(ctx);
    expect(prepared.kind).toBe("confirm");
    await saveGuestContact(ctx, { name: "Other Person", email: "ada@example.com", phone: "2025550199" });
    const staleMint = await mintCheckoutToken({
      storeId, cartId: cart.id, actorUserId: null, conversationId: conversation.id, attemptId: prepared.attemptId,
    });
    resetFakeCheckoutPayments();
    const before = fakeCheckoutIntentCount();
    const stale = await confirmCheckout({ ...ctx, token: staleMint!.token, phase: "reserve" });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("contact change");
    expect(stale.code).toBe("stale");
    expect(fakeCheckoutIntentCount()).toBe(before);
    await saveGuestContact(ctx, { name: "Ada Okonkwo", email: "ada@example.com", phone: "2025550147" });
    const fresh = await prepareCheckout(ctx);
    const minted = await mintCheckoutToken({
      storeId, cartId: cart.id, actorUserId: null, conversationId: conversation.id, attemptId: fresh.attemptId,
    });
    const started = fakeCheckoutIntentCount();
    const [first, second] = await Promise.all([
      confirmCheckout({ ...ctx, token: minted!.token, phase: "reserve" }),
      confirmCheckout({ ...ctx, token: minted!.token, phase: "reserve" }),
    ]);
    expect(fakeCheckoutIntentCount()).toBe(started + 1);
    expect(first.ok && second.ok, JSON.stringify({ first, second })).toBe(true);
    if (!first.ok || first.kind !== "client_secret" || !second.ok || second.kind !== "client_secret") {
      throw new Error(JSON.stringify({ first, second }));
    }
    expect(first.paymentIntentId).toBe(second.paymentIntentId);
  });

  const hours = {
    sun: { open: "08:00", close: "22:00" },
    mon: { open: "08:00", close: "22:00" },
    tue: { open: "08:00", close: "22:00" },
    wed: { open: "08:00", close: "22:00" },
    thu: { open: "08:00", close: "22:00" },
    fri: { open: "08:00", close: "22:00" },
    sat: { open: "08:00", close: "22:00" },
  };
  const fixedNow = openNow();

  async function basket(name: string) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const conversation = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 800, stockMode: "unlimited", confidence: 1, active: true, frozen: false, perishable: false },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 800, weightG: 100 },
    });
    await storeScoped(storeId).cartLine.create({ data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1 } });
    const ctx = { storeId, cartId: cart.id, conversationId: conversation.id, actorUserId: null, now: fixedNow };
    const slot = offerPickupSlots({ now: fixedNow, timeZone: "America/New_York", hours, prepMinutes: 0, windowMinutes: 10, pickupEnabled: true }).slots.find((item) => item.id !== "asap");
    if (!slot) throw new Error("no slot");
    await saveGuestContact(ctx, { name: "Ada Frozen", email: "ada@example.com", phone: "2025550147" });
    expect((await setFulfillment(ctx, slot.id)).ok).toBe(true);
    const prepared = await prepareCheckout(ctx);
    if (!prepared.ok || !prepared.attemptId) throw new Error(JSON.stringify(prepared));
    const minted = await mintCheckoutToken({ storeId, cartId: cart.id, actorUserId: null, conversationId: conversation.id, attemptId: prepared.attemptId });
    if (!minted) throw new Error("mint");
    return { cart, conversation, ctx, prepared, minted, slot };
  }

  it("a closed authentication challenge releases that PaymentIntent", async () => {
    const { ctx, minted } = await basket("Closed challenge");
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    markFakeIntentAuthenticationFailed(reserved.paymentIntentId);
    const again = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    expect(again.ok, JSON.stringify(again)).toBe(false);
    if (again.ok) throw new Error("released");
    expect(again.message).toBe("The total changed. Review the new card.");
    expect(again.card).toBeTruthy();
    const released = await getCheckoutPayments().retrievePaymentIntent(reserved.paymentIntentId);
    expect(released.status).toBe("canceled");
  });

  it("does not adopt a PaymentIntent the attempt did not create", async () => {
    const { cart, ctx, minted, prepared } = await basket("Foreign");
    const foreign = await getCheckoutPayments().createPaymentIntent({ amount: 500, currency: "usd" }, `foreign-${cart.id}`);
    await storeScoped(storeId).cart.update({ where: { id: cart.id }, data: { paymentIntentId: foreign.id } });
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    expect(reserved.ok, JSON.stringify(reserved)).toBe(true);
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error("secret");
    expect(reserved.paymentIntentId).not.toBe(foreign.id);
    const attempt = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(attempt?.paymentIntentId).toBe(reserved.paymentIntentId);
    const released = await getCheckoutPayments().retrievePaymentIntent(foreign.id);
    expect(released.status).toBe("canceled");
  });

  it("serializes contact saves so the version counts both writes", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const conversation = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    const ctx = { storeId, cartId: cart.id, conversationId: conversation.id, actorUserId: null, now: fixedNow };
    await Promise.all([
      saveGuestContact(ctx, { name: "Ada One", email: "ada@example.com", phone: "2025550147" }),
      saveGuestContact(ctx, { name: "Ada Two", email: "ada@example.com", phone: "2025550148" }),
    ]);
    const draft = await storeScoped(storeId).assistantCheckoutDraft.findUnique({ where: { conversationId: conversation.id } });
    expect(draft?.contactVersion).toBe(2);
    expect(["Ada One", "Ada Two"]).toContain(draft?.contactName);
  });

  it("a lock waiter does not start an expired attempt", async () => {
    const { ctx, minted, prepared } = await basket("Expired waiter");
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    const before = fakeCheckoutIntentCount();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE app_user");
      await holder.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      await holder.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", [storeId]);
      const pending = confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
      await holder.query(
        "UPDATE assistant_checkout_attempts SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = $1",
        [prepared.attemptId],
      );
      await holder.query("COMMIT");
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expired");
      expect(result.code).toBe("stale");
      expect(fakeCheckoutIntentCount()).toBe(before);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("places the contact frozen on the attempt", async () => {
    const { cart, ctx, minted, prepared } = await basket("Frozen contact");
    await storeScoped(storeId).assistantCheckoutDraft.update({
      where: { conversationId: ctx.conversationId },
      data: { contactName: "Different customer" },
    });
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    await getCheckoutPayments().confirmPaymentIntent(reserved.paymentIntentId, { payment_method: "pm_card_visa" });
    const placed = await confirmCheckout({ ...ctx, token: minted.token, phase: "complete" });
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    if (!placed.ok || placed.kind !== "order") throw new Error("order");
    const order = await storeScoped(storeId).order.findFirst({ where: { sourceCartId: cart.id } });
    const customer = order ? await storeScoped(storeId).customer.findUnique({ where: { id: order.customerId } }) : null;
    expect(customer?.name).toBe("Ada Frozen");
    expect(order?.cancellableUntil).toBeTruthy();
    const attempt = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(attempt?.contactName).toBeNull();
  });

  it("a second prepare does not change the PaymentIntent amount", async () => {
    const { cart, ctx, minted, prepared } = await basket("Second prepare");
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    const first = await getCheckoutPayments().retrievePaymentIntent(reserved.paymentIntentId);
    await storeScoped(storeId).listing.updateMany({ where: { storeId, customName: "Second prepare" }, data: { price: 1100 } });
    const again = await prepareCheckout(ctx);
    expect(again.kind).toBe("recovery_required");
    const second = await getCheckoutPayments().retrievePaymentIntent(reserved.paymentIntentId);
    expect(second.amount).toBe(first.amount);
    expect(second.id).toBe(reserved.paymentIntentId);
    const attempt = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(attempt?.reservedAmountCents).toBe(first.amount);
    expect(attempt?.paymentIntentId).toBe(reserved.paymentIntentId);
    void cart;
  });

  it("an expired attempt with no PaymentIntent lets normal checkout continue", async () => {
    const { cart, ctx, minted, prepared } = await basket("Jam");
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    await storeScoped(storeId).assistantCheckoutAttempt.update({
      where: { id: prepared.attemptId },
      data: { status: "reserved", paymentIntentId: null, expiresAt: new Date(Date.now() - 60_000) },
    });
    await storeScoped(storeId).cart.update({ where: { id: cart.id }, data: { paymentIntentId: null } });
    const created = await createPaymentIntent(storeId, cart.id, 800);
    expect(created.paymentIntentId).toBeTruthy();
    const attempt = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(attempt?.status).toBe("superseded");
  });

  it("a stale resume does not return the old secret", async () => {
    const { ctx, minted, prepared } = await basket("Stale resume");
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    await storeScoped(storeId).assistantCheckoutDraft.update({
      where: { conversationId: ctx.conversationId },
      data: { contactVersion: { increment: 1 } },
    });
    const again = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("secret");
    expect(again).not.toHaveProperty("clientSecret");
    const attempt = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(attempt?.status).toBe("superseded");
  });

  it("a link that does not take the attempt releases the PaymentIntent and returns no secret", async () => {
    const { ctx, minted, prepared } = await basket("Link no-op");
    checkoutTestHooks.beforePersistCartPaymentIntent = async () => {
      await storeScoped(storeId).assistantCheckoutAttempt.update({
        where: { id: prepared.attemptId },
        data: { status: "superseded" },
      });
    };
    try {
      const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
      expect(reserved.ok).toBe(false);
      if (reserved.ok) throw new Error("secret");
      expect(reserved.code).toBe("payment_unavailable");
      expect(reserved).not.toHaveProperty("clientSecret");
    } finally {
      checkoutTestHooks.beforePersistCartPaymentIntent = null;
    }
  });

  it("a failed release does not retire the attempt and the retry uses a new key", async () => {
    const { ctx, minted, prepared } = await basket("Release retry");
    const reserved = await confirmCheckout({ ...ctx, token: minted.token, phase: "reserve" });
    if (!reserved.ok || reserved.kind !== "client_secret") throw new Error(JSON.stringify(reserved));
    await getCheckoutPayments().confirmPaymentIntent(reserved.paymentIntentId, { payment_method: "pm_card_visa" });
    await storeScoped(storeId).assistantCheckoutDraft.update({
      where: { conversationId: ctx.conversationId },
      data: { contactVersion: { increment: 1 } },
    });
    failNextFakePaymentCancel();
    const failed = await confirmCheckout({ ...ctx, token: minted.token, phase: "complete" });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("retired");
    expect(failed.code).toBe("payment_unavailable");
    expect(fakeLastCancelKey()).toBe(`release-${reserved.paymentIntentId}-1`);
    const stuck = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(stuck?.status).toBe("awaiting_payment");
    const retried = await confirmCheckout({ ...ctx, token: minted.token, phase: "complete" });
    expect(retried.ok).toBe(false);
    expect(fakeLastCancelKey()).toBe(`release-${reserved.paymentIntentId}-2`);
    const retired = await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } });
    expect(retired?.status).toBe("superseded");
  });

  it("rejects a second live attempt on the same cart", async () => {
    const { cart, prepared } = await basket("Unique");
    await storeScoped(storeId).assistantCheckoutAttempt.update({
      where: { id: prepared.attemptId },
      data: { status: "reserved" },
    });
    await expect(storeScoped(storeId).assistantCheckoutAttempt.create({
      data: {
        storeId,
        cartId: cart.id,
        conversationId: prepared.attemptId ? (await storeScoped(storeId).assistantCheckoutAttempt.findUnique({ where: { id: prepared.attemptId } }))!.conversationId : null,
        status: "reserved",
        snapshotHash: "hash",
        snapshot: {},
        paymentKind: "new",
        idempotencyKey: `assistant-pi:${randomUUID()}`,
        reservedAmountCents: 800,
        windowMinutes: 10,
        contactVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })).rejects.toThrow();
  });
});
