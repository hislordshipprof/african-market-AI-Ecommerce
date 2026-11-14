import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { UberDirectProvider, UberWebhookSignatureError } from "@/lib/delivery/uber-direct";
import type { DeliveryWebhookEvent } from "@/lib/delivery/provider";
import { applyCourierWebhook } from "@/lib/delivery/webhook";
import { parseInput } from "@/lib/security/parse-input";

const eventIdsSchema = z.looseObject({
  externalDeliveryId: z.string().min(1).max(200),
  externalEventId: z.string().min(1).max(200),
});

export const dynamic = "force-dynamic";

/**
 * Uber Direct delivery events (https://developer.uber.com/docs/deliveries/guides/webhooks). Each signed event the
 * platform acts on becomes one delivery_events row; Uber's event id makes a retry a no-op. Uber retries only on
 * 5xx and timeouts, so a bad signature or body gets a 4xx it will not resend.
 */
export async function POST(req: NextRequest) {
  if (!process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY) {
    console.error(JSON.stringify({ event: "uber_direct_webhook_unconfigured", missing: "UBER_DIRECT_WEBHOOK_SIGNING_KEY" }));
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 500 });
  }
  const raw = await req.text();
  let event: DeliveryWebhookEvent;
  try {
    event = new UberDirectProvider().handleWebhook(raw, req.headers);
  } catch (error) {
    if (error instanceof UberWebhookSignatureError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Malformed webhook body" }, { status: 400 });
  }
  if (!parseInput(eventIdsSchema, event).ok) {
    return NextResponse.json({ error: "Malformed webhook body" }, { status: 400 });
  }

  const result = await applyCourierWebhook(event);
  if (result === "unknown_delivery") return NextResponse.json({ error: "Unknown delivery" }, { status: 404 });
  return NextResponse.json({ received: true, recorded: result !== "not_recorded" });
}
