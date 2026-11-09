import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";
import { readWhatsAppConfig } from "@/lib/whatsapp/config";
import { messageRef } from "@/lib/whatsapp/code";
import { handleInboundMessage } from "@/lib/whatsapp/inbound";
import { verifyWhatsAppSignature } from "@/lib/whatsapp/signature";
import { extractWebhook, whatsappWebhookSchema } from "@/lib/whatsapp/webhook-payload";

export const dynamic = "force-dynamic";

/** Meta's documented webhook payload ceiling [unverified, #143]. */
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const challengeSchema = z.object({
  mode: z.literal("subscribe"),
  token: z.string().min(1).max(256),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
});

function sameToken(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(): NextResponse {
  return new NextResponse("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
}

/** Meta's subscription challenge. Echoes hub.challenge only for the configured verify token. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const parsed = parseInput(challengeSchema, {
    mode: params.get("hub.mode"),
    token: params.get("hub.verify_token"),
    challenge: params.get("hub.challenge"),
  });
  const { verifyToken } = readWhatsAppConfig();
  if (!parsed.ok || !verifyToken || !sameToken(parsed.data.token, verifyToken)) return forbidden();
  return new NextResponse(parsed.data.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Inbound messages and statuses. Order: app secret configured (503), size
 * (413), signature over the raw bytes (401), then parse. After a valid
 * signature every answer is 200 unless handling failed (500, so Meta
 * redelivers); a 4xx would be retried for days.
 */
export async function POST(req: NextRequest) {
  const { appSecret, phoneNumberId } = readWhatsAppConfig();
  if (!appSecret) {
    console.error(JSON.stringify({ event: "whatsapp_webhook_secret_missing" }));
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  if (!verifyWhatsAppSignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
  const parsed = parseInput(whatsappWebhookSchema, json);
  if (!parsed.ok) {
    console.warn(JSON.stringify({ event: "whatsapp_webhook_unparsed" }));
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const { messages, failedStatusCodes, unreadableMessages } = extractWebhook(parsed.data, phoneNumberId);
  if (unreadableMessages > 0) {
    console.warn(JSON.stringify({ event: "whatsapp_message_unparsed", count: unreadableMessages }));
  }
  for (const code of failedStatusCodes) {
    console.warn(JSON.stringify({ event: "whatsapp_delivery_failed", code }));
  }

  for (const message of messages) {
    try {
      await handleInboundMessage(message);
    } catch (error) {
      console.error(JSON.stringify({
        event: "whatsapp_inbound_failed",
        message: messageRef(message.id),
        error: error instanceof Error ? error.name : "unknown",
      }));
      return NextResponse.json({ error: "Could not handle message" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
