import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, platformAdmin, storeScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { sendOrderAuthorized } from "../inngest/send";
import { BasketChangedError, computeQuote, createPaymentIntent, placeOrder, releaseLosingHold, resumeOrderedCart } from "./service";
import { prepareSignedInPaymentIntent } from "./saved-card-payment";
import { checkoutTestHooks } from "./test-hooks";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";

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
    return computeQuote(0, [{ price: 500, qty, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE).holdCents;
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

  async function place(
    cartId: string,
    paymentIntentId: string,
    actor: string | null,
    buyer: typeof contact = contact,
  ) {
    return placeOrder(storeId, 0, cartId, buyer, "pickup", null, null, paymentIntentId, actor);
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
    const kept = await storeScoped(storeId).cartLine.findMany({ where: { cartId: cart.id } });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ variantId, qty: 1 });
  });

  it("refuses a non-numeric epoch after the same items are refilled", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const firstPi = await authorize(cart.id, hold, { purchase_epoch: "0" });
    const first = await place(cart.id, firstPi.id, null);
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
    });
    const stale = await authorize(cart.id, hold, { purchase_epoch: "nope" });
    const again = await place(cart.id, stale.id, null);
    expect(again.token).toBe(first.token);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
    expect((await getCheckoutPayments().retrievePaymentIntent(stale.id)).status).toBe("canceled");
  });

  it("releases a future epoch when this basket has not been ordered", async () => {
    const cart = await cartWith(1, null);
    const pi = await authorize(cart.id, holdFor(1), { purchase_epoch: "4" });
    await expect(place(cart.id, pi.id, null)).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("canceled");
    expect(await storeScoped(storeId).cartLine.count({ where: { cartId: cart.id } })).toBe(1);
  });

  it("sends a later pay to the order once the basket is empty", async () => {
    const cart = await cartWith(1, userId);
    expect(await resumeOrderedCart(storeId, cart.id, userId)).toBeNull();
    const pi = await authorize(cart.id, holdFor(1), { purchase_epoch: "0" });
    const order = await place(cart.id, pi.id, userId);
    expect(await resumeOrderedCart(storeId, cart.id, userId)).toEqual({
      kind: "order",
      token: order.token,
      trackingToken: order.trackingToken,
    });
    expect(await resumeOrderedCart(storeId, cart.id, null)).toEqual({ kind: "unproved" });
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

  it("refuses an unstamped intent after the basket was refilled", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const firstPi = await authorize(cart.id, hold, { purchase_epoch: "0" });
    const first = await place(cart.id, firstPi.id, null);
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
    });
    const omitted = await authorize(cart.id, hold);
    const blank = await authorize(cart.id, hold, { purchase_epoch: "" });
    for (const stale of [omitted, blank]) {
      const again = await place(cart.id, stale.id, null);
      expect(again.token).toBe(first.token);
      expect((await getCheckoutPayments().retrievePaymentIntent(stale.id)).status).toBe("canceled");
    }
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(1);
  });

  it("places an intent that has no purchase epoch while the basket is intact", async () => {
    const cart = await cartWith(1, null);
    const pi = await authorize(cart.id, holdFor(1));
    const order = await place(cart.id, pi.id, null);
    expect(order.token).toBeTruthy();
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("requires_capture");
  });

  it("reserves a release so it cannot cancel an order, and an order blocks the release", async () => {
    const cart = await cartWith(1, null);
    const hold = holdFor(1);
    const pi = await authorize(cart.id, hold);
    await storeScoped(storeId).cartLine.updateMany({ where: { cartId: cart.id }, data: { qty: 2 } });
    let releaseReached!: () => void;
    const releaseReachedPromise = new Promise<void>((resolve) => {
      releaseReached = resolve;
    });
    let allowCancel!: () => void;
    const allowCancelPromise = new Promise<void>((resolve) => {
      allowCancel = resolve;
    });
    checkoutTestHooks.beforeReleaseLosingHold = async () => {
      releaseReached();
      await allowCancelPromise;
    };
    const releasing = place(cart.id, pi.id, null);
    await releaseReachedPromise;
    await storeScoped(storeId).cartLine.updateMany({ where: { cartId: cart.id }, data: { qty: 1 } });
    const placing = place(cart.id, pi.id, null);
    allowCancel();
    await expect(releasing).rejects.toBeInstanceOf(BasketChangedError);
    await expect(placing).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("canceled");
    await expect(place(cart.id, pi.id, null)).rejects.toBeInstanceOf(BasketChangedError);

    const ordered = await cartWith(1, null);
    const winner = await authorize(ordered.id, hold);
    const placed = await place(ordered.id, winner.id, null);
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent");
    checkoutTestHooks.beforeReleaseLosingHold = async () => {
      throw new Error("cancel must not start once the order exists");
    };
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: ordered.id, variantId, qty: 2, swapRule: "exact_only" },
    });
    const replay = await place(ordered.id, winner.id, null);
    expect(replay.token).toBe(placed.token);
    await releaseLosingHold(storeId, ordered.id, winner.id);
    expect(cancel).not.toHaveBeenCalled();
    expect((await getCheckoutPayments().retrievePaymentIntent(winner.id)).status).toBe("requires_capture");
    cancel.mockRestore();
  });

  it("clears the cart when Stripe cancel fails and the next attempt is a new intent", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent");

    const already = await cartWith(1, null);
    const alreadyHold = holdFor(1);
    const alreadyPi = await authorize(already.id, alreadyHold);
    await storeScoped(storeId).cart.update({
      where: { id: already.id },
      data: {
        paymentIntentId: alreadyPi.id,
        paymentAttemptToken: `gen:${crypto.randomUUID()}:guest:${alreadyHold}`,
      },
    });
    await storeScoped(storeId).cartLine.updateMany({ where: { cartId: already.id }, data: { qty: 2 } });
    cancel.mockRejectedValueOnce(new Error("You cannot cancel this PaymentIntent because it has a status of canceled"));
    await expect(place(already.id, alreadyPi.id, null)).rejects.toBeInstanceOf(BasketChangedError);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("losing_hold_release_failed"))).toBe(false);
    const cleared = await storeScoped(storeId).cart.findUnique({ where: { id: already.id } });
    expect(cleared?.paymentIntentId).toBeNull();
    const guestNext = await createPaymentIntent(storeId, already.id, alreadyHold);
    expect(guestNext.paymentIntentId).not.toBe(alreadyPi.id);

    const signed = await cartWith(1, userId);
    const signedHold = holdFor(1);
    const signedPi = await authorize(signed.id, signedHold);
    await storeScoped(storeId).cart.update({
      where: { id: signed.id },
      data: {
        paymentIntentId: signedPi.id,
        paymentAttemptToken: `gen:${crypto.randomUUID()}:guest:${signedHold}`,
      },
    });
    await storeScoped(storeId).cartLine.updateMany({ where: { cartId: signed.id }, data: { qty: 2 } });
    cancel.mockRejectedValueOnce(new Error("stripe down"));
    await expect(place(signed.id, signedPi.id, userId)).rejects.toBeInstanceOf(BasketChangedError);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("losing_hold_release_failed"))).toBe(true);
    const signedCleared = await storeScoped(storeId).cart.findUnique({ where: { id: signed.id } });
    expect(signedCleared?.paymentIntentId).toBeNull();
    const signedNext = await prepareSignedInPaymentIntent(storeId, signed.id, signedHold, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect(signedNext.paymentIntentId).not.toBe(signedPi.id);
    cancel.mockRestore();
    logged.mockRestore();
  });

  it("releases a hold edited below the minimum and keeps one with a bad contact", async () => {
    const low = await cartWith(2, null);
    const two = computeQuote(800, [{ price: 500, qty: 2, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE);
    const pi = await authorize(low.id, two.holdCents);
    await storeScoped(storeId).cartLine.updateMany({ where: { cartId: low.id }, data: { qty: 1 } });
    await expect(
      placeOrder(storeId, 800, low.id, contact, "pickup", null, null, pi.id, null),
    ).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: low.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.id)).status).toBe("canceled");

    const typo = await cartWith(1, null);
    const hold = holdFor(1);
    const kept = await authorize(typo.id, hold);
    await expect(
      place(typo.id, kept.id, null, { ...contact, email: "not-an-email" }),
    ).rejects.toThrow(/Name, email, and a valid phone/);
    expect((await getCheckoutPayments().retrievePaymentIntent(kept.id)).status).toBe("requires_capture");
    const ordered = await place(typo.id, kept.id, null);
    expect(ordered.token).toBeTruthy();

    const empty = await cartWith(1, null);
    const open = await authorize(empty.id, hold);
    await storeScoped(storeId).cart.update({
      where: { id: empty.id },
      data: { paymentIntentId: open.id },
    });
    await storeScoped(storeId).cartLine.deleteMany({ where: { cartId: empty.id } });
    await expect(place(empty.id, open.id, null)).rejects.toThrow("Cart is empty");
    expect(await storeScoped(storeId).order.count({ where: { sourceCartId: empty.id } })).toBe(0);
    expect((await getCheckoutPayments().retrievePaymentIntent(open.id)).status).toBe("canceled");
  });
});
