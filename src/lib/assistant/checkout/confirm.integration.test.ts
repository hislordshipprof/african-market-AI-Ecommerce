import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeScoped } from "../../db";
import { customerCancelOrder } from "../../order/service";
import { getCheckoutPayments } from "../../stripe/checkout-payments";
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
});
