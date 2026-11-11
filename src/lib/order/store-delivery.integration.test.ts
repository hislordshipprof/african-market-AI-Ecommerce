import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const bucket = vi.hoisted(() => new Map<string, { body: Uint8Array; contentType: string; bucket: string }>());
const afterPut = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, { body: command.input.Body, contentType: command.input.ContentType, bucket: command.input.Bucket });
        await afterPut.run?.();
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        if (bucket.get(command.input.Key)?.bucket !== command.input.Bucket) throw new Error("NoSuchKey");
        bucket.delete(command.input.Key);
        return {};
      }
      throw new Error("NoSuchKey");
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { markDelivered, markOutForDelivery } from "./service";
import { PROOF_PHOTO_MISSING, PROOF_PHOTO_NOT_IMAGE, PROOF_PHOTO_TOO_LARGE, PROOF_STORAGE_NOT_SET_UP, STORE_DELIVERY_ONLY } from "./delivery-proof";
import { CSV_ACTION_BODY_LIMIT_BYTES } from "../listing/csv-file-cap";
import sharp from "sharp";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests } from "../email/send";
import { clearTestSentSms, getTestSentSms, setSmsSenderForTests } from "../notifications/sms";
import { sendCustomerNotification } from "../inngest/functions";
import { makeFakeStep } from "../inngest/fake-step";

const hasDb = !!process.env.DATABASE_URL;
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
let JPEG = new Uint8Array();

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
    JPEG = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c0392b" } }).jpeg().toBuffer());
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
    afterPut.run = null;
    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("R2_BUCKET", "catalog-bucket");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
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
    expect(after.order.deliveryProofKey).toMatch(new RegExp(`^delivery-proof/${order.id}/\\d+-[a-f0-9]{16}\\.jpg$`));
    expect(bucket.get(after.order.deliveryProofKey!)?.contentType).toBe("image/jpeg");
    expect(bucket.get(after.order.deliveryProofKey!)?.bucket).toBe("proof-bucket");
    expect(after.events.map((event) => event.type).sort()).toEqual(["delivered", "out_for_delivery"]);
    expect(after.notifications.filter((row) => row.event === "delivered").map((row) => row.channel).sort())
      .toEqual(["email", "sms"]);

    await handler({ event: { data: { storeId, orderId: order.id, event: "delivered" } }, step: makeFakeStep() });
    const sms = getTestSentSms().at(-1)!;
    expect(sms.text).toContain(`order #${order.number} Delivered.`);
    expect(sms.text).toContain(`/order/${after.order.trackingToken}`);
    expect(getTestSentEmails().at(-1)!.html).toContain(`Delivered. Order #${order.number}.`);
  });

  it("delivered with no photo, a non-image, or a file over the server-action body limit is rejected and leaves the order out for delivery", async () => {
    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    const pdf = new TextEncoder().encode("%PDF-1.7 not a photo");
    const oversize = new Uint8Array(CSV_ACTION_BODY_LIMIT_BYTES + 1);
    oversize.set(JPEG_HEADER);
    const cases: Array<[Uint8Array | null, string]> = [
      [null, PROOF_PHOTO_MISSING],
      [new Uint8Array(0), PROOF_PHOTO_MISSING],
      [pdf, PROOF_PHOTO_NOT_IMAGE],
      [oversize, PROOF_PHOTO_TOO_LARGE],
    ];
    for (const [photo, error] of cases) {
      expect(await markDelivered(storeId, order.id, photo)).toEqual({ ok: false, error });
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

  it("a photo uploaded for a delivery another staff member completed first is removed from the bucket", async () => {
    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    afterPut.run = async () => {
      afterPut.run = null;
      await storeScoped(storeId).order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
    };
    expect(await markDelivered(storeId, order.id, JPEG)).toEqual({ ok: false, error: "Cannot mark delivered in status DELIVERED" });
    const after = await state(order.id);
    expect(after.order.deliveryProofKey).toBeNull();
    expect(after.events.map((event) => event.type)).toEqual(["out_for_delivery"]);
    expect(bucket.size).toBe(0);
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

  it("a phone photo with GPS and a sideways orientation is stored upright, as a JPEG at most 2000px, with no metadata", async () => {
    const sideways = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#2e86c1" } })
      .withExif({
        IFD0: { Make: "PhoneCo", Model: "Driver Phone" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "29/1 41/1 3863/100", GPSLongitudeRef: "W", GPSLongitude: "95/1 15/1 5851/100" },
      })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const before = await sharp(sideways).metadata();
    expect(before.exif?.includes(Buffer.from("PhoneCo"))).toBe(true);
    expect(before.orientation).toBe(6);

    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    expect(await markDelivered(storeId, order.id, new Uint8Array(sideways))).toEqual({ ok: true });

    const key = (await state(order.id)).order.deliveryProofKey!;
    expect(key).toMatch(/\.jpg$/);
    const stored = bucket.get(key)!;
    expect(stored.contentType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(stored.body)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 667, height: 2000 });
  });

  it("a file with a JPEG header and a garbage body is not a photo: nothing uploaded, order still out for delivery", async () => {
    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    const garbage = new Uint8Array(4096).map((_, i) => (i * 37) % 251);
    garbage.set(JPEG_HEADER);
    expect(await markDelivered(storeId, order.id, garbage)).toEqual({ ok: false, error: PROOF_PHOTO_NOT_IMAGE });
    const after = await state(order.id);
    expect(after.order.status).toBe("OUT_FOR_DELIVERY");
    expect(after.order.deliveryProofKey).toBeNull();
    expect(bucket.size).toBe(0);
  });

  it("with no private proof bucket configured, delivered is refused before any upload and the order stays out for delivery", async () => {
    vi.stubEnv("R2_PROOF_BUCKET", "");
    const order = await readyOrder();
    await markOutForDelivery(storeId, order.id);
    expect(await markDelivered(storeId, order.id, JPEG)).toEqual({ ok: false, error: PROOF_STORAGE_NOT_SET_UP });
    const after = await state(order.id);
    expect(after.order.status).toBe("OUT_FOR_DELIVERY");
    expect(after.order.deliveryProofKey).toBeNull();
    expect(after.events.map((event) => event.type)).toEqual(["out_for_delivery"]);
    expect(bucket.size).toBe(0);
  });
});

