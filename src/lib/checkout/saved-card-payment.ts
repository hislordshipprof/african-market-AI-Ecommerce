import { customerScoped } from "../db";
import { lockCart, lockStoreRow, storeScopedTransaction } from "../db";
import { isCardExpired } from "../customer-account/card-expiry";
import {
  SAVED_CARD_PURPOSE,
  SAVED_CARD_TERMS_VERSION,
  SAVED_CARD_UNAVAILABLE,
  cartPaymentIdempotencyKey,
} from "../customer-account/consent";
import { ensureStripeCustomer, readStripeCustomerId } from "../customer-account/stripe-customer";
import { getCheckoutPayments, type NormalizedPaymentIntent } from "../stripe/checkout-payments";
import {
  isReplaceablePaymentStatus,
  nextAttemptToken,
  planPaymentAttempt,
  selectionFingerprint,
  type ExistingPaymentIntent,
} from "./payment-intent-params";
import { checkoutTestHooks } from "./test-hooks";

export class SavedCardUnavailableError extends Error {
  readonly code = "saved_card_unavailable" as const;
  constructor() {
    super(SAVED_CARD_UNAVAILABLE);
    this.name = "SavedCardUnavailableError";
  }
}

export interface SignedInPaymentInput {
  actorUserId: string;
  saveCard: boolean;
  savedCardId: string | null;
  attemptToken: string | null;
}

function asExisting(intent: NormalizedPaymentIntent): ExistingPaymentIntent {
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    customer: intent.customer,
    setup_future_usage: intent.setup_future_usage,
    payment_method: intent.payment_method,
    client_secret: intent.client_secret,
    on_behalf_of: intent.on_behalf_of,
    transfer_data: intent.transfer_data,
    metadata: intent.metadata,
  };
}

function alreadyCanceled(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("status of canceled") || message.includes("already canceled") || message.includes("status canceled");
}

export async function cancelReplaceablePaymentIntent(
  payments: { retrievePaymentIntent: (id: string) => Promise<{ status: string }>; cancelPaymentIntent: (id: string, idempotencyKey?: string) => Promise<unknown> },
  paymentIntentId: string,
): Promise<void> {
  if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforeCancelPaymentIntent) {
    await checkoutTestHooks.beforeCancelPaymentIntent();
  }
  const fresh = await payments.retrievePaymentIntent(paymentIntentId);
  if (!isReplaceablePaymentStatus(fresh.status)) {
    throw new Error("Payment already confirmed for this cart");
  }
  try {
    await payments.cancelPaymentIntent(paymentIntentId, `cancel-${paymentIntentId}`);
  } catch (error) {
    if (!alreadyCanceled(error)) throw error;
  }
  const after = await payments.retrievePaymentIntent(paymentIntentId);
  if (after.status !== "canceled") {
    throw new Error("Payment already confirmed for this cart");
  }
}

async function usableSavedCard(userId: string, stripeCustomerId: string, savedCardId: string) {
  const payments = getCheckoutPayments();
  let card;
  try {
    card = await payments.retrievePaymentMethod(savedCardId);
  } catch {
    throw new SavedCardUnavailableError();
  }
  if (card.type !== "card" || card.detached || card.customer !== stripeCustomerId) {
    throw new SavedCardUnavailableError();
  }
  if (isCardExpired(card.expMonth, card.expYear, new Date())) {
    throw new SavedCardUnavailableError();
  }
  const consent = await customerScoped(userId).cardSaveConsent.findFirst({
    where: { userId, paymentMethodId: savedCardId },
  });
  if (!consent) throw new SavedCardUnavailableError();
  return card;
}

async function writeConsent(userId: string, paymentIntentId: string, stripeCustomerId: string): Promise<void> {
  const existing = await customerScoped(userId).cardSaveConsent.findFirst({
    where: { userId, paymentIntentId },
  });
  if (existing) return;
  await customerScoped(userId).cardSaveConsent.create({
    data: {
      userId,
      paymentIntentId,
      stripeCustomerId,
      termsVersion: SAVED_CARD_TERMS_VERSION,
      purpose: SAVED_CARD_PURPOSE,
    },
  });
}

async function clearConsent(userId: string, paymentIntentId: string): Promise<void> {
  await customerScoped(userId).cardSaveConsent.deleteMany({
    where: { userId, paymentIntentId, paymentMethodId: null },
  });
}

export async function prepareSignedInPaymentIntent(
  storeId: string,
  cartId: string,
  holdCents: number,
  input: SignedInPaymentInput,
  storeAccountId: string,
): Promise<{ clientSecret: string; paymentIntentId: string; attemptToken: string }> {
  const saveCard = Boolean(input.saveCard && !input.savedCardId);
  let stripeCustomerId: string | null = null;
  if (input.savedCardId) {
    stripeCustomerId = await readStripeCustomerId(input.actorUserId);
    if (!stripeCustomerId) throw new SavedCardUnavailableError();
    await usableSavedCard(input.actorUserId, stripeCustomerId, input.savedCardId);
  } else if (saveCard) {
    stripeCustomerId = await ensureStripeCustomer(input.actorUserId);
  }

  const fingerprint = selectionFingerprint({
    cartId,
    holdCents,
    stripeCustomerId,
    saveCard,
    paymentMethodId: input.savedCardId,
  });
  const payments = getCheckoutPayments();

  const prepared = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    const cart = await tx.cart.findUnique({ where: { id: cartId } });
    if (!cart || (cart.userId && cart.userId !== input.actorUserId)) {
      throw new Error("Cart not found");
    }
    const existing = cart.paymentIntentId
      ? asExisting(await payments.retrievePaymentIntent(cart.paymentIntentId))
      : null;
    const generation = nextAttemptToken({
      paymentIntentId: cart.paymentIntentId,
      storedToken: cart.paymentAttemptToken,
      fingerprint,
      forceNew: false,
    });
    const attemptKey = cartPaymentIdempotencyKey(cartId, generation);
    const plan = planPaymentAttempt({
      existing,
      holdCents,
      storeAccountId,
      storeId,
      cartId,
      selection: {
        actorUserId: input.actorUserId,
        stripeCustomerId,
        saveCard,
        paymentMethodId: input.savedCardId,
        attemptToken: input.attemptToken,
      },
      nextToken: generation,
      idempotencyKey: attemptKey,
    });
    if (plan.action === "blocked") {
      throw new Error("Payment already confirmed for this cart");
    }
    if (plan.action === "reuse") {
      return {
        clientSecret: plan.clientSecret,
        paymentIntentId: plan.paymentIntentId,
        attemptToken: plan.attemptToken,
        saved: existing?.setup_future_usage === "on_session",
      };
    }
    if (plan.action === "replace") {
      await cancelReplaceablePaymentIntent(payments, plan.cancelId);
    }
    if (plan.action === "create" || plan.action === "replace") {
      await tx.cart.update({
        where: { id: cartId },
        data: { paymentAttemptToken: generation, paymentIntentId: null },
      });
      const params = {
        ...plan.params,
        metadata: { ...plan.params.metadata, attempt_token: generation },
      };
      const intent = await payments.createPaymentIntent(params, attemptKey);
      if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforePersistCartPaymentIntent) {
        await checkoutTestHooks.beforePersistCartPaymentIntent();
      }
      await tx.cart.update({
        where: { id: cartId },
        data: { paymentIntentId: intent.id, paymentAttemptToken: generation },
      });
      if (!intent.client_secret) throw new Error("Stripe did not return a client secret");
      return {
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        attemptToken: generation,
        saved: intent.setup_future_usage === "on_session",
      };
    }
    const intent = await payments.updatePaymentIntent(plan.paymentIntentId, plan.params);
    if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforePersistCartPaymentIntent) {
      await checkoutTestHooks.beforePersistCartPaymentIntent();
    }
    await tx.cart.update({
      where: { id: cartId },
      data: {
        paymentIntentId: intent.id,
        paymentAttemptToken: plan.attemptToken,
      },
    });
    if (!intent.client_secret) throw new Error("Stripe did not return a client secret");
    return {
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      attemptToken: plan.attemptToken,
      saved: intent.setup_future_usage === "on_session",
    };
  }, { timeout: 20_000, maxWait: 8_000 });

  if (prepared.saved && stripeCustomerId) {
    await writeConsent(input.actorUserId, prepared.paymentIntentId, stripeCustomerId);
  } else if (!input.savedCardId) {
    await clearConsent(input.actorUserId, prepared.paymentIntentId);
  }
  return {
    clientSecret: prepared.clientSecret,
    paymentIntentId: prepared.paymentIntentId,
    attemptToken: prepared.attemptToken,
  };
}

export async function bindSavedCardConsent(
  userId: string,
  paymentIntentId: string,
  paymentMethodId: string | null,
): Promise<void> {
  if (!paymentMethodId) return;
  const row = await customerScoped(userId).cardSaveConsent.findFirst({
    where: { userId, paymentIntentId },
  });
  if (!row || row.paymentMethodId) return;
  await customerScoped(userId).cardSaveConsent.update({
    where: { id: row.id },
    data: { paymentMethodId },
  });
}
