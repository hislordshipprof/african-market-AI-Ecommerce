import Stripe from "stripe";
import type {
  StripeProvider,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
  CaptureResult,
  CancelResult,
  RetrieveResult,
  RefundResult,
  Payout,
  PayoutTransaction,
} from "./types";
import { ProviderStateError } from "./types";
import { billingObjects } from "../billing/webhook-objects";
import { RefundNotCreatedError, WebhookSecretMissingError, mapRefundStatus, overRefundError } from "./errors";

let _stripeClient: Stripe | null = null;

// Stripe's autoPagingToArray maximum; a real order never has this many refunds.
const REFUND_LIST_CAP = 10_000;

export function getStripeClient(): Stripe {
  if (_stripeClient) return _stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Stripe operations require this key at runtime.",
    );
  }
  _stripeClient = new Stripe(key);
  return _stripeClient;
}

function webhookSecrets(): string[] {
  const raw = process.env.STRIPE_WEBHOOK_SECRET;
  if (!raw?.trim()) throw new WebhookSecretMissingError();
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toConnectAccount(account: any): ConnectAccount {
  const merchantCaps = account.configuration?.merchant?.capabilities;
  const chargesEnabled = merchantCaps?.card_payments?.status === "active";
  const payoutsEnabled =
    merchantCaps?.stripe_balance?.payouts?.status === "active";

  const requirementEntries: Array<{
    awaiting_action_from: string;
    description: string;
  }> = account.requirements?.entries ?? [];
  const userRequirements = requirementEntries
    .filter((e) => e.awaiting_action_from === "user")
    .map((e) => e.description);

  const detailsSubmitted =
    userRequirements.length === 0 &&
    account.configuration?.merchant?.applied === true;

  return {
    accountId: account.id,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    requirementsCurrentlyDue: userRequirements,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toPayout(payout: Stripe.Payout): Payout {
  return { id: payout.id, amountCents: payout.amount, arrivalDate: payout.arrival_date, status: payout.status };
}

/**
 * The platform PaymentIntent behind a balance transaction on the store's account. A payment is the
 * transfer's charge (`py_`); a refund points at that charge. Destination charges name the
 * transfer group `group_<PaymentIntent id>`.
 */
function payoutPaymentIntentId(txn: Stripe.BalanceTransaction): string | null {
  const source = txn.source as Stripe.Charge | Stripe.Refund | string | null;
  if (!source || typeof source === "string") return null;
  const charge = source.object === "refund" ? source.charge : source;
  if (!charge || typeof charge === "string") return null;
  const transfer = charge.source_transfer;
  if (!transfer || typeof transfer === "string") return null;
  const platformCharge = transfer.source_transaction;
  if (platformCharge && typeof platformCharge !== "string" && "payment_intent" in platformCharge) {
    const intent = platformCharge.payment_intent;
    if (intent) return typeof intent === "string" ? intent : intent.id;
  }
  const group = transfer.transfer_group?.match(/^group_(pi_\w+)$/);
  return group ? group[1] : null;
}

// Stripe's autoPagingToArray maximum; a weekly payout is far below it.
const PAYOUT_TRANSACTION_CAP = 10_000;

export const stripeProvider: StripeProvider = {
  async createConnectAccount({ email, businessName, storeId }) {
    const stripe = getStripeClient();
    const account = await stripe.v2.core.accounts.create({
      contact_email: email,
      display_name: businessName,
      dashboard: "express",
      metadata: { platform_store_id: storeId },
      identity: {
        country: "US",
        entity_type: "company",
      },
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { requested: true },
          },
        },
      },
      defaults: {
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      include: ["configuration.merchant", "requirements"],
    });
    return toConnectAccount(account);
  },

  async createAccountLink({ accountId, returnUrl, refreshUrl }) {
    const stripe = getStripeClient();
    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          refresh_url: refreshUrl,
          return_url: returnUrl,
        },
      },
    });
    return { url: link.url } satisfies AccountLinkResult;
  },

  async getAccount(accountId) {
    const stripe = getStripeClient();
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant", "requirements"],
    });
    return toConnectAccount(account);
  },

  verifyWebhookSignature({ payload, signature }) {
    const stripe = getStripeClient();
    const secrets = webhookSecrets();
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        const event = stripe.webhooks.constructEvent(payload, signature, secret);
        const obj = event.data?.object as {
          id?: string;
          object?: string;
          status?: string | null;
          payment_intent?: string | { id?: string };
          cancellation_reason?: string | null;
          metadata?: { reservation?: string };
        } | undefined;
        const paymentIntentId =
          typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
        const reservationKey = typeof obj?.metadata?.reservation === "string" ? obj.metadata.reservation : undefined;
        const refund =
          obj?.object === "refund" && obj.id && paymentIntentId
            ? {
                id: obj.id,
                status: mapRefundStatus(obj.status),
                paymentIntentId,
                ...(reservationKey ? { reservationKey } : {}),
              }
            : undefined;
        const paymentIntent =
          obj?.object === "payment_intent" && obj.id && obj.status
            ? { id: obj.id, status: obj.status, cancellationReason: obj.cancellation_reason ?? null }
            : undefined;
        return {
          type: event.type,
          accountId: obj?.id ?? event.account ?? "",
          eventId: event.id,
          created: event.created,
          ...(refund ? { refund } : {}),
          ...(paymentIntent ? { paymentIntent } : {}),
          ...billingObjects(event.data?.object),
        } satisfies WebhookEvent;
      } catch (err) {
        lastError = err;
      }
    }
    for (const secret of secrets) {
      try {
        const notification = stripe.parseEventNotification(payload, signature, secret);
        return {
          type: notification.type,
          accountId:
            ("related_object" in notification
              ? (notification.related_object as { id?: string } | null)?.id
              : undefined) ?? "",
        } satisfies WebhookEvent;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Invalid webhook signature");
  },

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey, applicationFeeAmount) {
    const stripe = getStripeClient();
    try {
      const pi = await stripe.paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amountCents,
        ...(applicationFeeAmount ? { application_fee_amount: applicationFeeAmount } : {}),
      }, idempotencyKey ? { idempotencyKey } : undefined);
      return {
        paymentIntentId: pi.id,
        amountCaptured: pi.amount_received,
        status: pi.status,
      } satisfies CaptureResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "payment_intent_unexpected_state") {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === "succeeded") {
          return {
            paymentIntentId: pi.id,
            amountCaptured: pi.amount_received,
            status: pi.status,
          } satisfies CaptureResult;
        }
        throw new ProviderStateError("capture", pi.status);
      }
      throw err;
    }
  },

  async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
    const stripe = getStripeClient();
    try {
      const pi = await stripe.paymentIntents.cancel(paymentIntentId, {},
        idempotencyKey ? { idempotencyKey } : undefined);
      return {
        paymentIntentId: pi.id,
        status: pi.status,
      } satisfies CancelResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "payment_intent_unexpected_state") {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === "canceled") {
          return {
            paymentIntentId: pi.id,
            status: pi.status,
          } satisfies CancelResult;
        }
        throw new ProviderStateError("cancel", pi.status);
      }
      throw err;
    }
  },

  async retrievePaymentIntent(paymentIntentId) {
    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    const charge = pi.latest_charge;
    const amountRefunded =
      charge && typeof charge !== "string" ? (charge.amount_refunded ?? 0) : 0;
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      amountCapturable: pi.amount_capturable ?? 0,
      amountReceived: pi.amount_received ?? 0,
      amountRefunded,
    } satisfies RetrieveResult;
  },

  async listRefunds(paymentIntentId) {
    const stripe = getStripeClient();
    const listed = await stripe.refunds
      .list({ payment_intent: paymentIntentId, limit: 100 })
      .autoPagingToArray({ limit: REFUND_LIST_CAP });
    if (listed.length >= REFUND_LIST_CAP) {
      console.error(JSON.stringify({ event: "stripe_refund_list_cap_reached" }));
    }
    return listed.map((refund) => ({
      refundId: refund.id,
      amountRefunded: refund.amount,
      status: mapRefundStatus(refund.status),
      ...(typeof refund.metadata?.reservation === "string"
        ? { reservationKey: refund.metadata.reservation }
        : {}),
      ...(typeof refund.metadata?.order_id === "string"
        ? { orderId: refund.metadata.order_id }
        : {}),
    })) satisfies RefundResult[];
  },

  async retrieveRefund(refundId) {
    const stripe = getStripeClient();
    const refund = await stripe.refunds.retrieve(refundId);
    return {
      refundId: refund.id,
      amountRefunded: refund.amount,
      status: mapRefundStatus(refund.status),
      ...(typeof refund.metadata?.reservation === "string"
        ? { reservationKey: refund.metadata.reservation }
        : {}),
      ...(typeof refund.metadata?.order_id === "string"
        ? { orderId: refund.metadata.order_id }
        : {}),
    } satisfies RefundResult;
  },

  async listPayouts(accountId, limit) {
    const stripe = getStripeClient();
    const payouts = await stripe.payouts.list({ limit }, { stripeAccount: accountId });
    return payouts.data.map(toPayout);
  },

  async retrievePayout(accountId, payoutId) {
    const stripe = getStripeClient();
    return toPayout(await stripe.payouts.retrieve(payoutId, {}, { stripeAccount: accountId }));
  },

  async listPayoutTransactions(accountId, payoutId) {
    const stripe = getStripeClient();
    const listed = await stripe.balanceTransactions
      .list(
        {
          payout: payoutId,
          limit: 100,
          expand: ["data.source.source_transfer.source_transaction", "data.source.charge.source_transfer"],
        },
        { stripeAccount: accountId },
      )
      .autoPagingToArray({ limit: PAYOUT_TRANSACTION_CAP });
    return listed
      .filter((txn) => txn.type !== "payout")
      .map((txn) => ({
        id: txn.id,
        type: txn.type,
        amountCents: txn.amount,
        feeCents: txn.fee,
        netCents: txn.net,
        paymentIntentId: payoutPaymentIntentId(txn),
      })) satisfies PayoutTransaction[];
  },

  async createLoginLink(accountId) {
    const stripe = getStripeClient();
    const link = await stripe.accounts.createLoginLink(accountId);
    return { url: link.url };
  },

  async refundApplicationFeePart(paymentIntentId, amountCents, reservationKey) {
    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const fee = charge?.application_fee;
    const feeId = typeof fee === "string" ? fee : fee?.id;
    if (!feeId) throw new Error(`Payment ${paymentIntentId} has no application fee to refund`);
    // The idempotency key lasts 24h; the metadata match stops a later replay from paying twice.
    for await (const prior of stripe.applicationFees.listRefunds(feeId, { limit: 100 })) {
      if (prior.metadata?.reservation === reservationKey) return { feeRefundId: prior.id };
    }
    const refund = await stripe.applicationFees.createRefund(
      feeId,
      { amount: amountCents, metadata: { reservation: reservationKey } },
      { idempotencyKey: `${reservationKey}:service-fee` },
    );
    return { feeRefundId: refund.id };
  },

  async refundPayment(paymentIntentId, amountCents, idempotencyKey, options) {
    const stripe = getStripeClient();
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountCents,
          reverse_transfer: true,
          ...(options?.refundApplicationFee ? { refund_application_fee: true } : {}),
          ...(options?.reservationKey || options?.orderId
            ? {
                metadata: {
                  ...(options.reservationKey ? { reservation: options.reservationKey } : {}),
                  ...(options.orderId ? { order_id: options.orderId } : {}),
                },
              }
            : {}),
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return {
        refundId: refund.id,
        amountRefunded: refund.amount,
        status: mapRefundStatus(refund.status),
        ...(options?.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options?.orderId ? { orderId: options.orderId } : {}),
      } satisfies RefundResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "charge_already_refunded") {
        throw new RefundNotCreatedError("charge_already_refunded", err.message);
      }
      const over = overRefundError(err);
      if (over) throw over;
      throw err;
    }
  },
};
