import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const bucket = vi.hoisted(() => new Map<string, { body: Uint8Array; contentType: string }>());
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Key: string; Body: Uint8Array; ContentType: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, { body: command.input.Body, contentType: command.input.ContentType });
        return {};
      }
      throw new Error("NoSuchKey");
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { markDelivered, markOutForDelivery } from "./service";
import { STORE_DELIVERY_ONLY } from "./delivery-proof";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests } from "../email/send";
import { clearTestSentSms, getTestSentSms, setSmsSenderForTests } from "../notifications/sms";
import { sendCustomerNotification } from "../inngest/functions";
import { makeFakeStep } from "../inngest/fake-step";

const hasDb = !!process.env.DATABASE_URL;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const handler = (sendCustomerNotification as unknown as {
  fn: (ctx: {
    event: { data: { storeId: string; orderId: string; event: string } };
    step: ReturnType<typeof makeFakeStep>;
  }) => Promise<unknown>;
}).fn;

describe.skipIf(!hasDb)("store delivery driver flow", () => {
  let raw: PrismaClient;
  let storeId = "";
  let otherStoreId = "";
  let number = 0;

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    const store = await raw.store.create({
      data: { slug: `t134-${stamp}`, name: "Ada's Market", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    });
    const other = await raw.store.create({
      data: { slug: `t134b-${stamp}`, name: "Other Market", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    });
    storeId = store.id;
    otherStoreId = other.id;
  });

  beforeEach(() => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    clearTestSentEmails();
    clearTestSentSms();
    setEmailSenderForTests(null);
    setSmsSenderForTests(null);
    bucket.clear();
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "test-bucket";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const id of [storeId, otherStoreId].filter(Boolean)) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeId, otherStoreId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  /** An order the store has picked, captured and packed: what markReady leaves behind. */
  async function readyOrder(fulfillment: "store-delivery" | "pickup" | "courier" = "store-delivery") {
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: "Ada", phone: "+13014482210", email: "ada@example.com" },
    });
    number += 1;
    return storeScoped(storeId).order.create({
      data: {
        storeId,
        customerId: customer.id,
        number,
        status: fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY",
        fulfillment,
        subtotalCents: 2000,
        deliveryFeeCents: 500,
        bufferCents: 250,
        totalCents: 2500,
        totalAuthorizedCents: 2750,
        capturedAmountCents: 2500,
        readyAt: new Date(),
        deliveryLine1: "3700 MAIN ST",
        deliveryCity: "HOUSTON",
        deliveryState: "TX",
        deliveryZip: "77002",
      },
    });
  }

  async function state(orderId: string) {
    const scoped = storeScoped(storeId);
    return {
      order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
      events: await scoped.deliveryEvent.findMany({ where: { orderId } }),
      notifications: await scoped.notificationLog.findMany({ where: { orderId } }),
    };
  }

  it("a ready store-delivery order goes out for delivery with one delivery event and pending email and SMS rows", async () => {
    const order = await readyOrder();
    expect(await markOutForDelivery(storeId, order.id)).toEqual({ ok: true });

    const after = await state(order.id);
    expect(after.order.status).toBe("OUT_FOR_DELIVERY");
    expect(after.order.outForDeliveryAt).toBeInstanceOf(Date);
    expect(after.events.map((event) => event.type)).toEqual(["out_for_delivery"]);
    expect(after.notifications.filter((row) => row.event === "out_for_delivery").map((row) => row.channel).sort())
      .toEqual(["email", "sms"]);
  });

  it("an order out for delivery is delivered with a photo: proof key, one delivery event, and a delivered SMS with the tracking link", async () => {
    const order = await readyOrder();
    expect(await markOutForDelivery(storeId, order.id)).toEqual({ ok: true });
    await handler({ event: { data: { storeId, orderId: order.id, event: "out_for_delivery" } }, step: makeFakeStep() });
    expect(getTestSentSms().at(-1)!.text).toContain(`order #${order.number} Out for delivery.`);
    expect(await markDelivered(storeId, order.id, JPEG)).toEqual({ ok: true });

    const after = await state(order.id);
    expect(after.order.status).toBe("DELIVERED");
    expect(after.order.deliveredAt).toBeInstanceOf(Date);
    expect(after.order.completedAt).toBeInstanceOf(Date);
    expect(after.order.deliveryProofUploadedAt).toBeInstanceOf(Date);
    expect(after.order.deliveryProofKey).toMatch(new RegExp(`^delivery-proof/${order.id}/\\d+\\.jpg$`));
    expect(bucket.get(after.order.deliveryProofKey!)?.contentType).toBe("image/jpeg");
    expect(after.events.map((event) => event.type).sort()).toEqual(["delivered", "out_for_delivery"]);
    expect(after.notifications.filter((row) => row.event === "delivered").map((row) => row.channel).sort())
      .toEqual(["email", "sms"]);

    await handler({ event: { data: { storeId, orderId: order.id, event: "delivered" } }, step: makeFakeStep() });
    const sms = getTestSentSms().at(-1)!;
    expect(sms.text).toContain(`order #${order.number} Delivered.`);
    expect(sms.text).toContain(`/order/${after.order.trackingToken}`);
    expect(getTestSentEmails().at(-1)!.html).toContain(`Delivered. Order #${order.number}.`);
  });

  it("delivered with no photo, a non-image, or a file over 8 MB is rejected and leaves the order out for delivery", async () => {
    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    const pdf = new TextEncoder().encode("%PDF-1.7 not a photo");
    const oversize = new Uint8Array(8 * 1024 * 1024 + 1);
    oversize.set(JPEG);
    for (const photo of [null, new Uint8Array(0), pdf, oversize]) {
      const result = await markDelivered(storeId, order.id, photo);
      expect(result.ok).toBe(false);
    }
    const after = await state(order.id);
    expect(after.order.status).toBe("OUT_FOR_DELIVERY");
    expect(after.order.deliveryProofKey).toBeNull();
    expect(after.events.map((event) => event.type)).toEqual(["out_for_delivery"]);
    expect(after.notifications.some((row) => row.event === "delivered")).toBe(false);
    expect(bucket.size).toBe(0);
  });

  it("ready to delivered, a pickup or courier order, and a repeated step are rejected with nothing recorded", async () => {
    const ready = await readyOrder();
    expect((await markDelivered(storeId, ready.id, JPEG)).ok).toBe(false);
    expect((await state(ready.id)).order.status).toBe("READY");

    for (const fulfillment of ["pickup", "courier"] as const) {
      const other = await readyOrder(fulfillment);
      expect(await markOutForDelivery(storeId, other.id)).toEqual({ ok: false, error: STORE_DELIVERY_ONLY });
      expect(await markDelivered(storeId, other.id, JPEG)).toEqual({ ok: false, error: STORE_DELIVERY_ONLY });
      const after = await state(other.id);
      expect(after.order.status).toBe(other.status);
      expect(after.events).toEqual([]);
    }

    expect(await markOutForDelivery(storeId, ready.id)).toEqual({ ok: true });
    expect((await markOutForDelivery(storeId, ready.id)).ok).toBe(false);
    expect(await markDelivered(storeId, ready.id, JPEG)).toEqual({ ok: true });
    expect((await markDelivered(storeId, ready.id, JPEG)).ok).toBe(false);
    const after = await state(ready.id);
    expect(after.order.status).toBe("DELIVERED");
    expect(after.events.map((event) => event.type).sort()).toEqual(["delivered", "out_for_delivery"]);
    expect(bucket.size).toBe(1);
  });

  it("store B's staff cannot send out or deliver store A's order", async () => {
    const order = await readyOrder();
    expect(await markOutForDelivery(otherStoreId, order.id)).toEqual({ ok: false, error: "Order not found" });
    await markOutForDelivery(storeId, order.id);
    expect(await markDelivered(otherStoreId, order.id, JPEG)).toEqual({ ok: false, error: "Order not found" });
    const after = await state(order.id);
    expect(after.order.status).toBe("OUT_FOR_DELIVERY");
    expect(after.events.map((event) => event.type)).toEqual(["out_for_delivery"]);
    expect(bucket.size).toBe(0);
  });
});

