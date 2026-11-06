import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findOrderByPaymentIntent } from "@/lib/db";
import { getStripeProvider } from "@/lib/stripe";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";
import { markTerminalRefundFailure } from "@/lib/order/service";
import { applyProviderRefund, evaluateOrderRefundState } from "@/lib/order/refund-requests";
import { isRetryableProviderError, WebhookSecretMissingError } from "@/lib/stripe/errors";
import type { RefundResult } from "@/lib/stripe/types";
import { parseInput } from "@/lib/security/parse-input";

const webhookEventSchema = z.looseObject({
  type: z.string().min(1).max(200),
  accountId: z.string().max(200),
  refund: z.looseObject({
    id: z.string().min(1).max(200),
    status: z.string().min(1).max(40),
    paymentIntentId: z.string().min(1).max(200),
    reservationKey: z.string().max(200).optional(),
  }).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const rawBody = await req.text();

  const production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  if (production && !process.env.STRIPE_WEBHOOK_SECRET?.trim()) {
    console.error("STRIPE_WEBHOOK_SECRET");
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 },
    );
  }

  let event;
  try {
    const provider = getStripeProvider();
    event = provider.verifyWebhookSignature({
      payload: rawBody,
      signature,
    });
  } catch (err) {
    const production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
    if (production && err instanceof WebhookSecretMissingError) {
      console.error("STRIPE_WEBHOOK_SECRET");
      return NextResponse.json(
        { error: "Webhook secret is not configured" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 },
    );
  }

  const parsed = parseInput(webhookEventSchema, event);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
  const verified = parsed.data;

  const accountEventTypes = [
    "account.updated",
    "v1.account.updated",
    "v2.core.account.updated",
    "v2.core.account[configuration.merchant].capability_status_updated",
    "v2.core.account.including.requirements.updated",
  ];
  if (accountEventTypes.includes(verified.type) && verified.accountId) {
    await updateStoreOnboardingStatus(verified.accountId);
  }

  if (verified.refund) {
    const provider = getStripeProvider();
    let refund: RefundResult;
    try {
      refund = await provider.retrieveRefund(verified.refund.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "resource_missing") {
        refund = {
          refundId: verified.refund.id,
          amountRefunded: 0,
          status: verified.refund.status,
          ...(verified.refund.reservationKey ? { reservationKey: verified.refund.reservationKey } : {}),
        };
      } else if (isRetryableProviderError(err)) {
        return NextResponse.json({ error: "Refund could not be read" }, { status: 500 });
      } else {
        throw err;
      }
    }
    try {
      await applyProviderRefund({ ...refund, paymentIntentId: verified.refund.paymentIntentId });
      const refundedOrder = await findOrderByPaymentIntent(verified.refund.paymentIntentId);
      if (refundedOrder) await evaluateOrderRefundState(refundedOrder.id);
      if (refund.status === "failed" || refund.status === "canceled") {
        const settled = await markTerminalRefundFailure({
          paymentIntentId: verified.refund.paymentIntentId,
          refundId: refund.refundId,
          refundStatus: refund.status,
        });
        if (!settled.ok && settled.retry) {
          return NextResponse.json({ error: settled.error }, { status: 500 });
        }
      }
    } catch (err) {
      console.error(err);
      return NextResponse.json({ error: "Refund could not be recorded" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
