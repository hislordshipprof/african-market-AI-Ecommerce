import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import { checkoutTestHooks, createPaymentIntent, placeOrder, computeQuote } from "./service";

type ConnectedAccountCaps = {
  id: string;
  capabilities?: { transfers?: string; card_payments?: string } | null;
};

function selectCheckoutConnectedAccount<T extends ConnectedAccountCaps>(accounts: T[]): T {
  const eligible = accounts.filter(
    (account) =>
      account.capabilities?.transfers === "active" &&
      account.capabilities.card_payments === "active",
  );
  if (eligible.length > 0) return eligible[0]!;
  if (accounts.some((account) => account.capabilities?.transfers === "active")) {
    throw new Error(
      "Sandbox connected account has transfers but lacks an active card_payments capability. Refusing to treat checkout concurrency as successful.",
    );
  }
  throw new Error(
    "No sandbox connected account has active transfers and card_payments capabilities; finish hosted onboarding for one store (see #64 step 1).",
  );
}

function createPartyBarrier() {
  let count = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let released = false;
  const timers = new Set<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
  return {
    arrived: () => count,
    arrive() {
      count += 1;
      return gate;
    },
    waitFor(expected: number, timeoutMs: number) {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          timers.delete(timeout);
          timers.delete(interval);
          reject(new Error(`five-party barrier timed out with ${count} of ${expected}`));
        }, timeoutMs);
        const interval = setInterval(() => {
          if (count >= expected) {
            clearTimeout(timeout);
            clearInterval(interval);
            timers.delete(timeout);
            timers.delete(interval);
            resolve();
          }
        }, 15);
        timers.add(timeout);
        timers.add(interval);
      });
    },
    releaseAll() {
      if (!released) {
        released = true;
        releaseGate();
      }
    },
    clear() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      this.releaseAll();
    },
  };
}

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
    let listingAId: string;
    let cartAId: string;
    const cartsCreated: string[] = [];

    beforeAll(async () => {
      const adapter = new PrismaPg(process.env.DATABASE_URL!);
      rawPrisma = new PrismaClient({ adapter });
      await rawPrisma.$connect();

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const ready: Stripe.Account[] = [];
      const others: Stripe.Account[] = [];
      for await (const acct of stripe.accounts.list({ limit: 100 })) {
        let capabilities = acct.capabilities;
        if (capabilities?.transfers === "active" && capabilities.card_payments !== "active") {
          capabilities = (await stripe.accounts.retrieve(acct.id)).capabilities ?? capabilities;
        }
        const withCaps = { ...acct, capabilities } as Stripe.Account;
        if (
          capabilities?.transfers === "active" &&
          capabilities.card_payments === "active"
        ) {
          ready.push(withCaps);
        } else {
          others.push(withCaps);
        }
        if (ready.length >= 1 && others.length >= 1) break;
      }
      if (!ready.length) {
        selectCheckoutConnectedAccount(
          others.map((account) => ({ id: account.id, capabilities: account.capabilities })),
        );
        throw new Error("No eligible sandbox account");
      }
      const accounts = { data: [ready[0]!, ...others] };

      const acctA = accounts.data[0]!;
      let storeA = await rawPrisma.store.findFirst({
        where: { stripeAccountId: acctA.id },
      });
      if (!storeA) {
        try {
          storeA = await rawPrisma.store.create({
            data: {
              slug: "stripe-test-a",
              name: "Stripe Test Store A",
              themePreset: "palm-and-shea",
              stripeAccountId: acctA.id,
              stripeOnboardingStatus: "complete",
              pickupEnabled: true,
            },
          });
        } catch {
          // placeorder-event.test.ts may have inserted this account first.
          storeA = await rawPrisma.store.findFirst({
            where: { stripeAccountId: acctA.id },
          });
        }
      }
      if (!storeA) {
        throw new Error(`No store row for connected account ${acctA.id}`);
      }
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
      listingAId = listingA.id;
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
      cartsCreated.push(cart.id);
      await scopedA.cartLine.create({
        data: {
          storeId: storeAId,
          cartId: cartAId,
          variantId: variantAId,
          qty: 2,
          swapRule: "exact_only",
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!rawPrisma) return;
      try {
        await rawPrisma.$transaction([
          rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
          rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
          rawPrisma.orderLine.deleteMany({
            where: { order: { paymentIntentId: { in: piToCleanup } } },
          }),
          rawPrisma.order.deleteMany({
            where: { paymentIntentId: { in: piToCleanup } },
          }),
          rawPrisma.customer.deleteMany({
            where: {
              storeId: storeAId,
              email: {
                in: [
                  "t@t.com",
                  "e2e@test.com",
                  "d@t.com",
                  "x@t.com",
                  "high@t.com",
                  "five-0@t.com",
                  "five-1@t.com",
                  "five-2@t.com",
                  "five-3@t.com",
                  "five-4@t.com",
                ],
              },
            },
          }),
          rawPrisma.cartLine.deleteMany({
            where: { cartId: { in: cartsCreated } },
          }),
          rawPrisma.cart.deleteMany({
            where: { id: { in: cartsCreated } },
          }),
        ]);
        if (listingAId) {
          await rawPrisma.$transaction([
            rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
            rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
            rawPrisma.listingVariant.deleteMany({ where: { listingId: listingAId } }),
            rawPrisma.listing.deleteMany({ where: { id: listingAId } }),
          ]);
        }
      } catch { /* best-effort cleanup — parallel tests may hold FK refs */ }
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
        cartsCreated.push(freshCart.id);
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
        cartsCreated.push(declineCart.id);
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
        cartsCreated.push(xCart.id);
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
        cartsCreated.push(cartB.id);

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

    it(
      "five concurrent checkouts on one store all place orders",
      { timeout: 60_000 },
      async () => {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        const prepared = await Promise.all(
          Array.from({ length: 5 }, async (_, index) => {
            const contact = {
              name: `Five ${index}`,
              phone: "+15551234567",
              email: `five-${index}@t.com`,
            };
            const quote = computeQuote(
              0,
              [{ price: 1500, qty: 2, maxPerOrder: null }],
              contact,
              "pickup",
            );
            const cart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
            cartsCreated.push(cart.id);
            await storeScoped(storeAId).cartLine.create({
              data: {
                storeId: storeAId,
                cartId: cart.id,
                variantId: variantAId,
                qty: 2,
                swapRule: "exact_only",
              },
            });
            let pi: Stripe.PaymentIntent;
            try {
              pi = await stripe.paymentIntents.create({
                amount: quote.holdCents,
                currency: "usd",
                capture_method: "manual",
                on_behalf_of: stripeAccountAId,
                transfer_data: { destination: stripeAccountAId },
                metadata: { store_id: storeAId, cart_id: cart.id },
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`PaymentIntent create failed for worker ${index}: ${message}`);
            }
            piToCleanup.push(pi.id);
            await storeScoped(storeAId).cart.update({
              where: { id: cart.id },
              data: { paymentIntentId: pi.id },
            });
            let confirmed: Stripe.PaymentIntent;
            try {
              confirmed = await stripe.paymentIntents.confirm(pi.id, {
                payment_method: "pm_card_visa",
                return_url: "https://example.com/return",
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`PaymentIntent confirm failed for ${pi.id}: ${message}`);
            }
            if (confirmed.status !== "requires_capture") {
              throw new Error(
                `PaymentIntent ${pi.id} confirmed as ${confirmed.status}, expected requires_capture`,
              );
            }
            return { cartId: cart.id, contact, paymentIntentId: pi.id, status: confirmed.status };
          }),
        );
        expect(prepared).toHaveLength(5);
        expect(prepared.map((row) => row.status)).toEqual([
          "requires_capture",
          "requires_capture",
          "requires_capture",
          "requires_capture",
          "requires_capture",
        ]);
        expect(checkoutTestHooks.afterMissedOrderLookup).toBeNull();

        const barrier = createPartyBarrier();
        checkoutTestHooks.afterMissedOrderLookup = async () => {
          await barrier.arrive();
        };
        let inFlight: Promise<Array<{ token: string }>> | undefined;
        try {
          inFlight = Promise.all(
            prepared.map((row) =>
              placeOrder(storeAId, 0, row.cartId, row.contact, "pickup", null, null, row.paymentIntentId),
            ),
          );
          void inFlight.catch(() => undefined);
          await barrier.waitFor(5, 20_000);
          expect(barrier.arrived()).toBe(5);
          barrier.releaseAll();
          const orders = await inFlight;
          const tokens = orders.map((order) => order.token);
          expect(new Set(tokens).size).toBe(5);
          const saved = await storeScoped(storeAId).order.findMany({
            where: { id: { in: tokens } },
          });
          expect(saved).toHaveLength(5);
          expect(saved.every((order) => order.status === "AUTHORIZED")).toBe(true);
          expect(new Set(saved.map((order) => order.number)).size).toBe(5);
          for (let index = 0; index < orders.length; index += 1) {
            const savedOrder = saved.find((order) => order.id === orders[index]!.token);
            expect(savedOrder?.paymentIntentId).toBe(prepared[index]!.paymentIntentId);
          }
        } finally {
          barrier.clear();
          checkoutTestHooks.afterMissedOrderLookup = null;
          if (inFlight) await Promise.allSettled([inFlight]);
        }
      },
    );

    it(
      "a PaymentIntent amount above the hold writes no customer or order",
      { timeout: 20_000 },
      async () => {
        const contact = { name: "High Hold", phone: "+15551234567", email: "high@t.com" };
        const quote = computeQuote(
          0,
          [{ price: 1500, qty: 2, maxPerOrder: null }],
          contact,
          "pickup",
        );
        const cart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
        cartsCreated.push(cart.id);
        await storeScoped(storeAId).cartLine.create({
          data: {
            storeId: storeAId,
            cartId: cart.id,
            variantId: variantAId,
            qty: 2,
            swapRule: "exact_only",
          },
        });
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        const pi = await stripe.paymentIntents.create({
          amount: quote.holdCents + 1,
          currency: "usd",
          capture_method: "manual",
          on_behalf_of: stripeAccountAId,
          transfer_data: { destination: stripeAccountAId },
          metadata: { store_id: storeAId, cart_id: cart.id },
        });
        piToCleanup.push(pi.id);
        await stripe.paymentIntents.confirm(pi.id, {
          payment_method: "pm_card_visa",
          return_url: "https://example.com/return",
        });
        await expect(
          placeOrder(storeAId, 0, cart.id, contact, "pickup", null, null, pi.id),
        ).rejects.toThrow(/does not match quote hold/);
        expect(await storeScoped(storeAId).customer.count({ where: { email: contact.email } })).toBe(0);
        expect(await storeScoped(storeAId).order.count({ where: { paymentIntentId: pi.id } })).toBe(0);
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

describe("checkout concurrency barrier", () => {
  it("a transfers-only sandbox account is not checkout concurrency evidence", () => {
    expect(() =>
      selectCheckoutConnectedAccount([
        { id: "acct_transfers_only", capabilities: { transfers: "active", card_payments: "inactive" } },
      ]),
    ).toThrow(/lacks an active card_payments capability/);
    expect(() =>
      selectCheckoutConnectedAccount([
        { id: "acct_none", capabilities: { transfers: "inactive", card_payments: "inactive" } },
      ]),
    ).toThrow(/No sandbox connected account/);
    const chosen = selectCheckoutConnectedAccount([
      { id: "acct_transfers_only", capabilities: { transfers: "active", card_payments: "inactive" } },
      { id: "acct_ready", capabilities: { transfers: "active", card_payments: "active" } },
    ]);
    expect(chosen.id).toBe("acct_ready");
  });

  it("five-party barrier releases and settles peers when a participant fails", async () => {
    const barrier = createPartyBarrier();
    checkoutTestHooks.afterMissedOrderLookup = async () => {
      await barrier.arrive();
    };
    const started: Promise<string>[] = [];
    for (let index = 0; index < 5; index += 1) {
      const task = (async () => {
        if (index === 4) throw new Error("worker failed before the barrier");
        await checkoutTestHooks.afterMissedOrderLookup?.();
        return `settled-${index}`;
      })();
      void task.catch(() => undefined);
      started.push(task);
    }
    try {
      const start = Date.now();
      while (barrier.arrived() < 4 && Date.now() - start < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(barrier.arrived()).toBe(4);
      await expect(barrier.waitFor(5, 200)).rejects.toThrow(/timed out with 4 of 5/);
    } finally {
      barrier.clear();
      checkoutTestHooks.afterMissedOrderLookup = null;
    }
    const settled = await Promise.allSettled(started);
    expect(checkoutTestHooks.afterMissedOrderLookup).toBeNull();
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(4);
    const rejected = settled.find((row) => row.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      const message = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
      expect(message).toBe("worker failed before the barrier");
    }
  });
});
