import { createHash, randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { getStripeClient } from "./provider";

export class CheckoutProviderError extends Error {
  readonly type: string;
  readonly code?: string;
  readonly statusCode: number;

  constructor(type: string, message: string, code?: string, statusCode = 400) {
    super(message);
    this.name = type;
    this.type = type;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface NormalizedCard {
  id: string;
  customer: string | null;
  type: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  allowRedisplay: string;
  detached: boolean;
  created: number;
  behavior: "ok" | "decline" | "action";
}

export interface NormalizedPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  customer: string | null;
  setup_future_usage: string | null;
  payment_method: string | null;
  client_secret: string | null;
  on_behalf_of: string | null;
  transfer_data: { destination: string | null } | null;
  metadata: Record<string, string>;
  capture_method: string | null;
  /** When the card hold was authorized, in ms; null when the intent holds nothing or `latest_charge` was not expanded. */
  authorized_at: number | null;
}

export interface CheckoutPayments {
  createCustomer(
    params: { metadata: { user_id: string } },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  retrieveCustomer(id: string): Promise<{ id: string; deleted: boolean }>;
  deleteCustomer(id: string): Promise<void>;
  listCards(customerId: string): Promise<NormalizedCard[]>;
  retrievePaymentMethod(id: string): Promise<NormalizedCard>;
  detachPaymentMethod(id: string): Promise<{ id: string }>;
  createPaymentIntent(
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<NormalizedPaymentIntent>;
  updatePaymentIntent(id: string, params: Record<string, unknown>): Promise<NormalizedPaymentIntent>;
  retrievePaymentIntent(id: string): Promise<NormalizedPaymentIntent>;
  cancelPaymentIntent(id: string, idempotencyKey?: string): Promise<{ id: string; status: string }>;
  confirmPaymentIntent(
    id: string,
    params?: { payment_method?: string },
  ): Promise<NormalizedPaymentIntent>;
}

interface FakeCustomer {
  id: string;
  metadata: { user_id: string };
  deleted: boolean;
}

interface IdempotencyRecord {
  hash: string;
  customerId: string;
  expired: boolean;
}

interface FakeLedger {
  customers: Map<string, FakeCustomer>;
  cards: Map<string, NormalizedCard>;
  intents: Map<string, NormalizedPaymentIntent>;
  intentModes: Map<string, "test" | "live">;
  idempotency: Map<string, IdempotencyRecord>;
  detachCalls: string[];
  calls: number;
  cardSeq: number;
  failNext: "timeout" | "500" | null;
}

// Server actions and route handlers can load this module twice. The fake
// ledger has to be one process-wide store or confirm cannot see the intent.
const ledger: FakeLedger = ((globalThis as { __fakeCheckoutLedger?: FakeLedger }).__fakeCheckoutLedger ??= {
  customers: new Map(),
  cards: new Map(),
  intents: new Map(),
  intentModes: new Map(),
  idempotency: new Map(),
  detachCalls: [],
  calls: 0,
  cardSeq: 0,
  failNext: null,
});
const { customers, cards, intents, intentModes, idempotency, detachCalls } = ledger;

const FIXTURES: Record<string, Pick<NormalizedCard, "brand" | "last4" | "expMonth" | "expYear" | "behavior">> = {
  pm_card_visa: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034, behavior: "ok" },
  pm_card_chargeCustomerFail: { brand: "visa", last4: "0341", expMonth: 12, expYear: 2034, behavior: "decline" },
  pm_card_authenticationRequired: { brand: "visa", last4: "3184", expMonth: 12, expYear: 2034, behavior: "action" },
};

function invalid(message: string, code?: string, statusCode = 400): CheckoutProviderError {
  return new CheckoutProviderError("StripeInvalidRequestError", message, code, statusCode);
}

/** Stripe's own test-mode values; the fake checks them so tests meet the errors Stripe would raise. */
const MIN_USD_AMOUNT_CENTS = 50;
const AMENDABLE_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

function assertAmount(amount: number): void {
  if (amount < MIN_USD_AMOUNT_CENTS) throw invalid("Amount must be at least $0.50 USD", "amount_too_small");
}

function hashParams(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

function emptyToNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

/** Stripe keeps test and live objects apart: a PaymentIntent made with one key is "No such payment_intent" to the other. */
function keyMode(): "test" | "live" {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key === "" || key.startsWith("sk_test_") || key.startsWith("rk_test_") ? "test" : "live";
}

/** Every call the fake has served since the last reset. */
export function fakeCheckoutCallCount(): number {
  return ledger.calls;
}

export function resetFakeCheckoutPayments(): void {
  ledger.calls = 0;
  intentModes.clear();
  customers.clear();
  cards.clear();
  intents.clear();
  idempotency.clear();
  detachCalls.length = 0;
  ledger.cardSeq = 0;
  ledger.failNext = null;
}

export function fakeDetachCalls(): string[] {
  return [...detachCalls];
}

export function expireFakeIdempotency(): void {
  for (const record of idempotency.values()) record.expired = true;
}

export function failNextFakeCustomerCreate(kind: "timeout" | "500"): void {
  ledger.failNext = kind;
}

/** The amount a fake checkout intent holds, or null when it holds nothing; the capture fake reads it. */
export function fakeCheckoutHoldCents(id: string): number | null {
  const intent = intents.get(id);
  return intent?.status === "requires_capture" ? intent.amount : null;
}

export function seedFakeCard(card: NormalizedCard): void {
  cards.set(card.id, card);
}

function fixtureFor(id: string): Pick<NormalizedCard, "brand" | "last4" | "expMonth" | "expYear" | "behavior"> {
  return FIXTURES[id] ?? { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034, behavior: "ok" };
}

function rememberCard(id: string, customer: string | null): NormalizedCard {
  const existing = cards.get(id);
  if (existing) return existing;
  const fixture = fixtureFor(id);
  const card: NormalizedCard = {
    id,
    customer,
    type: "card",
    allowRedisplay: "unspecified",
    detached: false,
    created: Date.now(),
    ...fixture,
  };
  cards.set(id, card);
  return card;
}

const fakeMethods: CheckoutPayments = {
  async createCustomer(params, idempotencyKey) {
    if (ledger.failNext === "timeout") {
      ledger.failNext = null;
      const error = new CheckoutProviderError("StripeConnectionError", "Request timed out", "timeout", 408);
      throw error;
    }
    if (ledger.failNext === "500") {
      ledger.failNext = null;
      throw new CheckoutProviderError("StripeAPIError", "Internal server error", "api_error", 500);
    }
    const hash = hashParams(params);
    const prior = idempotency.get(idempotencyKey);
    if (prior && !prior.expired) {
      if (prior.hash !== hash) {
        throw new CheckoutProviderError(
          "StripeIdempotencyError",
          "Keys for idempotent requests can only be used with the same parameters",
          "idempotency_error",
          400,
        );
      }
      return { id: prior.customerId };
    }
    const id = `cus_fake_${process.pid}_${randomBytes(8).toString("hex")}`;
    customers.set(id, { id, metadata: params.metadata, deleted: false });
    idempotency.set(idempotencyKey, { hash, customerId: id, expired: false });
    return { id };
  },

  async retrieveCustomer(id) {
    const customer = customers.get(id);
    if (!customer) {
      throw invalid(`No such customer: '${id}'`, "resource_missing", 404);
    }
    return { id: customer.id, deleted: customer.deleted };
  },

  async deleteCustomer(id) {
    const customer = customers.get(id);
    if (!customer) throw invalid(`No such customer: '${id}'`, "resource_missing", 404);
    customer.deleted = true;
  },

  async listCards(customerId) {
    const customer = customers.get(customerId);
    if (!customer || customer.deleted) {
      throw invalid(`No such customer: '${customerId}'`, "resource_missing", 404);
    }
    return [...cards.values()]
      .filter((card) => card.customer === customerId && !card.detached && card.type === "card")
      .sort((a, b) => b.created - a.created)
      .slice(0, 100)
      .map((card) => ({ ...card }));
  },

  async retrievePaymentMethod(id) {
    const card = cards.get(id);
    if (!card) throw invalid(`No such payment_method: '${id}'`, "resource_missing", 404);
    return { ...card };
  },

  async detachPaymentMethod(id) {
    const card = cards.get(id);
    if (!card) throw invalid(`No such payment_method: '${id}'`, "resource_missing", 404);
    if (card.detached || !card.customer) {
      throw invalid(
        "The payment method you provided is not attached to a customer so detachment is impossible.",
        undefined,
        400,
      );
    }
    detachCalls.push(id);
    card.customer = null;
    card.detached = true;
    return { id };
  },

  async createPaymentIntent(params, idempotencyKey) {
    const key = idempotencyKey ? `pi:${idempotencyKey}` : "";
    if (key) {
      const prior = idempotency.get(key);
      if (prior && !prior.expired) {
        const hash = hashParams(params);
        if (prior.hash !== hash) {
          throw new CheckoutProviderError(
            "StripeIdempotencyError",
            "Keys for idempotent requests can only be used with the same parameters",
            "idempotency_error",
            400,
          );
        }
        const existing = intents.get(prior.customerId);
        if (existing) return existing;
      }
    }
    const customerId = emptyToNull(params.customer);
    if (customerId) {
      const customer = customers.get(customerId);
      if (!customer || customer.deleted) {
        throw invalid(`No such customer: '${customerId}'`, "resource_missing", 404);
      }
    }
    assertAmount(Number(params.amount));
    const paymentMethodId = emptyToNull(params.payment_method);
    if (paymentMethodId) assertPaymentMethodUsable(paymentMethodId, customerId);
    const id = `pi_fake_${process.pid}_${randomBytes(8).toString("hex")}`;
    const metadata = (params.metadata ?? {}) as Record<string, string>;
    const transfer = params.transfer_data as { destination?: string } | undefined;
    const intent: NormalizedPaymentIntent = {
      id,
      status: "requires_payment_method",
      amount: Number(params.amount),
      currency: String(params.currency ?? "usd"),
      customer: customerId,
      setup_future_usage: emptyToNull(params.setup_future_usage),
      payment_method: paymentMethodId,
      client_secret: `${id}_secret_fake`,
      on_behalf_of: emptyToNull(params.on_behalf_of),
      transfer_data: transfer ? { destination: transfer.destination ?? null } : null,
      metadata: { ...metadata },
      capture_method: emptyToNull(params.capture_method),
      authorized_at: null,
    };
    intents.set(id, intent);
    intentModes.set(id, keyMode());
    if (key) idempotency.set(key, { hash: hashParams(params), customerId: id, expired: false });
    return intent;
  },

  async updatePaymentIntent(id, params) {
    const intent = requireIntent(id);
    if ("customer" in params) {
      const next = emptyToNull(params.customer);
      if (intent.customer && next && next !== intent.customer) {
        throw invalid("You cannot modify `customer` on a PaymentIntent once it already has been set.");
      }
      if (!intent.customer && next) intent.customer = next;
    }
    if ("amount" in params && params.amount != null) {
      if (!AMENDABLE_STATUSES.has(intent.status)) {
        throw invalid(
          `This PaymentIntent's amount could not be updated because it has a status of ${intent.status}. You may only update the amount of a PaymentIntent with one of the following statuses: requires_payment_method, requires_confirmation, requires_action.`,
          "payment_intent_unexpected_state",
        );
      }
      assertAmount(Number(params.amount));
      intent.amount = Number(params.amount);
      if (intent.status === "requires_action") intent.status = "requires_confirmation";
    }
    if ("setup_future_usage" in params) intent.setup_future_usage = emptyToNull(params.setup_future_usage);
    if ("payment_method" in params) {
      if (!AMENDABLE_STATUSES.has(intent.status)) {
        throw invalid(
          `You cannot provide a new payment method to a PaymentIntent when it has a status of ${intent.status}.`,
          "payment_intent_unexpected_state",
        );
      }
      intent.payment_method = emptyToNull(params.payment_method);
    }
    if (params.metadata && typeof params.metadata === "object") {
      intent.metadata = { ...intent.metadata, ...(params.metadata as Record<string, string>) };
    }
    return intent;
  },

  async retrievePaymentIntent(id) {
    return requireIntent(id);
  },

  async cancelPaymentIntent(id) {
    const intent = requireIntent(id);
    if (intent.status === "canceled") return { id, status: "canceled" };
    if (intent.status === "succeeded" || intent.status === "processing") {
      throw invalid(`You cannot cancel a PaymentIntent in status ${intent.status}.`);
    }
    intent.status = "canceled";
    return { id, status: "canceled" };
  },

  async confirmPaymentIntent(id, params) {
    const intent = requireIntent(id);
    if (
      intent.status === "canceled" ||
      intent.status === "requires_capture" ||
      intent.status === "succeeded" ||
      intent.status === "processing"
    ) {
      throw invalid(
        `You cannot confirm this PaymentIntent because it has a status of ${intent.status}.`,
        "payment_intent_unexpected_state",
      );
    }
    const paymentMethodId = params?.payment_method ?? intent.payment_method;
    if (!paymentMethodId) throw invalid("A payment method is required.");
    assertPaymentMethodUsable(paymentMethodId, intent.customer);
    const card = rememberCard(paymentMethodId, null);
    if (card.behavior === "decline") {
      intent.status = "requires_payment_method";
      throw new CheckoutProviderError("StripeCardError", "Your card was declined.", "card_declined", 402);
    }
    if (intent.setup_future_usage && intent.customer) {
      ledger.cardSeq += 1;
      const saved: NormalizedCard = {
        ...card,
        id: `pm_fake_${ledger.cardSeq}`,
        customer: intent.customer,
        detached: false,
        allowRedisplay: "always",
        created: Date.now(),
      };
      cards.set(saved.id, saved);
      intent.payment_method = saved.id;
    } else {
      intent.payment_method = paymentMethodId;
    }
    intent.status = card.behavior === "action" ? "requires_action" : "requires_capture";
    if (intent.status === "requires_capture") intent.authorized_at = Date.now();
    return intent;
  },
};

/** Counts every call, so a test can prove a path made none. */
export const fakeCheckoutPayments: CheckoutPayments = Object.fromEntries(
  Object.entries(fakeMethods).map(([name, method]) => [
    name,
    (...args: unknown[]) => {
      ledger.calls += 1;
      return (method as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as CheckoutPayments;

function requireIntent(id: string): NormalizedPaymentIntent {
  const intent = intents.get(id);
  if (!intent || intentModes.get(id) !== keyMode()) {
    throw invalid(`No such payment_intent: '${id}'`, "resource_missing", 404);
  }
  return intent;
}

function assertPaymentMethodUsable(id: string, customerId: string | null): void {
  const card = cards.get(id);
  if (card?.detached) {
    throw invalid(
      "The provided PaymentMethod was previously used without being attached to a Customer or was detached from a Customer. It may not be used again.",
    );
  }
  if (card?.customer && customerId && card.customer !== customerId) {
    throw invalid(
      `The PaymentMethod ${id} does not belong to the Customer you supplied. Please use a PaymentMethod that belongs to the Customer.`,
    );
  }
  if (card?.customer && !customerId) {
    throw invalid(
      "The provided PaymentMethod belongs to a Customer. Please include the Customer.",
      "parameter_missing",
    );
  }
}

function checkoutFakeAllowed(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.E2E_FAKE_STRIPE !== "1") return false;
  if (process.env.CI === "true") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * The authorization time of the intent's hold: the expanded `latest_charge`'s
 * `created`. One intent is reused per cart, so the intent's own `created` can be
 * far older than its hold.
 */
export function holdAuthorizedAt(intent: Pick<Stripe.PaymentIntent, "latest_charge">): number | null {
  const charge = intent.latest_charge;
  if (!charge || typeof charge === "string") return null;
  return charge.created * 1000;
}

function normalizeStripeIntent(intent: Stripe.PaymentIntent): NormalizedPaymentIntent {
  const destination = intent.transfer_data?.destination;
  const paymentMethod = intent.payment_method;
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    customer: typeof intent.customer === "string" ? intent.customer : intent.customer?.id ?? null,
    setup_future_usage: intent.setup_future_usage,
    payment_method: typeof paymentMethod === "string" ? paymentMethod : paymentMethod?.id ?? null,
    client_secret: intent.client_secret,
    on_behalf_of: typeof intent.on_behalf_of === "string" ? intent.on_behalf_of : intent.on_behalf_of?.id ?? null,
    transfer_data: intent.transfer_data
      ? { destination: typeof destination === "string" ? destination : destination?.id ?? null }
      : null,
    metadata: intent.metadata ?? {},
    capture_method: intent.capture_method,
    authorized_at: holdAuthorizedAt(intent),
  };
}

function stripeCheckoutPayments(): CheckoutPayments {
  const stripe = () => getStripeClient();
  return {
    async createCustomer(params, idempotencyKey) {
      const customer = await stripe().customers.create(
        { metadata: params.metadata },
        { idempotencyKey },
      );
      return { id: customer.id };
    },
    async retrieveCustomer(id) {
      const customer = await stripe().customers.retrieve(id);
      return { id: customer.id, deleted: "deleted" in customer && customer.deleted === true };
    },
    async deleteCustomer(id) {
      await stripe().customers.del(id);
    },
    async listCards(customerId) {
      const page = await stripe().customers.listPaymentMethods(customerId, { type: "card", limit: 100 });
      return page.data.map((method, index) => ({
        id: method.id,
        customer: typeof method.customer === "string" ? method.customer : method.customer?.id ?? null,
        type: method.type,
        brand: method.card?.brand ?? "unknown",
        last4: method.card?.last4 ?? "",
        expMonth: method.card?.exp_month ?? 0,
        expYear: method.card?.exp_year ?? 0,
        allowRedisplay: method.allow_redisplay ?? "unspecified",
        detached: false,
        created: method.created * 1000 + (100 - index),
        behavior: "ok" as const,
      }));
    },
    async retrievePaymentMethod(id) {
      const method = await stripe().paymentMethods.retrieve(id);
      return {
        id: method.id,
        customer: typeof method.customer === "string" ? method.customer : method.customer?.id ?? null,
        type: method.type,
        brand: method.card?.brand ?? "unknown",
        last4: method.card?.last4 ?? "",
        expMonth: method.card?.exp_month ?? 0,
        expYear: method.card?.exp_year ?? 0,
        allowRedisplay: method.allow_redisplay ?? "unspecified",
        detached: false,
        created: method.created * 1000,
        behavior: "ok",
      };
    },
    async detachPaymentMethod(id) {
      await stripe().paymentMethods.detach(id);
      return { id };
    },
    async createPaymentIntent(params, idempotencyKey) {
      const intent = await stripe().paymentIntents.create(
        params as unknown as Stripe.PaymentIntentCreateParams,
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return normalizeStripeIntent(intent);
    },
    async updatePaymentIntent(id, params) {
      const intent = await stripe().paymentIntents.update(id, params as Stripe.PaymentIntentUpdateParams);
      return normalizeStripeIntent(intent);
    },
    async retrievePaymentIntent(id) {
      return normalizeStripeIntent(await stripe().paymentIntents.retrieve(id));
    },
    async cancelPaymentIntent(id, idempotencyKey) {
      const intent = await stripe().paymentIntents.cancel(id, undefined, idempotencyKey ? { idempotencyKey } : undefined);
      return { id: intent.id, status: intent.status };
    },
    async confirmPaymentIntent(id, params) {
      const intent = await stripe().paymentIntents.confirm(id, {
        payment_method: params?.payment_method,
      });
      return normalizeStripeIntent(intent);
    },
  };
}

export function getCheckoutPayments(): CheckoutPayments {
  if (checkoutFakeAllowed()) return fakeCheckoutPayments;
  return stripeCheckoutPayments();
}

export function checkoutPaymentsUseFake(): boolean {
  return checkoutFakeAllowed();
}
