import { NextRequest, NextResponse } from "next/server";
import { getStripeProvider } from "@/lib/stripe";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";

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

  let event;
  try {
    const provider = getStripeProvider();
    event = provider.verifyWebhookSignature({
      payload: rawBody,
      signature,
    });
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 },
    );
  }

  if (event.type === "account.updated") {
    await updateStoreOnboardingStatus(event.data.object.id);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
