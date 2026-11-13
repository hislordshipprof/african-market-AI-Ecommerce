import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { POST } from "./route";

const signingKey = "whsec-route-test-key";

function post(raw: string, signature?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== undefined) headers.set("x-uber-signature", signature);
  return POST(new NextRequest("http://localhost/api/webhooks/uber-direct", { method: "POST", body: raw, headers }));
}

const sign = (raw: string, key = signingKey) => createHmac("sha256", key).update(raw).digest("hex");

describe.skipIf(!process.env.DATABASE_URL)("POST /api/webhooks/uber-direct", () => {
  let raw: PrismaClient;
  let storeId = "";
  let deliveryId = "";
  let externalId = "";
  const previousKey = process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY;

  const event = (status: string, id = `evt_${status}_${externalId}`) =>
    JSON.stringify({
      kind: "event.delivery_status",
      id,
      delivery_id: externalId,
      status,
      created: "2026-11-13T15:10:00Z",
      live_mode: false,
      data: { id: externalId, status, fee: 799, tracking_url: `https://www.ubereats.com/orders/${externalId}` },
    });

  beforeAll(async () => {
    process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY = signingKey;
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    externalId = `del_${stamp}`;
    storeId = (await raw.store.create({ data: { slug: `uber-hook-${stamp}`, name: "Uber Hook Market", themePreset: "palm-and-shea" } })).id;
    const scoped = storeScoped(storeId);
    const customer = await scoped.customer.create({ data: { storeId, name: "Hook Buyer", email: `uber-hook-${stamp}@example.com` } });
    const order = await scoped.order.create({
      data: {
        storeId,
        customerId: customer.id,
        status: "OUT_FOR_DELIVERY",
        fulfillment: "courier",
        subtotalCents: 100,
        bufferCents: 0,
        totalCents: 100,
        totalAuthorizedCents: 100,
        number: 1,
      },
    });
    deliveryId = (await scoped.delivery.create({
      data: { storeId, orderId: order.id, provider: "uber", externalId, status: "requested", quoteFeeCents: 799 },
    })).id;
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY;
    else process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY = previousKey;
    if (storeId) {
      const scoped = storeScoped(storeId);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await raw.store.deleteMany({ where: { id: storeId } });
    }
    await raw.$disconnect();
  });

  it("a courier assignment moves the delivery to courier_assigned, so the failover timer cannot claim it", async () => {
    const body = event("pickup");
    expect((await post(body, sign(body))).status).toBe(200);
    expect((await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe("courier_assigned");
  });

  it("records a signed delivery status event once, however often Uber retries it", async () => {
    const body = event("pickup_complete");
    expect((await post(body, sign(body))).status).toBe(200);
    expect((await post(body, sign(body))).status).toBe(200);

    const rows = await storeScoped(storeId).deliveryEvent.findMany({ where: { deliveryId, type: "picked_up" } });
    expect(rows).toMatchObject([{ storeId, deliveryId, type: "picked_up", externalEventId: `evt_pickup_complete_${externalId}` }]);
  });

  it("rejects a missing or wrong signature with 401 and a malformed signed body with 400, recording nothing", async () => {
    const body = event("delivered");
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body, "another-key"))).status).toBe(401);
    expect((await post(body, sign(event("canceled")))).status).toBe(401);
    expect((await post("{not json", sign("{not json"))).status).toBe(400);
    expect(await storeScoped(storeId).deliveryEvent.count({ where: { type: { in: ["delivered", "cancelled"] } } })).toBe(0);
  });
});
