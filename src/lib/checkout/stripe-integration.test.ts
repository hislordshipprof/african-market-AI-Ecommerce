import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import { createPaymentIntent, placeOrder, computeQuote } from "./service";

const hasKey = !!process.env.STRIPE_SECRET_KEY;
const hasDb = !!process.env.DATABASE_URL;

const piToCleanup: string[] = [];

afterAll(async () => {
  if (!hasKey || piToCleanup.length === 0) return;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  for (const id of piToCleanup) {
    try {
      await stripe.paymentIntents.cancel(id);
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!hasKey || !hasDb)(
  "Stripe checkout integration (test mode)",
  () => {
    let rawPrisma: PrismaClient;
    let storeAId: string;
    let stripeAccountAId: string;
    let storeBId: string;
    let variantAId: string;
    let cartAId: string;

    beforeAll(async () => {
      const adapter = new PrismaPg(process.env.DATABASE_URL!);
      rawPrisma = new PrismaClient({ adapter });
      await rawPrisma.$connect();

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const accounts = await stripe.accounts.list({ limit: 2 });
      expect(accounts.data.length).toBeGreaterThanOrEqual(1);

      const acctA = accounts.data[0];
      const storeA = await rawPrisma.store.upsert({
        where: { slug: "stripe-test-a" },
        update: { stripeAccountId: acctA.id, stripeOnboardingStatus: "complete" },
        create: {
          slug: "stripe-test-a",
          name: "Stripe Test Store A",
          themePreset: "palm-and-shea",
          stripeAccountId: acctA.id,
          stripeOnboardingStatus: "complete",
          pickupEnabled: true,
        },
      });
      storeAId = storeA.id;
      stripeAccountAId = acctA.id;

      if (accounts.data.length >= 2) {
        const acctB = accounts.data[1];
        const storeB = await rawPrisma.store.upsert({
          where: { slug: "stripe-test-b" },
          update: { stripeAccountId: acctB.id, stripeOnboardingStatus: "complete" },
          create: {
            slug: "stripe-test-b",
            name: "Stripe Test Store B",
            themePreset: "lagoon-and-coral",
            stripeAccountId: acctB.id,
            stripeOnboardingStatus: "complete",
            pickupEnabled: true,
          },
        });
        storeBId = storeB.id;
      } else {
        storeBId = storeAId;
      }

      const scopedA = storeScoped(storeAId);
      const listingA = await scopedA.listing.create({
        data: {
          storeId: storeAId,
          customName: "Stripe Test Product",
          price: 1500,
          stockMode: "unlimited",
          frozen: false,
          perishable: false,
        },
      });
      const vA = await scopedA.listingVariant.create({
        data: {
          listingId: listingA.id,
          label: "500g",
          price: 1500,
          weightG: 500,
        },
      });
      variantAId = vA.id;

      const cart = await scopedA.cart.create({ data: { storeId: storeAId } });
      cartAId = cart.id;
      await scopedA.cartLine.create({
        data: {
          storeId: storeAId,
          cartId: cartAId,
          variantId: variantAId,
          qty: 2,
          swapRule: "exact_only",
        },
      });
    }, 30_000);

    afterAll(async () => {
      if (!rawPrisma) return;
      const storeIds = storeAId === storeBId ? [storeAId] : [storeAId, storeBId];
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        rawPrisma.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        rawPrisma.customer.deleteMany({
          where: { storeId: storeAId, email: { in: ["t@t.com", "e2e@test.com", "d@t.com", "x@t.com"] } },
        }),
        rawPrisma.cartLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        rawPrisma.cart.deleteMany({ where: { storeId: { in: storeIds } } }),
        rawPrisma.listingVariant.deleteMany({
          where: { listing: { storeId: storeAId, customName: "Stripe Test Product" } },
        }),
        rawPrisma.listing.deleteMany({
          where: { storeId: storeAId, customName: "Stripe Test Product" },
        }),
      ]);
      await rawPrisma.store.deleteMany({
        where: { slug: { in: ["stripe-test-a", "stripe-test-b"] } },
      });
      await rawPrisma.$disconnect();
    });

    it(
      "creates a PaymentIntent through createPaymentIntent service",
      { timeout: 15_000 },
      async () => {
        const quote = computeQuote(
          0,
          [{ price: 1500, qty: 2, maxPerOrder: null }],
          { name: "Test", phone: "+15551234567", email: "t@t.com" },
          "pickup",
        );
        const result = await createPaymentIntent(storeAId, cartAId, quote.holdCents);
        piToCleanup.push(result.paymentIntentId);

        expect(result.paymentIntentId).toMatch(/^pi_/);
        expect(result.clientSecret).toBeTruthy();

        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        const pi = await stripe.paymentIntents.retrieve(result.paymentIntentId);
        expect(pi.amount).toBe(quote.holdCents);
        expect(pi.metadata.store_id).toBe(storeAId);
        expect(pi.metadata.cart_id).toBe(cartAId);
        expect(pi.transfer_data?.destination).toBe(stripeAccountAId);
        expect(pi.on_behalf_of).toBe(stripeAccountAId);
      },
    );

    it(
      "end-to-end: confirm with pm_card_visa and place order",
      { timeout: 30_000 },
      async () => {
        const contact = { name: "E2E Test", phone: "+15551234567", email: "e2e@test.com" };
        const quote = computeQuote(
          0,
          [{ price: 1500, qty: 2, maxPerOrder: null }],
          contact,
          "pickup",
        );

        const freshCart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
        await storeScoped(storeAId).cartLine.create({
          data: {
            storeId: storeAId,
            cartId: freshCart.id,
            variantId: variantAId,
            qty: 2,
            swapRule: "exact_only",
          },
        });

        const piResult = await createPaymentIntent(storeAId, freshCart.id, quote.holdCents);
        piToCleanup.push(piResult.paymentIntentId);

        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        await stripe.paymentIntents.confirm(piResult.paymentIntentId, {
          payment_method: "pm_card_visa",
          return_url: "https://example.com/return",
        });

        const result = await placeOrder(
          storeAId,
          0,
          freshCart.id,
          contact,
          "pickup",
          null,
          null,
          piResult.paymentIntentId,
        );

        expect(result.token).toBeTruthy();
        expect(result.quote.subtotalCents).toBe(3000);
        expect(result.quote.holdCents).toBe(quote.holdCents);

        const order = await storeScoped(storeAId).order.findUnique({
          where: { id: result.token },
          include: { lines: true },
        });
        expect(order).toBeTruthy();
        expect(order!.status).toBe("AUTHORIZED");
        expect(order!.subtotalCents).toBe(3000);
        expect(order!.totalAuthorizedCents).toBe(quote.holdCents);
        expect(order!.lines.length).toBe(1);
        expect(order!.lines[0].qtyOrdered).toBe(2);
        expect(order!.lines[0].unitPriceCents).toBe(1500);
      },
    );

    it(
      "declines with pm_card_chargeDeclined — no order created",
      { timeout: 15_000 },
      async () => {
        const contact = { name: "Decline Test", phone: "+15551234567", email: "d@t.com" };
        const quote = computeQuote(
          0,
          [{ price: 1500, qty: 2, maxPerOrder: null }],
          contact,
          "pickup",
        );

        const declineCart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
        await storeScoped(storeAId).cartLine.create({
          data: {
            storeId: storeAId,
            cartId: declineCart.id,
            variantId: variantAId,
            qty: 2,
            swapRule: "exact_only",
          },
        });

        const piResult = await createPaymentIntent(storeAId, declineCart.id, quote.holdCents);
        piToCleanup.push(piResult.paymentIntentId);

        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        await expect(
          stripe.paymentIntents.confirm(piResult.paymentIntentId, {
            payment_method: "pm_card_chargeDeclined",
            return_url: "https://example.com/return",
          }),
        ).rejects.toThrow();

        await expect(
          placeOrder(
            storeAId,
            0,
            declineCart.id,
            contact,
            "pickup",
            null,
            null,
            piResult.paymentIntentId,
          ),
        ).rejects.toThrow(/requires_capture/);
      },
    );

    it(
      "rejects cross-store PaymentIntent in placeOrder",
      { timeout: 15_000 },
      async () => {
        if (storeAId === storeBId) return;

        const contact = { name: "Cross Store", phone: "+15551234567", email: "x@t.com" };
        const quote = computeQuote(
          0,
          [{ price: 1500, qty: 2, maxPerOrder: null }],
          contact,
          "pickup",
        );

        const xCart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
        await storeScoped(storeAId).cartLine.create({
          data: {
            storeId: storeAId,
            cartId: xCart.id,
            variantId: variantAId,
            qty: 2,
            swapRule: "exact_only",
          },
        });

        const piResult = await createPaymentIntent(storeAId, xCart.id, quote.holdCents);
        piToCleanup.push(piResult.paymentIntentId);

        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        await stripe.paymentIntents.confirm(piResult.paymentIntentId, {
          payment_method: "pm_card_visa",
          return_url: "https://example.com/return",
        });

        const cartB = await storeScoped(storeBId).cart.create({ data: { storeId: storeBId } });

        await expect(
          placeOrder(
            storeBId,
            0,
            cartB.id,
            contact,
            "pickup",
            null,
            null,
            piResult.paymentIntentId,
          ),
        ).rejects.toThrow(/does not match/);
      },
    );

    it("buffer formula: 10% capped at $20 for various amounts", () => {
      const validContact = { name: "A", email: "a@b.com", phone: "1234567890" };
      const cases = [
        { subtotal: 1000, expected: 100 },
        { subtotal: 5000, expected: 500 },
        { subtotal: 20000, expected: 2000 },
        { subtotal: 25000, expected: 2000 },
        { subtotal: 50000, expected: 2000 },
      ];
      for (const { subtotal, expected } of cases) {
        const q = computeQuote(0, [{ price: subtotal, qty: 1, maxPerOrder: null }], validContact, "pickup");
        expect(q.bufferCents).toBe(expected);
      }
    });
  },
);
