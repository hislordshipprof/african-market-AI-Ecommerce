import { NextResponse } from "next/server";
import { checkoutPaymentsUseFake, getCheckoutPayments } from "@/lib/stripe/checkout-payments";

/** Confirms a fake PaymentIntent. Closed unless the checkout fake is allowed. */
export async function POST(request: Request) {
  if (!checkoutPaymentsUseFake()) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const body = await request.json().catch(() => null) as {
    paymentIntentId?: string;
    paymentMethodId?: string | null;
  } | null;
  const paymentIntentId = body?.paymentIntentId;
  if (!paymentIntentId) {
    return NextResponse.json({ error: "paymentIntentId required" }, { status: 400 });
  }
  try {
    const intent = await getCheckoutPayments().confirmPaymentIntent(paymentIntentId, {
      payment_method: body?.paymentMethodId || "pm_card_visa",
    });
    return NextResponse.json({ status: intent.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment failed";
    return NextResponse.json({ error: message }, { status: 402 });
  }
}
