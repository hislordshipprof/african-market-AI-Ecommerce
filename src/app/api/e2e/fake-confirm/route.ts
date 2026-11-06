import { NextResponse } from "next/server";
import { z } from "zod";
import { getCheckoutPayments } from "@/lib/stripe/checkout-payments";
import { parseInput } from "@/lib/security/parse-input";
import { testOnlyRoutesAllowed } from "@/lib/security/test-only-routes";

/** Closed unless this route's own flag passes the shared test-route gate. */
export function fakeConfirmRouteAllowed(
  env: Record<string, string | undefined>,
): boolean {
  return testOnlyRoutesAllowed(env, env.E2E_FAKE_STRIPE);
}

/** Confirms a fake PaymentIntent. The gate runs before parsing or the provider. */
export async function POST(request: Request) {
  if (!fakeConfirmRouteAllowed(process.env)) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  const parsed = parseInput(z.strictObject({
    paymentIntentId: z.string().min(1).max(200),
    paymentMethodId: z.string().max(200).nullable().optional(),
  }), body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "paymentIntentId required" }, { status: 400 });
  }
  try {
    const intent = await getCheckoutPayments().confirmPaymentIntent(parsed.data.paymentIntentId, {
      payment_method: parsed.data.paymentMethodId || "pm_card_visa",
    });
    return NextResponse.json({ status: intent.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment failed";
    return NextResponse.json({ error: message }, { status: 402 });
  }
}
