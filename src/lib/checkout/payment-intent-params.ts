import { randomUUID } from "node:crypto";

export interface PaymentIntentCreateParams {
  amount: number;
  currency: "usd";
  capture_method: "manual";
  on_behalf_of: string;
  transfer_data: { destination: string };
  metadata: {
    store_id: string;
    cart_id: string;
    attempt_token?: string;
    user_id?: string;
    purchase_epoch?: string;
  };
  customer?: string;
  setup_future_usage?: "on_session";
  payment_method?: string;
}

export interface PaymentSelection {
  /** Null for a guest. */
  actorUserId: string | null;
  stripeCustomerId: string | null;
  saveCard: boolean;
  paymentMethodId: string | null;
  attemptToken: string | null;
}

export interface ExistingPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string | null;
  customer: string | null;
  setup_future_usage: string | null;
  payment_method: string | null;
  client_secret: string | null;
  on_behalf_of?: string | null;
  transfer_data?: { destination: string | null } | null;
  metadata: {
    store_id?: string;
    cart_id?: string;
    attempt_token?: string;
    user_id?: string;
    purchase_epoch?: string;
  };
}

const OPENABLE = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
const SETTLED = new Set(["requires_capture", "processing", "succeeded"]);

export function isReplaceablePaymentStatus(status: string): boolean {
  return OPENABLE.has(status);
}

/**
 * A stored token is reused only to recover a create that never recorded its
 * PaymentIntent. A live, canceled, or replaced attempt gets a new generation
 * so Stripe cannot replay the previous create.
 */
export function nextAttemptToken(input: {
  paymentIntentId: string | null;
  storedToken: string | null;
  fingerprint: string;
  forceNew: boolean;
}): string {
  if (
    !input.forceNew &&
    !input.paymentIntentId &&
    input.storedToken?.endsWith(`:${input.fingerprint}`)
  ) {
    return input.storedToken;
  }
  return `gen:${randomUUID()}:${input.fingerprint}`;
}

export function paymentIntentProvenanceOk(
  existing: Pick<ExistingPaymentIntent, "currency" | "metadata"> & {
    on_behalf_of?: string | null;
    transfer_data?: { destination?: string | null } | null;
  },
  expected: { storeId: string; cartId: string; storeAccountId: string },
): boolean {
  if (existing.metadata.store_id !== expected.storeId) return false;
  if (existing.metadata.cart_id !== expected.cartId) return false;
  if (existing.currency && existing.currency !== "usd") return false;
  if (existing.on_behalf_of && existing.on_behalf_of !== expected.storeAccountId) return false;
  const destination = existing.transfer_data?.destination;
  if (destination && destination !== expected.storeAccountId) return false;
  return true;
}

export function guestPaymentIntentParams(input: {
  holdCents: number;
  storeAccountId: string;
  storeId: string;
  cartId: string;
}): PaymentIntentCreateParams {
  return {
    amount: input.holdCents,
    currency: "usd",
    capture_method: "manual",
    on_behalf_of: input.storeAccountId,
    transfer_data: { destination: input.storeAccountId },
    metadata: { store_id: input.storeId, cart_id: input.cartId },
  };
}

function baseParams(input: {
  holdCents: number;
  storeAccountId: string;
  storeId: string;
  cartId: string;
  actorUserId: string | null;
  stripeCustomerId: string | null;
  saveCard: boolean;
  paymentMethodId: string | null;
  attemptToken: string;
}): PaymentIntentCreateParams {
  const save = Boolean(input.saveCard && !input.paymentMethodId && input.stripeCustomerId);
  const params: PaymentIntentCreateParams = {
    ...guestPaymentIntentParams(input),
  };
  if (input.actorUserId) {
    params.metadata = {
      ...params.metadata,
      attempt_token: input.attemptToken,
    };
  }
  if (input.paymentMethodId && input.stripeCustomerId) {
    params.customer = input.stripeCustomerId;
    params.payment_method = input.paymentMethodId;
    if (input.actorUserId) params.metadata = { ...params.metadata, user_id: input.actorUserId };
    return params;
  }
  if (save && input.stripeCustomerId) {
    params.customer = input.stripeCustomerId;
    params.setup_future_usage = "on_session";
    if (input.actorUserId) params.metadata = { ...params.metadata, user_id: input.actorUserId };
  }
  return params;
}

export type AttemptPlan =
  | { action: "create"; params: PaymentIntentCreateParams; idempotencyKey: string; attemptToken: string }
  | { action: "update"; paymentIntentId: string; params: Record<string, unknown>; attemptToken: string }
  | { action: "replace"; cancelId: string; params: PaymentIntentCreateParams; idempotencyKey: string; attemptToken: string }
  | { action: "reuse"; paymentIntentId: string; clientSecret: string; attemptToken: string }
  | { action: "blocked"; reason: "already_confirmed" };

function fingerprint(input: {
  holdCents: number;
  stripeCustomerId: string | null;
  saveCard: boolean;
  paymentMethodId: string | null;
}): string {
  const save = Boolean(input.saveCard && !input.paymentMethodId);
  return [
    input.holdCents,
    input.stripeCustomerId ?? "",
    save ? "save" : "nosave",
    input.paymentMethodId ?? "",
  ].join("|");
}

/**
 * Guest creates use guestPaymentIntentParams and nothing else.
 * The same selection reuses the PaymentIntent. A capability change
 * (save, customer, or payment method) starts a new one.
 * A PaymentIntent for another cart or store is left untouched.
 * requires_capture, processing and succeeded are never cancelled.
 */
export function planPaymentAttempt(input: {
  existing: ExistingPaymentIntent | null;
  holdCents: number;
  storeAccountId: string;
  storeId: string;
  cartId: string;
  selection: PaymentSelection;
  nextToken: string;
  idempotencyKey: string;
}): AttemptPlan {
  const selection = {
    ...input.selection,
    saveCard: Boolean(input.selection.saveCard && !input.selection.paymentMethodId),
  };
  const signedIn = Boolean(selection.actorUserId);
  const createParams = baseParams({
    holdCents: input.holdCents,
    storeAccountId: input.storeAccountId,
    storeId: input.storeId,
    cartId: input.cartId,
    actorUserId: selection.actorUserId,
    stripeCustomerId: selection.stripeCustomerId,
    saveCard: selection.saveCard,
    paymentMethodId: selection.paymentMethodId,
    attemptToken: input.nextToken,
  });

  if (
    input.existing &&
    !paymentIntentProvenanceOk(input.existing, {
      storeId: input.storeId,
      cartId: input.cartId,
      storeAccountId: input.storeAccountId,
    })
  ) {
    return {
      action: "create",
      params: signedIn ? createParams : guestPaymentIntentParams(input),
      idempotencyKey: input.idempotencyKey,
      attemptToken: input.nextToken,
    };
  }

  if (!input.existing || input.existing.status === "canceled") {
    return {
      action: "create",
      params: signedIn ? createParams : guestPaymentIntentParams(input),
      idempotencyKey: input.idempotencyKey,
      attemptToken: input.nextToken,
    };
  }

  if (SETTLED.has(input.existing.status)) {
    return { action: "blocked", reason: "already_confirmed" };
  }

  if (!OPENABLE.has(input.existing.status)) {
    return { action: "blocked", reason: "already_confirmed" };
  }

  const desiredCustomer = selection.paymentMethodId || selection.saveCard ? selection.stripeCustomerId : null;
  const customerClash =
    Boolean(input.existing.customer) &&
    desiredCustomer != null &&
    input.existing.customer !== desiredCustomer;
  const guestFacingCustomer =
    !signedIn && Boolean(input.existing.customer);

  if (customerClash || guestFacingCustomer) {
    return {
      action: "replace",
      cancelId: input.existing.id,
      params: signedIn ? createParams : guestPaymentIntentParams(input),
      idempotencyKey: input.idempotencyKey,
      attemptToken: input.nextToken,
    };
  }

  const tokenMatches =
    signedIn &&
    selection.attemptToken != null &&
    selection.attemptToken === input.existing.metadata.attempt_token;

  const desiredSave = selection.saveCard;
  const existingSave = input.existing.setup_future_usage === "on_session";
  const capabilitiesMatch =
    existingSave === desiredSave &&
    (input.existing.payment_method ?? null) === (selection.paymentMethodId ?? null) &&
    (input.existing.customer ?? null) === (desiredCustomer ?? null);

  if (!signedIn) {
    if (input.existing.amount === input.holdCents && !input.existing.customer && !input.existing.setup_future_usage && !input.existing.payment_method) {
      return {
        action: "reuse",
        paymentIntentId: input.existing.id,
        clientSecret: input.existing.client_secret ?? "",
        attemptToken: input.nextToken,
      };
    }
    if (!input.existing.customer && !input.existing.payment_method && !input.existing.setup_future_usage) {
      return {
        action: "update",
        paymentIntentId: input.existing.id,
        params: { amount: input.holdCents },
        attemptToken: input.nextToken,
      };
    }
    return {
      action: "replace",
      cancelId: input.existing.id,
      params: guestPaymentIntentParams(input),
      idempotencyKey: input.idempotencyKey,
      attemptToken: input.nextToken,
    };
  }

  if (capabilitiesMatch && (tokenMatches || selection.attemptToken == null)) {
    if (input.existing.amount !== input.holdCents) {
      return {
        action: "update",
        paymentIntentId: input.existing.id,
        params: { amount: input.holdCents },
        attemptToken: input.existing.metadata.attempt_token ?? input.nextToken,
      };
    }
    return {
      action: "reuse",
      paymentIntentId: input.existing.id,
      clientSecret: input.existing.client_secret ?? "",
      attemptToken: input.existing.metadata.attempt_token ?? input.nextToken,
    };
  }

  return {
    action: "replace",
    cancelId: input.existing.id,
    params: createParams,
    idempotencyKey: input.idempotencyKey,
    attemptToken: input.nextToken,
  };
}

export function selectionFingerprint(input: {
  cartId: string;
  holdCents: number;
  stripeCustomerId: string | null;
  saveCard: boolean;
  paymentMethodId: string | null;
}): string {
  return fingerprint({
    holdCents: input.holdCents,
    stripeCustomerId: input.saveCard || input.paymentMethodId ? input.stripeCustomerId : null,
    saveCard: input.saveCard,
    paymentMethodId: input.paymentMethodId,
  });
}
