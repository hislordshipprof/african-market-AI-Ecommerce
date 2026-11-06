import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeScoped } from "../../db";
import { customerCancelOrder, getStoreOrders } from "../../order/service";
import { fakeCheckoutIntentCount, getCheckoutPayments, resetFakeCheckoutPayments } from "../../stripe/checkout-payments";
import { placeOrder } from "../../checkout/service";
import { confirmCheckout, mintCheckoutToken } from "./confirm";
import { prepareCheckout, saveGuestContact, setFulfillment } from "./prepare";
import { offerPickupSlots } from "./slots";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant confirm", () => {
  let raw: PrismaClient;
  let storeId = "";
  let cartId = "";
  let conversationId = "";

  beforeAll(async () => {
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
    const now = new Date();
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
    const now = new Date();
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
    const now = new Date();
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
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || first.kind !== "client_secret" || !second.ok || second.kind !== "client_secret") {
      throw new Error(JSON.stringify({ first, second }));
    }
    expect(first.paymentIntentId).toBe(second.paymentIntentId);
  });
});
