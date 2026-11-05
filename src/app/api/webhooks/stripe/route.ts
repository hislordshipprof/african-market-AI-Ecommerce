import { NextRequest, NextResponse } from "next/server";
import { getStripeProvider } from "@/lib/stripe";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";
import { markTerminalRefundFailure } from "@/lib/order/service";
import { applyProviderRefund } from "@/lib/order/refund-requests";
import { isRetryableProviderError, WebhookSecretMissingError } from "@/lib/stripe/errors";
import type { RefundResult } from "@/lib/stripe/types";

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

  const accountEventTypes = [
    "account.updated",
    "v1.account.updated",
    "v2.core.account.updated",
    "v2.core.account[configuration.merchant].capability_status_updated",
    "v2.core.account.including.requirements.updated",
  ];
  if (accountEventTypes.includes(event.type) && event.accountId) {
    await updateStoreOnboardingStatus(event.accountId);
  }

  if (event.refund) {
    const provider = getStripeProvider();
    let refund: RefundResult;
    try {
      refund = await provider.retrieveRefund(event.refund.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "resource_missing") {
        refund = {
          refundId: event.refund.id,
          amountRefunded: 0,
          status: event.refund.status,
          ...(event.refund.reservationKey ? { reservationKey: event.refund.reservationKey } : {}),
        };
      } else if (isRetryableProviderError(err)) {
        return NextResponse.json({ error: "Refund could not be read" }, { status: 500 });
      } else {
        throw err;
      }
    }
    await applyProviderRefund({ ...refund, paymentIntentId: event.refund.paymentIntentId });
    if (refund.status === "failed" || refund.status === "canceled") {
      const settled = await markTerminalRefundFailure({
        paymentIntentId: event.refund.paymentIntentId,
        refundId: refund.refundId,
        refundStatus: refund.status,
      });
      if (!settled.ok && settled.retry) {
        return NextResponse.json({ error: settled.error }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
