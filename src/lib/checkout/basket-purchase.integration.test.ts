import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, platformAdmin, storeScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { sendOrderAuthorized } from "../inngest/send";
import { BasketChangedError, computeQuote, placeOrder } from "./service";
import { checkoutTestHooks } from "./test-hooks";

vi.mock("../inngest/send", () => ({
  sendOrderAuthorized: vi.fn().mockResolvedValue(undefined),
}));

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t248-basket-${Date.now()}`;
const contact = { name: "Ada", phone: "+15551234567", email: "ada@example.test" };

describe.skipIf(!hasDb)("one basket purchase", () => {
  const userId = `user-${run}`;
  let storeId = "";
  let storeAccountId = "";
  let variantId = "";

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    resetFakeCheckoutPayments();
    await authPrisma.user.create({ data: { id: userId, name: "Ada", email: `${userId}@example.test` } });
    const store = await platformAdmin.store.create({
      data: {
        slug: run,
        name: "Basket market",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeId = store.id;
    storeAccountId = store.stripeAccountId!;
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Basket pack",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "V", price: 500, weightG: 100 },
    });
    variantId = variant.id;
  });

  afterEach(() => {
    checkoutTestHooks.beforeReleaseLosingHold = null;
    vi.mocked(sendOrderAuthorized).mockClear();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const scoped = storeScoped(storeId);
    await scoped.orderLine.deleteMany({ where: { storeId } });
    await scoped.order.deleteMany({ where: { storeId } });
    await scoped.cartLine.deleteMany({ where: { storeId } });
    await scoped.cart.deleteMany({ where: { storeId } });
    await scoped.customer.deleteMany({ where: { storeId } });
    await scoped.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await scoped.listing.deleteMany({ where: { storeId } });
    await platformAdmin.store.delete({ where: { id: storeId } });
    await authPrisma.user.deleteMany({ where: { id: userId } });
    resetFakeCheckoutPayments();
  });

  function holdFor(qty: number) {
    return computeQuote(0, [{ price: 500, qty, maxPerOrder: null }], contact, "pickup").holdCents;
  }

  async function cartWith(qty: number, owner: string | null) {
    const cart = await storeScoped(storeId).cart.create({
      data: { storeId, userId: owner },
    });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty, swapRule: "exact_only" },
    });
    return cart;
  }

  async function authorize(cartId: string, amount: number, metadata: Record<string, string> = {}) {
    const pi = await getCheckoutPayments().createPaymentIntent({
      amount,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: storeAccountId,
      transfer_data: { destination: storeAccountId },
      metadata: { store_id: storeId, cart_id: cartId, ...metadata },
    }, `basket-${crypto.randomUUID()}`);
    await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });
    return pi;
  }

  async function statuses(ids: string[]) {
    const rows = await Promise.all(ids.map((id) => getCheckoutPayments().retrievePaymentIntent(id)));
    return rows.map((row) => row.status).sort();
  }

  async function place(cartId: string, paymentIntentId: string, actor: string | null) {
    return placeOrder(storeId, 0, cartId, contact, "pickup", null, null, paymentIntentId, actor);
  }

  it("lets two concurrent tabs place one order and releases the losing hold", async () => {
    const cart = await cartWith(1, userId);
    const hold = holdFor(1);
    const [firstPi, secondPi] = await Promise.all([
      authorize(cart.id, hold, { purchase_epoch: "0" }),
      authorize(cart.id, hold, { purchase_epoch: "0" }),
    ]);
    const [first, second] = await Promise.all([
      place(cart.id, firstPi.id, userId),
      place(cart.id, secondPi.id, userId),
    ]);
    expect(first.token).toBe(second.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    expect(await statuses([firstPi.id, secondPi.id])).toEqual(["canceled", "requires_capture"]);
    expect(vi.mocked(sendOrderAuthorized)).toHaveBeenCalledTimes(1);
  });

  it("does the same when the second tab places later", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const firstPi = await authorize(cart.id, hold);
    const secondPi = await authorize(cart.id, hold);
    const first = await place(cart.id, firstPi.id, null);
    vi.mocked(sendOrderAuthorized).mockClear();
    const second = await place(cart.id, secondPi.id, null);
    expect(second.token).toBe(first.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    expect((await getCheckoutPayments().retrievePaymentIntent(secondPi.id)).status).toBe("canceled");
    expect(vi.mocked(sendOrderAuthorized)).not.toHaveBeenCalled();
  });

  it("does the same for a guest cart", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const [firstPi, secondPi] = await Promise.all([
      authorize(cart.id, hold),
      authorize(cart.id, hold),
    ]);
    const [first, second] = await Promise.all([
      place(cart.id, firstPi.id, null),
      place(cart.id, secondPi.id, null),
    ]);
    expect(first.token).toBe(second.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    expect(await statuses([firstPi.id, secondPi.id])).toEqual(["canceled", "requires_capture"]);
  });

  it("returns the winning order on a retry and does not cancel it", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const pi = await authorize(cart.id, hold);
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent");
    const first = await place(cart.id, pi.id, null);
    vi.mocked(sendOrderAuthorized).mockClear();
    const retry = await place(cart.id, pi.id, null);
    expect(retry.token).toBe(first.token);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.mocked(sendOrderAuthorized)).not.toHaveBeenCalled();
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("requires_capture");
    cancel.mockRestore();
  });

  it("places the order when only an older attempt was confirmed", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const older = await authorize(cart.id, hold);
    await storeScoped(storeId).cart.update({
      where: { id: cart.id },
      data: { paymentAttemptToken: `gen:${crypto.randomUUID()}:guest:${hold}` },
    });
    const order = await place(cart.id, older.id, null);
    expect(order.token).toBeTruthy();
    expect(await storeScoped(storeId).order.count({ where: { paymentIntentId: older.id } })).toBe(1);
    expect((await getCheckoutPayments().retrievePaymentIntent(older.id)).status).toBe("requires_capture");
  });

  it("releases the hold when the basket changes after authorization", async () => {
    const cart = await cartWith(1, null);
    const pi = await authorize(cart.id, holdFor(1));
    await storeScoped(storeId).cartLine.updateMany({
      where: { cartId: cart.id },
      data: { qty: 2 },
    });
    await expect(place(cart.id, pi.id, null)).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("canceled");
  });

  it("releases the hold when the amount no longer matches the quote", async () => {
    const cart = await cartWith(1, null);
    const pi = await authorize(cart.id, holdFor(1) + 75);
    await expect(place(cart.id, pi.id, null)).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("canceled");
  });

  it("refuses an old authorization after the same items are refilled", async () => {
    const cart = await cartWith(1, userId);
    const hold = holdFor(1);
    const firstPi = await authorize(cart.id, hold, { purchase_epoch: "0" });
    const first = await place(cart.id, firstPi.id, userId);
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
    });
    const stale = await authorize(cart.id, hold, { purchase_epoch: "0" });
    const again = await place(cart.id, stale.id, userId);
    expect(again.token).toBe(first.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    expect((await getCheckoutPayments().retrievePaymentIntent(stale.id)).status).toBe("canceled");
  });

  it("places a new order for a new intent after a refill", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const firstPi = await authorize(cart.id, hold, { purchase_epoch: "0" });
    const first = await place(cart.id, firstPi.id, null);
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
    });
    const next = await authorize(cart.id, hold, { purchase_epoch: "1" });
    const second = await place(cart.id, next.id, null);
    expect(second.token).not.toBe(first.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(2);
    expect((await getCheckoutPayments().retrievePaymentIntent(next.id)).status).toBe("requires_capture");
  });

  it("places an intent that has no purchase epoch while the basket is intact", async () => {
    const cart = await cartWith(1, null);
    const pi = await authorize(cart.id, holdFor(1));
    const order = await place(cart.id, pi.id, null);
    expect(order.token).toBeTruthy();
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("requires_capture");
  });

  it("still reaches the order when releasing the losing hold fails", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const winnerPi = await authorize(cart.id, hold);
    const loserPi = await authorize(cart.id, hold);
    const winner = await place(cart.id, winnerPi.id, null);
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent").mockRejectedValue(new Error("stripe down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const loser = await place(cart.id, loserPi.id, null);
    expect(loser.token).toBe(winner.token);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("losing_hold_release_failed"))).toBe(true);
    const retry = await place(cart.id, loserPi.id, null);
    expect(retry.token).toBe(winner.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    cancel.mockRestore();
    logged.mockRestore();
  });

  it("does not cancel a losing intent once an order references it", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const winnerPi = await authorize(cart.id, hold);
    const loserPi = await authorize(cart.id, hold);
    await place(cart.id, winnerPi.id, null);
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent");
    checkoutTestHooks.beforeReleaseLosingHold = async () => {
      const customer = await storeScoped(storeId).customer.create({
        data: { storeId, name: "Race", email: `race-${cart.id}@example.test`, phone: "+15551234567" },
      });
      await storeScoped(storeId).order.create({
        data: {
          storeId,
          number: 9000 + Math.floor(Math.random() * 1000),
          customerId: customer.id,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 500,
          bufferCents: 50,
          totalAuthorizedCents: hold,
          paymentIntentId: loserPi.id,
          sourceCartId: cart.id,
        },
      });
    };
    await place(cart.id, loserPi.id, null);
    expect(cancel).not.toHaveBeenCalled();
    expect((await getCheckoutPayments().retrievePaymentIntent(loserPi.id)).status).toBe("requires_capture");
    cancel.mockRestore();
  });
});
