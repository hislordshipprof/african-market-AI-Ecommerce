import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DoorDashDriveProvider, DoorDashWebhookAuthError } from "@/lib/delivery/doordash";
import type { DeliveryWebhookEvent } from "@/lib/delivery/provider";
import { applyCourierWebhook } from "@/lib/delivery/webhook";
import { parseInput } from "@/lib/security/parse-input";

const eventIdsSchema = z.looseObject({
  externalDeliveryId: z.string().min(1).max(200),
  externalEventId: z.string().min(1).max(300),
});

export const dynamic = "force-dynamic";

/**
 * DoorDash Drive delivery events (https://developer.doordash.com/en-US/docs/drive/reference/webhooks). DoorDash sends
 * the Authorization header set in the Developer Portal; anything else gets a 401 and no record. Each event the
 * platform acts on becomes one delivery_events row, so DoorDash's retries (up to 3 sends) change nothing twice.
 */
export async function POST(req: NextRequest) {
  if (!process.env.DOORDASH_WEBHOOK_AUTHORIZATION) {
    console.error(JSON.stringify({ event: "doordash_webhook_unconfigured", missing: "DOORDASH_WEBHOOK_AUTHORIZATION" }));
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 500 });
  }
  const raw = await req.text();
  let event: DeliveryWebhookEvent;
  try {
    event = new DoorDashDriveProvider().handleWebhook(raw, req.headers);
  } catch (error) {
    if (error instanceof DoorDashWebhookAuthError) return NextResponse.json({ error: error.message }, { status: 401 });
    return NextResponse.json({ error: "Malformed webhook body" }, { status: 400 });
  }
  if (!parseInput(eventIdsSchema, event).ok) return NextResponse.json({ error: "Malformed webhook body" }, { status: 400 });

  const result = await applyCourierWebhook(event);
  if (result === "unknown_delivery") return NextResponse.json({ error: "Unknown delivery" }, { status: 404 });
  return NextResponse.json({ received: true, recorded: result !== "not_recorded" });
}
