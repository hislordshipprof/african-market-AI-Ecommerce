import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findDeliveryByExternalId, storeScopedTransaction } from "@/lib/db";
import { UberDirectProvider, UberWebhookSignatureError } from "@/lib/delivery/uber-direct";
import type { DeliveryWebhookEvent } from "@/lib/delivery/provider";
import { parseInput } from "@/lib/security/parse-input";

const eventIdsSchema = z.looseObject({
  externalDeliveryId: z.string().min(1).max(200),
  externalEventId: z.string().min(1).max(200),
});

export const dynamic = "force-dynamic";

/** Delivery statuses a webhook moves forward only; the courier_assigned step is what stops the failover timer (#140). */
const COURIER_PROGRESS = ["requested", "courier_assigned", "picked_up", "delivered"] as const;
type CourierProgress = (typeof COURIER_PROGRESS)[number];

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

  const delivery = await findDeliveryByExternalId("uber", event.externalDeliveryId);
  if (!delivery) {
    console.warn(JSON.stringify({ event: "uber_direct_webhook_unknown_delivery", externalDeliveryId: event.externalDeliveryId, externalEventId: event.externalEventId }));
    return NextResponse.json({ error: "Unknown delivery" }, { status: 404 });
  }
  if (!event.type) return NextResponse.json({ received: true, recorded: false });

  const type = event.type;
  await storeScopedTransaction(delivery.storeId, async (tx) => {
    await tx.deliveryEvent.createMany({
      data: [{
        storeId: delivery.storeId,
        orderId: delivery.orderId,
        deliveryId: delivery.id,
        externalEventId: event.externalEventId,
        type,
        payload: event.payload as object,
      }],
      skipDuplicates: true,
    });
    const step = COURIER_PROGRESS.indexOf(type as CourierProgress);
    if (step > 0) {
      await tx.delivery.updateMany({
        where: { id: delivery.id, status: { in: COURIER_PROGRESS.slice(0, step) } },
        data: { status: type },
      });
    }
  });
  return NextResponse.json({ received: true, recorded: true });
}
