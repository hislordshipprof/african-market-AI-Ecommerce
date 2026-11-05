import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, customerScoped, platformAdmin, storeScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { computeQuote, placeOrder } from "./service";
import { prepareSignedInPaymentIntent } from "./saved-card-payment";
import { checkoutTestHooks } from "./test-hooks";

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
    await authPrisma.user.deleteMany({ where: { id: { startsWith: "user-t248-attempt-" } } });
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
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const stores = await platformAdmin.store.findMany({
      where: { slug: { startsWith: "t248-attempt-" } },
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
    await authPrisma.user.deleteMany({ where: { id: { startsWith: "user-t248-attempt-" } } });
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
    const holdCents = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], contact, "pickup").holdCents;
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
});
