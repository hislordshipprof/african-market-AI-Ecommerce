import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";

vi.mock("../inngest/send", () => ({
  sendOrderAuthorized: vi.fn().mockResolvedValue(undefined),
}));

import { sendOrderAuthorized } from "../inngest/send";
import { placeOrder, computeQuote } from "./service";
import { getStripeClient } from "../stripe/provider";

const hasKey = !!process.env.STRIPE_SECRET_KEY;
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasKey || !hasDb)("placeOrder fires Inngest event", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let stripeAccountId: string;
  let variantId: string;
  let canRun = false;
  const piToCleanup: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const stripe = (await import("stripe")).default;
    const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!);
    let acct: { id: string } | undefined;
    for await (const a of stripeClient.accounts.list({ limit: 100 })) {
      if (a.capabilities?.transfers === "active") {
        acct = a;
        break;
      }
    }
    if (!acct) return;
    const store = await rawPrisma.store.upsert({
      where: { stripeAccountId: acct.id },
      update: { stripeOnboardingStatus: "complete" },
      create: {
        slug: "inngest-event-test",
        name: "Inngest Event Test",
        themePreset: "palm-and-shea",
        stripeAccountId: acct.id,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeId = store.id;
    stripeAccountId = acct.id;

    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Inngest Test Product",
        price: 1500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const v = await scoped.listingVariant.create({
      data: { listingId: listing.id, label: "500g", price: 1500, weightG: 500 },
    });
    variantId = v.id;
    canRun = true;
  }, 30_000);

  afterAll(async () => {
    if (!canRun) { await rawPrisma?.$disconnect(); return; }
    if (piToCleanup.length) {
      const stripe = (await import("stripe")).default;
      const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!);
      for (const id of piToCleanup) {
        try { await stripeClient.paymentIntents.cancel(id); } catch { /* best effort */ }
      }
    }
    if (rawPrisma) {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.orderLine.deleteMany({ where: { storeId } }),
        rawPrisma.order.deleteMany({ where: { storeId } }),
        rawPrisma.customer.deleteMany({ where: { storeId } }),
        rawPrisma.cartLine.deleteMany({ where: { storeId } }),
        rawPrisma.cart.deleteMany({ where: { storeId } }),
        rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId } } }),
        rawPrisma.listing.deleteMany({ where: { storeId } }),
      ]);
      await rawPrisma.store.deleteMany({ where: { id: storeId } });
      await rawPrisma.$disconnect();
    }
  });

  beforeEach(() => {
    vi.mocked(sendOrderAuthorized).mockClear();
  });

  it("emits exactly one sendOrderAuthorized event on first placeOrder", async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const contact = { name: "Event Test", phone: "+15551234567", email: "evt@test.com" };
    const quote = computeQuote(0, [{ price: 1500, qty: 2, maxPerOrder: null }], contact, "pickup");

    const scoped = storeScoped(storeId);
    const cart = await scoped.cart.create({ data: { storeId } });
    await scoped.cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 2, swapRule: "exact_only" },
    });

    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.create({
      amount: quote.holdCents,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: stripeAccountId,
      transfer_data: { destination: stripeAccountId },
      metadata: { store_id: storeId, cart_id: cart.id },
    });
    piToCleanup.push(pi.id);
    await scoped.cart.update({ where: { id: cart.id }, data: { paymentIntentId: pi.id } });
    await stripe.paymentIntents.confirm(pi.id, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });

    const result = await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id);
    expect(result.token).toBeTruthy();

    expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
    expect(sendOrderAuthorized).toHaveBeenCalledWith(storeId, result.token);
  }, 30_000);

  it("does NOT re-send event on idempotent replay", async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const contact = { name: "Replay Test", phone: "+15551234567", email: "replay@test.com" };
    const quote = computeQuote(0, [{ price: 1500, qty: 2, maxPerOrder: null }], contact, "pickup");

    const scoped = storeScoped(storeId);
    const cart = await scoped.cart.create({ data: { storeId } });
    await scoped.cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 2, swapRule: "exact_only" },
    });

    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.create({
      amount: quote.holdCents,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: stripeAccountId,
      transfer_data: { destination: stripeAccountId },
      metadata: { store_id: storeId, cart_id: cart.id },
    });
    piToCleanup.push(pi.id);
    await scoped.cart.update({ where: { id: cart.id }, data: { paymentIntentId: pi.id } });
    await stripe.paymentIntents.confirm(pi.id, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });

    await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id);
    vi.mocked(sendOrderAuthorized).mockClear();

    // Create a new cart for the replay (original cart was emptied)
    const cart2 = await scoped.cart.create({ data: { storeId } });
    await scoped.cartLine.create({
      data: { storeId, cartId: cart2.id, variantId, qty: 2, swapRule: "exact_only" },
    });

    const result2 = await placeOrder(storeId, 0, cart2.id, contact, "pickup", null, null, pi.id);
    expect(result2.token).toBeTruthy();

    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  }, 30_000);
});
