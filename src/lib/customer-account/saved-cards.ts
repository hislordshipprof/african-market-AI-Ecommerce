import { customerScoped } from "../db";
import { isCardExpired } from "./card-expiry";
import { CARD_NOT_FOUND, CARDS_UNAVAILABLE } from "./consent";
import { readStripeCustomerId } from "./stripe-customer";
import {
  checkoutPaymentsUseFake,
  getCheckoutPayments,
  type NormalizedCard,
} from "../stripe/checkout-payments";

export interface AccountCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  expired: boolean;
  reusable: boolean;
  created: number;
}

export interface AccountCardList {
  unavailable: boolean;
  cards: AccountCard[];
}

function configured(): boolean {
  return checkoutPaymentsUseFake() || Boolean(process.env.STRIPE_SECRET_KEY);
}

function missingCustomer(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; statusCode?: number; message?: string };
  return value.code === "resource_missing" || value.statusCode === 404 || (value.message ?? "").includes("No such customer");
}

function outage(error: unknown): boolean {
  if (missingCustomer(error)) return false;
  if (!error || typeof error !== "object") return true;
  const value = error as { statusCode?: number; type?: string; name?: string };
  const status = value.statusCode ?? 0;
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
    || value.type === "StripeConnectionError"
    || value.type === "StripeAPIError"
    || value.name === "StripeConnectionError";
}

export async function listAccountCards(userId: string, now = new Date()): Promise<AccountCardList> {
  if (!configured()) return { unavailable: true, cards: [] };
  const stripeCustomerId = await readStripeCustomerId(userId);
  if (!stripeCustomerId) return { unavailable: false, cards: [] };
  const payments = getCheckoutPayments();
  let methods: NormalizedCard[];
  try {
    methods = await payments.listCards(stripeCustomerId);
  } catch (error) {
    if (missingCustomer(error)) return { unavailable: false, cards: [] };
    if (outage(error)) return { unavailable: true, cards: [] };
    throw error;
  }
  const consents = await customerScoped(userId).cardSaveConsent.findMany({
    where: { userId, paymentMethodId: { not: null } },
  });
  const consented = new Set(consents.map((row) => row.paymentMethodId).filter((id): id is string => Boolean(id)));
  return {
    unavailable: false,
    cards: methods.slice(0, 100).map((card) => ({
      id: card.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      expired: isCardExpired(card.expMonth, card.expYear, now),
      reusable: consented.has(card.id),
      created: card.created,
    })),
  };
}

export async function removeAccountCard(userId: string, paymentMethodId: string): Promise<void> {
  if (!configured()) throw new Error(CARDS_UNAVAILABLE);
  const stripeCustomerId = await readStripeCustomerId(userId);
  const payments = getCheckoutPayments();
  let card: NormalizedCard;
  try {
    card = await payments.retrievePaymentMethod(paymentMethodId);
  } catch (error) {
    if (missingCustomer(error)) throw new Error(CARD_NOT_FOUND);
    throw error;
  }
  if (card.customer && card.customer !== stripeCustomerId) {
    throw new Error(CARD_NOT_FOUND);
  }
  if (!card.customer || card.detached) return;
  await payments.detachPaymentMethod(paymentMethodId);
  await customerScoped(userId).cardSaveConsent.deleteMany({
    where: { userId, paymentMethodId },
  });
}
