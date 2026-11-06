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
  type PaymentIntentCreateParams,
} from "./payment-intent-params";
import { assertAssistantAttempt, AssistantCheckoutInProgressError } from "./assistant-attempt-guard";
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
  assistantAttemptId?: string | null;
  idempotencyKey?: string | null;
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
}

function savedCardProviderUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; statusCode?: number; message?: string; type?: string };
  if (value.statusCode === 408 || (value.statusCode ?? 0) >= 500) return false;
  if (value.type === "StripeConnectionError" || value.type === "StripeAPIError") return false;
  const message = (value.message ?? "").toLowerCase();
  if (value.code === "resource_missing") return true;
  return message.includes("detached")
    || message.includes("not attached")
    || message.includes("no such payment_method")
    || message.includes("no such paymentmethod");
}

async function usableSavedCard(userId: string, stripeCustomerId: string, savedCardId: string) {
  const payments = getCheckoutPayments();
  let card;
  try {
    card = await payments.retrievePaymentMethod(savedCardId);
  } catch (error) {
    if (savedCardProviderUnavailable(error)) throw new SavedCardUnavailableError();
    throw error;
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

async function finishSignedInCreate(
  storeId: string,
  cartId: string,
  payments: ReturnType<typeof getCheckoutPayments>,
  reserved: {
    params: PaymentIntentCreateParams;
    attemptKey: string;
    generation: string;
  },
  savedCardId: string | null,
): Promise<{ clientSecret: string; paymentIntentId: string; attemptToken: string; saved: boolean }> {
  let intent;
  try {
    intent = await payments.createPaymentIntent(reserved.params as unknown as Record<string, unknown>, reserved.attemptKey);
  } catch (error) {
    if (savedCardId && savedCardProviderUnavailable(error)) throw new SavedCardUnavailableError();
    throw error;
  }
  if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforePersistCartPaymentIntent) {
    await checkoutTestHooks.beforePersistCartPaymentIntent();
  }
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    const current = await tx.cart.findUnique({ where: { id: cartId } });
    if (!current || current.paymentAttemptToken !== reserved.generation) return;
    await tx.cart.update({
      where: { id: cartId },
      data: { paymentIntentId: intent.id, paymentAttemptToken: reserved.generation },
    });
  });
  if (!intent.client_secret) throw new Error("Stripe did not return a client secret");
  return {
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    attemptToken: reserved.generation,
    saved: intent.setup_future_usage === "on_session",
  };
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

  const reserved = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    const assistantOwner = await assertAssistantAttempt(tx, cartId, input.assistantAttemptId);
    const cart = await tx.cart.findUnique({ where: { id: cartId } });
    if (!cart || (cart.userId && cart.userId !== input.actorUserId)) {
      throw new Error("Cart not found");
    }
    const existing = cart.paymentIntentId
      ? asExisting(await payments.retrievePaymentIntent(cart.paymentIntentId))
      : null;
    const generation = input.idempotencyKey ?? nextAttemptToken({
      paymentIntentId: cart.paymentIntentId,
      storedToken: cart.paymentAttemptToken,
      fingerprint,
      forceNew: false,
    });
    const attemptKey = input.idempotencyKey ?? cartPaymentIdempotencyKey(cartId, generation);
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
    if (assistantOwner && (plan.action === "replace" || (existing != null && existing.amount !== assistantOwner.reservedAmountCents))) {
      throw new AssistantCheckoutInProgressError();
    }
    if (plan.action === "reuse") {
      return {
        kind: "ready" as const,
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
      return {
        kind: "create" as const,
        params: {
          ...plan.params,
          metadata: {
            ...plan.params.metadata,
            attempt_token: generation,
            purchase_epoch: String(cart.purchaseEpoch),
          },
        },
        attemptKey,
        generation,
      };
    }
    const intent = await payments.updatePaymentIntent(plan.paymentIntentId, {
      ...plan.params,
      metadata: {
        ...(plan.params.metadata as Record<string, string> | undefined),
        purchase_epoch: String(cart.purchaseEpoch),
      },
    });
    await tx.cart.update({
      where: { id: cartId },
      data: {
        paymentIntentId: intent.id,
        paymentAttemptToken: plan.attemptToken,
      },
    });
    if (!intent.client_secret) throw new Error("Stripe did not return a client secret");
    return {
      kind: "ready" as const,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      attemptToken: plan.attemptToken,
      saved: intent.setup_future_usage === "on_session",
    };
  }, { timeout: 20_000, maxWait: 8_000 });

  const prepared = reserved.kind === "ready"
    ? reserved
    : await finishSignedInCreate(storeId, cartId, payments, reserved, input.savedCardId);

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
  if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforeBindSavedCardConsent) {
    await checkoutTestHooks.beforeBindSavedCardConsent();
  }
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
