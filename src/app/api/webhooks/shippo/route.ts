import { NextRequest, NextResponse } from "next/server";
import { parseTrackUpdated, verifyShippoSignature } from "@/lib/shipping/shippo";
import { applyTrackingWebhook } from "@/lib/shipping/tracking";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Shippo `track_updated` events (https://docs.goshippo.com/api-reference/track.md), set in the Shippo dashboard.
 * Each must carry a valid `Shippo-Auth-Signature` HMAC made with SHIPPO_WEBHOOK_SECRET; anything else gets a 401 and
 * no record. A test-mode event is refused outside test keys, so a sandbox label never moves a real order.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.SHIPPO_WEBHOOK_SECRET;
  if (!secret) {
    console.error(JSON.stringify({ event: "shippo_webhook_unconfigured", missing: "SHIPPO_WEBHOOK_SECRET" }));
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 500 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Body too large" }, { status: 413 });
  if (!verifyShippoSignature(raw, req.headers.get("shippo-auth-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  const event = parseTrackUpdated(raw);
  if (!event) return NextResponse.json({ received: true, recorded: false });
  if (event.test && process.env.SHIPPO_API_KEY?.startsWith("shippo_live_")) {
    return NextResponse.json({ received: true, recorded: false });
  }
  const result = await applyTrackingWebhook(event);
  if (result === "unknown_label") return NextResponse.json({ error: "Unknown label" }, { status: 404 });
  return NextResponse.json({ received: true, recorded: result === "recorded" });
}
