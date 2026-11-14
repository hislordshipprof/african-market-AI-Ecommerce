import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { POST } from "./route";

const authorization = "Basic ZG9vcmRhc2g6cm91dGUtdGVzdA==";

function post(raw: string, auth?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth !== undefined) headers.set("authorization", auth);
  return POST(new NextRequest("http://localhost/api/webhooks/doordash", { method: "POST", body: raw, headers }));
}

// Body fields from https://developer.doordash.com/en-US/docs/drive/reference/webhooks
const event = (externalId: string, eventName: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_name: eventName,
    external_delivery_id: externalId,
    created_at: `2026-11-13T15:${String(10 + eventName.length).padStart(2, "0")}:00Z`,
    tracking_url: `https://doordash.com/tracking?id=${externalId}`,
    ...extra,
  });

describe.skipIf(!process.env.DATABASE_URL)("POST /api/webhooks/doordash", () => {
  let raw: PrismaClient;
  let storeId = "";
  let customerId = "";
  let number = 0;
  const previous = process.env.DOORDASH_WEBHOOK_AUTHORIZATION;

  async function courierOrder(opts: { pin?: string; deliveryStatus?: string } = {}) {
    const scoped = storeScoped(storeId);
    const order = await scoped.order.create({
      data: { storeId, customerId, status: "COURIER_REQUESTED", fulfillment: "courier", subtotalCents: 6000, bufferCents: 0, totalCents: 6000, totalAuthorizedCents: 6000, number: ++number },
    });
    const externalId = `${order.id}-doordash-${number}`;
    const delivery = await scoped.delivery.create({
      data: { storeId, orderId: order.id, provider: "doordash", externalId, status: opts.deliveryStatus ?? "requested", quoteFeeCents: 899, pin: opts.pin ?? null },
    });
    return { orderId: order.id, deliveryId: delivery.id, externalId };
  }
  const orderStatus = async (id: string) => (await storeScoped(storeId).order.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    process.env.DOORDASH_WEBHOOK_AUTHORIZATION = authorization;
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    storeId = (await raw.store.create({ data: { slug: `dd-hook-${stamp}`, name: "DoorDash Hook Market", themePreset: "palm-and-shea" } })).id;
    customerId = (await storeScoped(storeId).customer.create({ data: { storeId, name: "Hook Buyer", email: `dd-hook-${stamp}@example.com` } })).id;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.DOORDASH_WEBHOOK_AUTHORIZATION;
    else process.env.DOORDASH_WEBHOOK_AUTHORIZATION = previous;
    if (storeId) {
      const scoped = storeScoped(storeId);
      await scoped.notificationLog.deleteMany({});
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await raw.store.deleteMany({ where: { id: storeId } });
    }
    await raw.$disconnect();
  });

  it("AC1/AC3: an authorized Dasher assignment records one event, assigns the courier and advances the order once, however often DoorDash resends it", async () => {
    const { orderId, deliveryId, externalId } = await courierOrder();
    const body = event(externalId, "DASHER_CONFIRMED", { dasher_name: "John D.", dasher_vehicle_make: "Toyota", dasher_vehicle_model: "Corolla" });

    expect((await post(body, authorization)).status).toBe(200);
    await storeScoped(storeId).order.update({ where: { id: orderId }, data: { status: "PICKED_UP" } });
    expect((await post(body, authorization)).status).toBe(200);

    expect(await storeScoped(storeId).deliveryEvent.findMany({ where: { deliveryId } })).toMatchObject([{ type: "courier_assigned" }]);
    expect(await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: deliveryId } })).toMatchObject({
      status: "courier_assigned",
      courierJson: { name: "John D.", vehicle: "Toyota Corolla" },
    });
    // The replay changed nothing: the order is where the later step put it.
    expect(await orderStatus(orderId)).toBe("PICKED_UP");
  });

  it("AC2: a missing or wrong Authorization header gets 401 and records nothing", async () => {
    const { orderId, deliveryId, externalId } = await courierOrder();
    const body = event(externalId, "DASHER_CONFIRMED");
    expect((await post(body)).status).toBe(401);
    expect((await post(body, "Basic d3Jvbmc=")).status).toBe(401);
    expect(await storeScoped(storeId).deliveryEvent.count({ where: { deliveryId } })).toBe(0);
    expect(await orderStatus(orderId)).toBe("COURIER_REQUESTED");
  });

  it("AC5: a standard drop-off stores the proof photo URL and marks the order delivered", async () => {
    const { orderId, deliveryId, externalId } = await courierOrder({ deliveryStatus: "picked_up" });
    const body = event(externalId, "DASHER_DROPPED_OFF", { fee: 899, dropoff_verification_image_url: "https://doordash-static.s3.amazonaws.com/proof.jpg" });

    expect((await post(body, authorization)).status).toBe(200);

    expect(await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: deliveryId } })).toMatchObject({
      status: "delivered",
      actualFeeCents: 899,
      proofUrl: "https://doordash-static.s3.amazonaws.com/proof.jpg",
    });
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("DELIVERED");
    expect(order.deliveredAt).not.toBeNull();
  });

  it("a delivery replaced by failover records its events but never moves the order; a return leaves the order for the store", async () => {
    const cancelled = await courierOrder({ deliveryStatus: "cancelled" });
    expect((await post(event(cancelled.externalId, "DASHER_CONFIRMED"), authorization)).status).toBe(200);
    expect(await orderStatus(cancelled.orderId)).toBe("COURIER_REQUESTED");

    const returned = await courierOrder({ deliveryStatus: "picked_up" });
    await storeScoped(storeId).order.update({ where: { id: returned.orderId }, data: { status: "PICKED_UP" } });
    expect((await post(event(returned.externalId, "DELIVERY_RETURNED"), authorization)).status).toBe(200);
    expect((await storeScoped(storeId).delivery.findUniqueOrThrow({ where: { id: returned.deliveryId } })).status).toBe("returned");
    expect(await orderStatus(returned.orderId)).toBe("PICKED_UP");
  });
});
