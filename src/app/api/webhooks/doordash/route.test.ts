import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { copyCourierProof } from "@/lib/delivery/proof";
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

  it("AC5: a standard drop-off stores the proof photo URL, marks the order delivered and copies the photo to the private bucket", async () => {
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

    const { default: sharp } = await import("sharp");
    const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#6b8e23" } }).png().toBuffer();
    const uploads: string[] = [];
    const previousBucket = process.env.R2_PROOF_BUCKET;
    process.env.R2_PROOF_BUCKET = "proof-test";
    try {
      const deps = {
        fetch: async (url: string | URL | Request) => {
          expect(String(url)).toBe("https://doordash-static.s3.amazonaws.com/proof.jpg");
          return new Response(new Uint8Array(photo), { headers: { "content-type": "image/png" } });
        },
        upload: async (key: string) => {
          uploads.push(key);
        },
      };
      expect(await copyCourierProof(storeId, deliveryId, deps)).toBe("copied");
      expect(await copyCourierProof(storeId, deliveryId, deps)).toBe("skipped");
    } finally {
      if (previousBucket === undefined) delete process.env.R2_PROOF_BUCKET;
      else process.env.R2_PROOF_BUCKET = previousBucket;
    }
    expect(uploads).toEqual([expect.stringMatching(new RegExp(`^delivery-proof/${orderId}/`))]);
    expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } })).deliveryProofKey).toBe(uploads[0]);
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

  describe("proof photo copy refuses what a courier provider would not send", () => {
    const previousBucket = process.env.R2_PROOF_BUCKET;
    beforeAll(() => {
      process.env.R2_PROOF_BUCKET = "proof-test";
    });
    afterAll(() => {
      if (previousBucket === undefined) delete process.env.R2_PROOF_BUCKET;
      else process.env.R2_PROOF_BUCKET = previousBucket;
    });

    async function deliveredWithProof(proofUrl: string) {
      const { orderId, deliveryId } = await courierOrder({ deliveryStatus: "delivered" });
      await storeScoped(storeId).delivery.update({ where: { id: deliveryId }, data: { proofUrl } });
      return { orderId, deliveryId };
    }

    it("a proof URL on a host outside the providers' image hosts is never fetched", async () => {
      const uploads: string[] = [];
      for (const url of ["http://169.254.169.254/latest/meta-data/", "https://evil.example/doordash.com/p.jpg", "https://doordash.com.evil.example/p.jpg"]) {
        const { orderId, deliveryId } = await deliveredWithProof(url);
        const fetched: string[] = [];
        const deps = {
          fetch: async (input: string | URL | Request) => {
            fetched.push(String(input));
            return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
          },
          upload: async (key: string) => {
            uploads.push(key);
          },
        };
        expect(await copyCourierProof(storeId, deliveryId, deps)).toBe("skipped");
        expect(fetched).toEqual([]);
        expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } })).deliveryProofKey).toBeNull();
      }
      expect(uploads).toEqual([]);
    });

    it("a proof body with no Content-Length stops being read once it passes the photo cap", async () => {
      const { orderId, deliveryId } = await deliveredWithProof("https://doordash-static.s3.amazonaws.com/huge.jpg");
      const chunk = new Uint8Array(1024 * 1024);
      let pulled = 0;
      let cancelled = false;
      const huge = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= 64 * 1024 * 1024) return controller.close();
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const uploads: string[] = [];
      const deps = {
        fetch: async () => new Response(huge, { headers: { "content-type": "image/jpeg" } }),
        upload: async (key: string) => {
          uploads.push(key);
        },
      };
      expect(await copyCourierProof(storeId, deliveryId, deps)).toBe("skipped");
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(uploads).toEqual([]);
      expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } })).deliveryProofKey).toBeNull();
    });
  });
});
