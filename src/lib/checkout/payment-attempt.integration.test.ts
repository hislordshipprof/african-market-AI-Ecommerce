import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, customerScoped, platformAdmin, storeScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { BasketChangedError, computeQuote, createPaymentIntent, placeOrder, releaseOrphanHolds } from "./service";
import { findOrphanHoldCarts, markOrphanHoldChecked, storeScopedTransaction } from "../db";
import { prepareSignedInPaymentIntent, SavedCardUnavailableError } from "./saved-card-payment";
import { ensureStripeCustomer } from "../customer-account/stripe-customer";
import { SAVED_CARD_PURPOSE, SAVED_CARD_TERMS_VERSION } from "../customer-account/consent";
import { sendOrderAuthorized } from "../inngest/send";
import { checkoutTestHooks } from "./test-hooks";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";

vi.mock("../inngest/send", () => ({
  sendOrderAuthorized: vi.fn().mockResolvedValue(undefined),
}));

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t248-attempt-${Date.now()}`;

describe.skipIf(!hasDb)("signed-in payment attempts", () => {
  const userId = `user-${run}`;
  let storeId = "";
  let storeAccountId = "";
  let cartId = "";

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    resetFakeCheckoutPayments();
    await authPrisma.user.create({ data: { id: userId, name: "Ada", email: `${userId}@example.test` } });
    const store = await platformAdmin.store.create({
      data: {
        slug: run,
        name: "Attempt market",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeId = store.id;
    storeAccountId = store.stripeAccountId!;
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    cartId = cart.id;
  });

  afterEach(() => {
    checkoutTestHooks.beforeCancelPaymentIntent = null;
    checkoutTestHooks.beforePersistCartPaymentIntent = null;
    checkoutTestHooks.beforeBindSavedCardConsent = null;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const stores = await platformAdmin.store.findMany({
      where: { slug: { startsWith: run } },
      select: { id: true },
    });
    for (const store of stores) {
      const scoped = storeScoped(store.id);
      await scoped.orderLine.deleteMany({ where: { storeId: store.id } });
      await scoped.order.deleteMany({ where: { storeId: store.id } });
      await scoped.cartLine.deleteMany({ where: { storeId: store.id } });
      await scoped.cart.deleteMany({ where: { storeId: store.id } });
      await scoped.customer.deleteMany({ where: { storeId: store.id } });
      await scoped.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await scoped.listing.deleteMany({ where: { storeId: store.id } });
      await platformAdmin.store.delete({ where: { id: store.id } });
    }
    await authPrisma.user.deleteMany({ where: { id: userId } });
    resetFakeCheckoutPayments();
  });

  async function prepare(saveCard: boolean, attemptToken: string | null) {
    return prepareSignedInPaymentIntent(storeId, cartId, 4200, {
      actorUserId: userId,
      saveCard,
      savedCardId: null,
      attemptToken,
    }, storeAccountId);
  }

  it("starts a new PaymentIntent after the previous one is canceled", async () => {
    const first = await prepare(false, null);
    await getCheckoutPayments().cancelPaymentIntent(first.paymentIntentId);
    const second = await prepare(false, first.attemptToken);
    expect(second.paymentIntentId).not.toBe(first.paymentIntentId);
    const created = await getCheckoutPayments().retrievePaymentIntent(second.paymentIntentId);
    expect(created.status).toBe("requires_payment_method");
  });

  it("does not change another tab's PaymentIntent when the save tick changes", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const unticked = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    const ticked = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: unticked.attemptToken,
    }, storeAccountId);
    expect(ticked.paymentIntentId).not.toBe(unticked.paymentIntentId);
    const original = await getCheckoutPayments().retrievePaymentIntent(unticked.paymentIntentId);
    expect(original.setup_future_usage).toBeNull();
    const replacement = await getCheckoutPayments().retrievePaymentIntent(ticked.paymentIntentId);
    expect(replacement.setup_future_usage).toBe("on_session");
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("keeps affirmative consent when the same ticked selection is retried", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const first = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    const before = await customerScoped(userId).cardSaveConsent.count({
      where: { paymentIntentId: first.paymentIntentId },
    });
    expect(before).toBe(1);
    await customerScoped(userId).cardSaveConsent.deleteMany({
      where: { paymentIntentId: first.paymentIntentId },
    });
    const second = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: first.attemptToken,
    }, storeAccountId);
    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    const after = await customerScoped(userId).cardSaveConsent.count({
      where: { paymentIntentId: first.paymentIntentId },
    });
    expect(after).toBe(1);
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("does not cancel a PaymentIntent that is authorized before replacement", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const first = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    checkoutTestHooks.beforeCancelPaymentIntent = async () => {
      await getCheckoutPayments().confirmPaymentIntent(first.paymentIntentId, {
        payment_method: "pm_card_visa",
      });
    };
    await expect(prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: first.attemptToken,
    }, storeAccountId)).rejects.toThrow("Payment already confirmed for this cart");
    const held = await getCheckoutPayments().retrievePaymentIntent(first.paymentIntentId);
    expect(held.status).toBe("requires_capture");
    const stored = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
    expect(stored?.paymentIntentId).toBe(first.paymentIntentId);
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("places a fake PaymentIntent when no Stripe secret key is set", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Attempt pack",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "V", price: 500, weightG: 100 },
    });
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const contact = { name: "Ada", phone: "+15551234567", email: "ada@example.test" };
    const holdCents = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE).holdCents;
    const pi = await getCheckoutPayments().createPaymentIntent({
      amount: holdCents,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: storeAccountId,
      transfer_data: { destination: storeAccountId },
      metadata: { store_id: storeId, cart_id: cart.id },
    }, `place-${cart.id}`);
    await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });
    const order = await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id);
    expect(order.token).toBeTruthy();
    expect(pi.id.startsWith("pi_fake_")).toBe(true);
  });

  it("does not return or cancel a PaymentIntent that belongs to another cart", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const foreign = await getCheckoutPayments().createPaymentIntent({
      amount: 4200,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: "acct_other",
      transfer_data: { destination: "acct_other" },
      metadata: { store_id: "store_other", cart_id: "cart_other" },
    }, `foreign-${cart.id}`);
    await storeScoped(storeId).cart.update({ where: { id: cart.id }, data: { paymentIntentId: foreign.id } });
    const prepared = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect(prepared.paymentIntentId).not.toBe(foreign.id);
    expect(prepared.clientSecret).not.toBe(foreign.client_secret);
    const left = await getCheckoutPayments().retrievePaymentIntent(foreign.id);
    expect(left.status).toBe("requires_payment_method");
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("keeps the reserved generation when storing the PaymentIntent fails", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const create = vi.spyOn(getCheckoutPayments(), "createPaymentIntent");
    checkoutTestHooks.beforePersistCartPaymentIntent = async () => {
      throw new Error("persist failed");
    };
    await expect(prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId)).rejects.toThrow("persist failed");
    const stored = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
    expect(stored?.paymentAttemptToken).toBeTruthy();
    expect(stored?.paymentIntentId).toBeNull();
    const firstKey = create.mock.calls[0]?.[1];
    const firstIntent = await create.mock.results[0]?.value;
    checkoutTestHooks.beforePersistCartPaymentIntent = null;
    const second = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect(second.paymentIntentId).toBe(firstIntent.id);
    expect(create.mock.calls[1]?.[1]).toBe(firstKey);
    create.mockRestore();
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("does not cancel an issued PaymentIntent when the selection changes", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const first = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    const cancel = vi.spyOn(getCheckoutPayments(), "cancelPaymentIntent");
    const second = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: first.attemptToken,
    }, storeAccountId);
    expect(cancel).not.toHaveBeenCalled();
    expect(second.paymentIntentId).not.toBe(first.paymentIntentId);
    await getCheckoutPayments().confirmPaymentIntent(first.paymentIntentId, {
      payment_method: "pm_card_visa",
    });
    const held = await getCheckoutPayments().retrievePaymentIntent(first.paymentIntentId);
    expect(held.status).toBe("requires_capture");
    cancel.mockRestore();
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("treats a card detached before the charge as unavailable", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const saved = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
      actorUserId: userId,
      saveCard: true,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    const confirmed = await getCheckoutPayments().confirmPaymentIntent(saved.paymentIntentId, {
      payment_method: "pm_card_visa",
    });
    const paymentMethodId = confirmed.payment_method;
    expect(paymentMethodId).toBeTruthy();
    await customerScoped(userId).cardSaveConsent.updateMany({
      where: { userId, paymentIntentId: saved.paymentIntentId },
      data: { paymentMethodId },
    });
    const nextCart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const payments = getCheckoutPayments();
    const live = payments.createPaymentIntent.bind(payments);
    const create = vi.spyOn(payments, "createPaymentIntent");
    create.mockRejectedValueOnce({ type: "StripeAPIError", statusCode: 500, message: "upstream" });
    await expect(prepareSignedInPaymentIntent(storeId, nextCart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: paymentMethodId,
      attemptToken: null,
    }, storeAccountId)).rejects.not.toBeInstanceOf(SavedCardUnavailableError);
    const reserved = await storeScoped(storeId).cart.findUnique({ where: { id: nextCart.id } });
    expect(reserved?.paymentAttemptToken).toBeTruthy();
    expect(reserved?.paymentIntentId).toBeNull();
    create.mockRejectedValueOnce(Object.assign(new Error("No such payment_method: 'pm_missing'"), {
      code: "resource_missing",
      statusCode: 404,
    }));
    await expect(prepareSignedInPaymentIntent(storeId, nextCart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: paymentMethodId,
      attemptToken: null,
    }, storeAccountId)).rejects.toBeInstanceOf(SavedCardUnavailableError);
    create.mockImplementationOnce(async (params, key) => {
      await payments.detachPaymentMethod(paymentMethodId!);
      return live(params, key);
    });
    await expect(prepareSignedInPaymentIntent(storeId, nextCart.id, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: paymentMethodId,
      attemptToken: null,
    }, storeAccountId)).rejects.toBeInstanceOf(SavedCardUnavailableError);
    create.mockRestore();
    await storeScoped(storeId).cart.deleteMany({ where: { id: { in: [cart.id, nextCart.id] } } });
  });

  it("lets two guest requests share one PaymentIntent", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const [first, second] = await Promise.all([
      createPaymentIntent(storeId, cart.id, 4200),
      createPaymentIntent(storeId, cart.id, 4200),
    ]);
    expect(first.paymentIntentId).toBe(second.paymentIntentId);
    const stored = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
    expect(stored?.paymentIntentId).toBe(first.paymentIntentId);
    expect(stored?.paymentAttemptToken).toBeTruthy();
    const updated = await createPaymentIntent(storeId, cart.id, 5100);
    expect(updated.paymentIntentId).toBe(first.paymentIntentId);
    const amount = await getCheckoutPayments().retrievePaymentIntent(first.paymentIntentId);
    expect(amount.amount).toBe(5100);
    await storeScoped(storeId).cart.delete({ where: { id: cart.id } });
  });

  it("returns the order when saving the card fails and binds it on replay", async () => {
    vi.mocked(sendOrderAuthorized).mockClear();
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Consent pack",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "V", price: 500, weightG: 100 },
    });
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, userId } });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const contact = { name: "Ada", phone: "+15551234567", email: "ada@example.test" };
    const holdCents = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE).holdCents;
    const pi = await getCheckoutPayments().createPaymentIntent({
      amount: holdCents,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: storeAccountId,
      transfer_data: { destination: storeAccountId },
      metadata: { store_id: storeId, cart_id: cart.id },
    }, `bind-${cart.id}`);
    await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });
    await customerScoped(userId).cardSaveConsent.create({
      data: {
        userId,
        paymentIntentId: pi.id,
        stripeCustomerId: "cus_fake_bind",
        termsVersion: SAVED_CARD_TERMS_VERSION,
        purpose: SAVED_CARD_PURPOSE,
      },
    });
    checkoutTestHooks.beforeBindSavedCardConsent = async () => {
      checkoutTestHooks.beforeBindSavedCardConsent = null;
      throw new Error("consent store down");
    };
    const order = await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id, userId);
    expect(order.token).toBeTruthy();
    expect(vi.mocked(sendOrderAuthorized)).toHaveBeenCalledTimes(1);
    const pending = await customerScoped(userId).cardSaveConsent.findFirst({
      where: { paymentIntentId: pi.id },
    });
    expect(pending?.paymentMethodId ?? null).toBeNull();
    const replay = await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id, userId);
    expect(replay.token).toBe(order.token);
    expect(vi.mocked(sendOrderAuthorized)).toHaveBeenCalledTimes(1);
    const bound = await customerScoped(userId).cardSaveConsent.findFirst({
      where: { paymentIntentId: pi.id },
    });
    expect(bound?.paymentMethodId).toBe("pm_card_visa");
  });

  it("does not treat a Stripe outage as a missing saved card", async () => {
    await ensureStripeCustomer(userId);
    const retrieve = vi.spyOn(getCheckoutPayments(), "retrievePaymentMethod");
    retrieve.mockRejectedValueOnce({ type: "StripeConnectionError", message: "network down", statusCode: 500 });
    await expect(prepareSignedInPaymentIntent(storeId, cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: "pm_card_visa",
      attemptToken: null,
    }, storeAccountId)).rejects.not.toBeInstanceOf(SavedCardUnavailableError);
    retrieve.mockRejectedValueOnce({ type: "StripeAPIError", message: "upstream", statusCode: 500 });
    await expect(prepareSignedInPaymentIntent(storeId, cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: "pm_card_visa",
      attemptToken: null,
    }, storeAccountId)).rejects.not.toBeInstanceOf(SavedCardUnavailableError);
    retrieve.mockRejectedValueOnce({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      message: "No such payment_method: 'pm_card_visa'",
      statusCode: 404,
    });
    await expect(prepareSignedInPaymentIntent(storeId, cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: "pm_card_visa",
      attemptToken: null,
    }, storeAccountId)).rejects.toBeInstanceOf(SavedCardUnavailableError);
    retrieve.mockRestore();
  });

  async function heldCart(createdAgoMs: number, authorizedAgoMs: number) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - createdAgoMs);
      const prepared = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
        actorUserId: userId,
        saveCard: false,
        savedCardId: null,
        attemptToken: null,
      }, storeAccountId);
      vi.setSystemTime(Date.now() + createdAgoMs - authorizedAgoMs);
      await getCheckoutPayments().confirmPaymentIntent(prepared.paymentIntentId, { payment_method: "pm_card_visa" });
      return { cartId: cart.id, paymentIntentId: prepared.paymentIntentId };
    } finally {
      vi.useRealTimers();
    }
  }

  async function deadCart(writtenAgoMs: number) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - writtenAgoMs);
      const prepared = await prepareSignedInPaymentIntent(storeId, cart.id, 4200, {
        actorUserId: userId,
        saveCard: false,
        savedCardId: null,
        attemptToken: null,
      }, storeAccountId);
      return { cartId: cart.id, paymentIntentId: prepared.paymentIntentId };
    } finally {
      vi.useRealTimers();
    }
  }

  function releaseRow(paymentIntentId: string) {
    return storeScopedTransaction(storeId, (tx) => tx.paymentIntentRelease.findUnique({ where: { paymentIntentId } }));
  }

  async function sweep() {
    await releaseOrphanHolds(await findOrphanHoldCarts({ storeIds: [storeId] }));
  }

  /** Earlier tests leave carts in the sweep; checking them now puts them behind a test's own carts. */
  function checkLeftoverCarts() {
    return storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
      UPDATE carts SET orphan_checked_at = now() WHERE store_id = ${storeId} AND payment_intent_id IS NOT NULL
    `);
  }

  it("releases a hold with no order 61 min after authorization, and placeOrder then refuses it", async () => {
    const held = await heldCart(61 * 60_000, 61 * 60_000);
    await sweep();
    const released = await releaseRow(held.paymentIntentId);
    expect(released?.storeId).toBe(storeId);
    expect((await getCheckoutPayments().retrievePaymentIntent(held.paymentIntentId)).status).toBe("canceled");
    const contact = { name: "Ada", phone: "+15551234567", email: "ada@example.test" };
    await expect(placeOrder(storeId, 0, held.cartId, contact, "pickup", null, null, held.paymentIntentId, userId))
      .rejects.toBeInstanceOf(BasketChangedError);
    const fresh = await prepareSignedInPaymentIntent(storeId, held.cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect(fresh.paymentIntentId).not.toBe(held.paymentIntentId);
  });

  it("leaves a hold inside the grace untouched, also on an intent created 3 h ago and authorized 5 min ago", async () => {
    const recent = await heldCart(5 * 60_000, 5 * 60_000);
    const reused = await heldCart(3 * 60 * 60_000, 5 * 60_000);
    await sweep();
    for (const held of [recent, reused]) {
      expect((await getCheckoutPayments().retrievePaymentIntent(held.paymentIntentId)).status).toBe("requires_capture");
      expect(await releaseRow(held.paymentIntentId)).toBeNull();
      const cart = await storeScoped(storeId).cart.findUnique({ where: { id: held.cartId } });
      expect(cart?.paymentIntentId).toBe(held.paymentIntentId);
    }
  });

  it("reaches an orphan hold behind carts that never paid, and cancels carts dead for 24 h", async () => {
    const deadCarts = async (count: number, writtenAgoMs: number) => {
      const carts = [];
      for (let i = 0; i < count; i += 1) carts.push(await deadCart(writtenAgoMs));
      return carts;
    };
    await checkLeftoverCarts();
    const dayOld = await deadCarts(25, 25 * 60 * 60_000);
    const unpaid = [...await deadCarts(50, 4 * 60 * 60_000), ...await deadCarts(50, 2 * 60 * 60_000)];
    const held = await heldCart(3 * 60 * 60_000, 61 * 60_000);
    for (let run = 0; run < 3; run += 1) await sweep();
    expect((await getCheckoutPayments().retrievePaymentIntent(held.paymentIntentId)).status).toBe("canceled");
    expect(await releaseRow(held.paymentIntentId)).not.toBeNull();
    for (const dead of dayOld) {
      expect((await getCheckoutPayments().retrievePaymentIntent(dead.paymentIntentId)).status).toBe("canceled");
      expect(await releaseRow(dead.paymentIntentId)).not.toBeNull();
    }
    for (const dead of unpaid) {
      expect((await getCheckoutPayments().retrievePaymentIntent(dead.paymentIntentId)).status).toBe("requires_payment_method");
    }
  });

  async function cartHolding(paymentIntentId: string, writtenAgoMs: number) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, paymentIntentId } });
    await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
      UPDATE carts SET updated_at = ${new Date(Date.now() - writtenAgoMs)} WHERE id = ${cart.id}
    `);
    return { cartId: cart.id, paymentIntentId };
  }

  function cartRow(id: string) {
    return storeScoped(storeId).cart.findUnique({ where: { id } });
  }

  it("stamps a cart whose check fails and clears one whose intent Stripe no longer has, so neither blocks a held card", async () => {
    await checkLeftoverCarts();
    const missing = [];
    for (let i = 0; i < 50; i += 1) missing.push(await cartHolding(`pi_fake_missing_${run}_${i}`, 2 * 60 * 60_000));
    const failing = [];
    for (let i = 0; i < 50; i += 1) failing.push(await deadCart(2 * 60 * 60_000));
    const held = await heldCart(61 * 60_000, 61 * 60_000);
    const failingIds = new Set(failing.map((c) => c.paymentIntentId));
    const payments = getCheckoutPayments();
    const realRetrieve = payments.retrievePaymentIntent.bind(payments);
    const retrieve = vi.spyOn(payments, "retrievePaymentIntent").mockImplementation(async (id) => {
      if (failingIds.has(id)) throw { type: "StripeAPIError", message: "upstream", statusCode: 500 };
      return realRetrieve(id);
    });
    try {
      for (let run = 0; run < 3; run += 1) await sweep();
    } finally {
      retrieve.mockRestore();
    }
    expect((await payments.retrievePaymentIntent(held.paymentIntentId)).status).toBe("canceled");
    for (const cart of missing) expect((await cartRow(cart.cartId))?.paymentIntentId).toBeNull();
    for (const cart of failing) {
      const row = await cartRow(cart.cartId);
      expect(row?.paymentIntentId).toBe(cart.paymentIntentId);
      expect(row?.orphanCheckedAt).not.toBeNull();
    }
  });

  it("cancels a cart stuck in requires_action for 24 h and clears carts whose intent is canceled or succeeded", async () => {
    const actionCart = async (writtenAgoMs: number) => {
      const cart = await deadCart(writtenAgoMs);
      await getCheckoutPayments().confirmPaymentIntent(cart.paymentIntentId, { payment_method: "pm_card_authenticationRequired" });
      return cart;
    };
    const dayOldAction = await actionCart(25 * 60 * 60_000);
    const recentAction = await actionCart(2 * 60 * 60_000);
    const canceled = await deadCart(2 * 60 * 60_000);
    await getCheckoutPayments().cancelPaymentIntent(canceled.paymentIntentId);
    const succeeded = await deadCart(2 * 60 * 60_000);
    const payments = getCheckoutPayments();
    const realRetrieve = payments.retrievePaymentIntent.bind(payments);
    const retrieve = vi.spyOn(payments, "retrievePaymentIntent").mockImplementation(async (id) => {
      const intent = await realRetrieve(id);
      return id === succeeded.paymentIntentId ? { ...intent, status: "succeeded" } : intent;
    });
    try {
      await sweep();
    } finally {
      retrieve.mockRestore();
    }
    expect((await payments.retrievePaymentIntent(dayOldAction.paymentIntentId)).status).toBe("canceled");
    for (const cart of [dayOldAction, canceled, succeeded]) {
      expect((await cartRow(cart.cartId))?.paymentIntentId).toBeNull();
      expect(await releaseRow(cart.paymentIntentId)).not.toBeNull();
    }
    expect((await payments.retrievePaymentIntent(recentAction.paymentIntentId)).status).toBe("requires_action");
    expect((await cartRow(recentAction.cartId))?.paymentIntentId).toBe(recentAction.paymentIntentId);
  });

  it("keeps the intent of a dead cart the shopper reopened after the sweep found it", async () => {
    const dead = await deadCart(25 * 60 * 60_000);
    const found = await findOrphanHoldCarts({ storeIds: [storeId] });
    expect(found.map((c) => c.cartId)).toContain(dead.cartId);
    const reopened = await prepareSignedInPaymentIntent(storeId, dead.cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect(reopened.paymentIntentId).toBe(dead.paymentIntentId);
    await releaseOrphanHolds(found);
    expect((await getCheckoutPayments().retrievePaymentIntent(dead.paymentIntentId)).status).toBe("requires_payment_method");
    expect((await cartRow(dead.cartId))?.paymentIntentId).toBe(dead.paymentIntentId);
    expect(await releaseRow(dead.paymentIntentId)).toBeNull();
  });

  it("reopening payment, signed in or as a guest, clears the sweep stamp", async () => {
    const signedIn = await deadCart(2 * 60 * 60_000);
    const guestCart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const guest = await createPaymentIntent(storeId, guestCart.id, 4200);
    for (const cart of [signedIn, { cartId: guestCart.id, paymentIntentId: guest.paymentIntentId }]) {
      await markOrphanHoldChecked(storeId, cart.cartId, cart.paymentIntentId);
      expect((await cartRow(cart.cartId))?.orphanCheckedAt).not.toBeNull();
    }
    await prepareSignedInPaymentIntent(storeId, signedIn.cartId, 4200, {
      actorUserId: userId,
      saveCard: false,
      savedCardId: null,
      attemptToken: null,
    }, storeAccountId);
    expect((await createPaymentIntent(storeId, guestCart.id, 4200)).paymentIntentId).toBe(guest.paymentIntentId);
    for (const id of [signedIn.cartId, guestCart.id]) expect((await cartRow(id))?.orphanCheckedAt).toBeNull();
  });

  it("another store can neither find nor stamp this store's held cart", async () => {
    const held = await heldCart(61 * 60_000, 61 * 60_000);
    const other = await platformAdmin.store.create({ data: { slug: `${run}-other`, name: "Other market" } });
    expect((await findOrphanHoldCarts({ storeIds: [other.id] })).map((c) => c.cartId)).not.toContain(held.cartId);
    await markOrphanHoldChecked(other.id, held.cartId, held.paymentIntentId);
    expect((await cartRow(held.cartId))?.orphanCheckedAt).toBeNull();
  });

  it("another store can neither read, change, delete nor forge this store's release row", async () => {
    const held = await heldCart(61 * 60_000, 61 * 60_000);
    await sweep();
    expect((await releaseRow(held.paymentIntentId))?.storeId).toBe(storeId);
    const other = await platformAdmin.store.create({ data: { slug: `${run}-release-other`, name: "Other market" } });
    const where = { paymentIntentId: held.paymentIntentId };
    await storeScopedTransaction(other.id, async (tx) => {
      expect(await tx.paymentIntentRelease.findUnique({ where })).toBeNull();
      expect(await tx.paymentIntentRelease.findMany({ where: { storeId } })).toEqual([]);
      expect((await tx.paymentIntentRelease.updateMany({ where, data: { storeId: other.id } })).count).toBe(0);
      expect((await tx.paymentIntentRelease.deleteMany({ where })).count).toBe(0);
    });
    await expect(storeScopedTransaction(other.id, (tx) =>
      tx.paymentIntentRelease.create({ data: { paymentIntentId: `pi_forged_${run}`, storeId } }),
    )).rejects.toThrow(/row-level security/);
    expect((await releaseRow(held.paymentIntentId))?.storeId).toBe(storeId);
    expect(await releaseRow(`pi_forged_${run}`)).toBeNull();
  });
});
