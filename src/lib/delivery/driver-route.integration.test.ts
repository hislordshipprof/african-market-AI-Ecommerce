import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const bucket = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Key: string; Body: Uint8Array }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) bucket.set(command.input.Key, command.input.Body);
      else if (command instanceof DeleteObjectCommand) bucket.delete(command.input.Key);
      else throw new Error("NoSuchKey");
      return {};
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

import sharp from "sharp";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { clearTestSentSms, getTestSentSms, setSmsSenderForTests, type SmsSender } from "../notifications/sms";
import { ProviderSendError } from "../notifications/provider-error";
import {
  assignDriverRoute,
  driverMarkDelivered,
  driverMarkOutForDelivery,
  driverRouteBoard,
  hashRouteToken,
  readDriverRoute,
  revokeDriverRoute,
} from "./driver-route";

const hasDb = !!process.env.DATABASE_URL;
// Fixed clock: Tuesday 2026-11-17, 10:00 in Houston (UTC-6).
const NOW = new Date("2026-11-17T16:00:00.000Z");
const SLOT = "2026-11-17T20:00:00.000Z";
const OTHER_SLOT = "2026-11-17T21:00:00.000Z";
// Midnight at the end of the store's Tuesday.
const DAY_END = new Date("2026-11-18T06:00:00.000Z");

function tokenFrom(text: string): string {
  const match = text.match(/\/driver\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no driver link in: ${text}`);
  return match[1];
}

describe.skipIf(!hasDb)("own-driver route link", () => {
  let raw: PrismaClient;
  let storeId = "";
  let otherStoreId = "";
  let frozenVariantId = "";
  let plainVariantId = "";
  let number = 0;
  let JPEG = new Uint8Array();

  beforeAll(async () => {
    JPEG = new Uint8Array(await sharp({ create: { width: 32, height: 24, channels: 3, background: "#2e86c1" } }).jpeg().toBuffer());
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    const store = await raw.store.create({
      data: {
        slug: `t566-${stamp}`, name: "Ada's Market", themePreset: "palm-and-shea",
        timezone: "America/Chicago", lat: 29.7604, lng: -95.3698, storeDeliveryEnabled: true,
      },
    });
    const other = await raw.store.create({
      data: { slug: `t566b-${stamp}`, name: "Other Market", themePreset: "palm-and-shea", timezone: "America/Chicago" },
    });
    storeId = store.id;
    otherStoreId = other.id;
    const scoped = storeScoped(storeId);
    const frozen = await scoped.listing.create({
      data: { storeId, customName: "Goat meat", price: 1500, stockMode: "untracked", frozen: true },
    });
    const plain = await scoped.listing.create({
      data: { storeId, customName: "Garri", price: 500, stockMode: "untracked" },
    });
    frozenVariantId = (await scoped.listingVariant.create({ data: { listingId: frozen.id, label: "2 lb", price: 1500, weightG: 900 } })).id;
    plainVariantId = (await scoped.listingVariant.create({ data: { listingId: plain.id, label: "1 kg", price: 500, weightG: 1000 } })).id;
  });

  beforeEach(() => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("R2_BUCKET", "catalog-bucket");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    clearTestSentSms();
    setSmsSenderForTests(null);
    bucket.clear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const id of [storeId, otherStoreId]) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.driverRoute.deleteMany({});
      await scoped.customer.deleteMany({});
    }
  });

  afterAll(async () => {
    const scoped = storeScoped(storeId);
    await scoped.listingVariant.deleteMany({});
    await scoped.listing.deleteMany({});
    await raw.store.deleteMany({ where: { id: { in: [storeId, otherStoreId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  async function order(opts: {
    store?: string;
    slot?: string;
    status?: string;
    fulfillment?: string;
    lat?: number;
    lng?: number;
    line1?: string;
    notes?: string;
    frozen?: boolean;
  } = {}) {
    const sid = opts.store ?? storeId;
    const scoped = storeScoped(sid);
    const customer = await scoped.customer.create({
      data: { storeId: sid, name: "Ada Obi", phone: "+13014482210", email: "ada@example.com" },
    });
    number += 1;
    const created = await scoped.order.create({
      data: {
        storeId: sid,
        customerId: customer.id,
        number,
        status: opts.status ?? "READY",
        fulfillment: opts.fulfillment ?? "store-delivery",
        pickupSlot: opts.slot ?? SLOT,
        subtotalCents: 2000,
        deliveryFeeCents: 500,
        bufferCents: 250,
        totalCents: 2500,
        totalAuthorizedCents: 2750,
        capturedAmountCents: 2500,
        trackingToken: `trk-${sid}-${number}`,
        deliveryLine1: opts.line1 ?? `${number} MAIN ST`,
        deliveryCity: "HOUSTON",
        deliveryState: "TX",
        deliveryZip: "77002",
        deliveryLat: opts.lat ?? null,
        deliveryLng: opts.lng ?? null,
        notes: opts.notes ?? null,
      },
    });
    if (sid === storeId) {
      await scoped.orderLine.create({
        data: {
          storeId: sid, orderId: created.id, listingVariantId: opts.frozen ? frozenVariantId : plainVariantId,
          qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 2000, status: "picked",
        },
      });
    }
    return created;
  }

  async function assign(slot = SLOT) {
    return assignDriverRoute(storeId, { slot, driverName: "Kofi", driverPhone: "(713) 555-2468" }, { now: NOW });
  }

  it("assigns the slot's Ready store-delivery orders and texts the driver a link that stores only its hash and dies at the end of the store day", async () => {
    const a = await order();
    const b = await order();
    const otherSlot = await order({ slot: OTHER_SLOT });
    const notReady = await order({ status: "PICKING" });
    const pickup = await order({ fulfillment: "pickup", status: "READY" });

    const result = await assign();
    expect(result).toMatchObject({ ok: true, count: 2 });

    const sms = getTestSentSms();
    expect(sms).toHaveLength(1);
    expect(sms[0].to).toBe("+17135552468");
    const token = tokenFrom(sms[0].text);
    expect(sms[0].text).toContain(`https://`);
    expect(token.length).toBeGreaterThanOrEqual(43);

    const routes = await storeScoped(storeId).driverRoute.findMany({});
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ driverName: "Kofi", driverPhone: "+17135552468", slot: SLOT, tokenHash: hashRouteToken(token) });
    expect(routes[0].tokenHash).not.toContain(token);
    expect(routes[0].expiresAt).toEqual(DAY_END);
    expect(routes[0].sentAt).toBeInstanceOf(Date);

    const assigned = await storeScoped(storeId).order.findMany({ where: { driverRouteId: routes[0].id } });
    expect(assigned.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    for (const left of [otherSlot, notReady, pickup]) {
      expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: left.id } })).driverRouteId).toBeNull();
    }
  });

  it("refuses a bad phone or a slot with no Ready orders, and sends nothing", async () => {
    await order();
    expect(await assignDriverRoute(storeId, { slot: SLOT, driverName: "Kofi", driverPhone: "12" }, { now: NOW }))
      .toMatchObject({ ok: false });
    expect(await assign(OTHER_SLOT)).toMatchObject({ ok: false });
    expect(getTestSentSms()).toHaveLength(0);
    expect(await storeScoped(storeId).driverRoute.count()).toBe(0);
  });

  it("a failed SMS keeps the route live and hands the owner the link to send another way, with the same expiry and revoke", async () => {
    const a = await order();
    const failing: SmsSender = { send: async () => { throw new ProviderSendError(503, "http_503"); } };
    setSmsSenderForTests(failing);
    const result = await assign();
    if (!result.ok) throw new Error(`assign failed: ${result.error}`);
    expect(result).toMatchObject({ count: 1, texted: false });
    const token = tokenFrom(result.link!);

    const [route] = await storeScoped(storeId).driverRoute.findMany({});
    expect(route.revokedAt).toBeNull();
    expect(route.expiresAt).toEqual(DAY_END);
    expect((await readDriverRoute(storeId, token, NOW))!.stops.map((s) => s.orderId)).toEqual([a.id]);
    expect(await readDriverRoute(storeId, token, DAY_END)).toBeNull();

    expect(await revokeDriverRoute(storeId, result.routeId, NOW)).toEqual({ ok: true });
    expect(await readDriverRoute(storeId, token, NOW)).toBeNull();
    setSmsSenderForTests(null);
    expect(await assign()).toMatchObject({ ok: true, count: 1 });
  });

  it("a texted route does not hand the link back", async () => {
    await order();
    const result = await assign();
    expect(result).toMatchObject({ ok: true, texted: true });
    expect(result).not.toHaveProperty("link");
  });

  it("an order sent out for delivery with no driver stays on the board, and the next route picks it up", async () => {
    const out = await order({ status: "OUT_FOR_DELIVERY" });
    const ready = await order();
    const before = await driverRouteBoard(storeId, "America/Chicago", NOW);
    expect(before).toMatchObject([{ slot: SLOT, waiting: 2, routes: [] }]);

    expect(await assign()).toMatchObject({ ok: true, count: 2 });
    const after = await driverRouteBoard(storeId, "America/Chicago", NOW);
    expect(after).toMatchObject([{ slot: SLOT, waiting: 0, routes: [{ orders: 2 }] }]);
    const token = tokenFrom(getTestSentSms()[0].text);
    expect((await readDriverRoute(storeId, token, NOW))!.stops.map((s) => s.orderId).sort()).toEqual([out.id, ready.id].sort());
  });

  it("an order on a live route is not taken by a second assignment", async () => {
    await order();
    expect(await assign()).toMatchObject({ ok: true, count: 1 });
    expect(await assign()).toMatchObject({ ok: false });
  });

  it("lists stops nearest-next from the store with address, notes and frozen flags and a maps link", async () => {
    const far = await order({ lat: 29.95, lng: -95.37, line1: "900 FAR RD", notes: "Gate code 4411" });
    const near = await order({ lat: 29.77, lng: -95.37, line1: "100 NEAR ST", frozen: true });
    const middle = await order({ lat: 29.85, lng: -95.37, line1: "500 MID AVE" });
    const unknown = await order({ line1: "77 NO GEO LN" });
    await assign();
    const token = tokenFrom(getTestSentSms()[0].text);

    const route = await readDriverRoute(storeId, token, NOW);
    expect(route).not.toBeNull();
    expect(route!.driverName).toBe("Kofi");
    expect(route!.stops.map((stop) => stop.orderId)).toEqual([near.id, middle.id, far.id, unknown.id]);
    expect(route!.stops[0]).toMatchObject({ frozen: true, address: "100 NEAR ST, HOUSTON, TX 77002" });
    expect(route!.stops[2]).toMatchObject({ frozen: false, notes: "Gate code 4411" });
    expect(route!.stops[0].mapsUrl).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("100 NEAR ST, HOUSTON, TX 77002")}`,
    );
  });

  it("the token opens nothing in another store, after revoke, or after the store day ends", async () => {
    await order();
    const result = await assign();
    const token = tokenFrom(getTestSentSms()[0].text);
    expect(await readDriverRoute(otherStoreId, token, NOW)).toBeNull();
    expect(await readDriverRoute(storeId, `${token}x`, NOW)).toBeNull();
    expect(await readDriverRoute(storeId, token, DAY_END)).toBeNull();
    expect(await readDriverRoute(storeId, token, NOW)).not.toBeNull();

    if (!result.ok) throw new Error("assign failed");
    expect(await revokeDriverRoute(otherStoreId, result.routeId, NOW)).toMatchObject({ ok: false });
    expect(await readDriverRoute(storeId, token, NOW)).not.toBeNull();
    expect(await revokeDriverRoute(storeId, result.routeId, NOW)).toEqual({ ok: true });
    expect(await readDriverRoute(storeId, token, NOW)).toBeNull();
  });

  it("the driver marks out for delivery and delivered with a photo; the customer is notified as for staff", async () => {
    const a = await order();
    await assign();
    const token = tokenFrom(getTestSentSms()[0].text);

    expect(await driverMarkOutForDelivery(storeId, token, a.id, NOW)).toEqual({ ok: true });
    expect(await driverMarkDelivered(storeId, token, a.id, null, NOW)).toMatchObject({ ok: false });
    expect(await driverMarkDelivered(storeId, token, a.id, JPEG, NOW)).toEqual({ ok: true });

    const scoped = storeScoped(storeId);
    const after = await scoped.order.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe("DELIVERED");
    expect(after.deliveryProofKey).toMatch(/^delivery-proof\//);
    expect(bucket.has(after.deliveryProofKey!)).toBe(true);
    const events = await scoped.deliveryEvent.findMany({ where: { orderId: a.id } });
    expect(events.map((e) => e.type).sort()).toEqual(["delivered", "out_for_delivery"]);
    const notes = await scoped.notificationLog.findMany({ where: { orderId: a.id } });
    expect(notes.map((n) => `${n.event}:${n.channel}`).sort())
      // #563 adds a push row per event, as for every staff-marked update.
      .toEqual(["delivered:email", "delivered:push", "delivered:sms", "out_for_delivery:email", "out_for_delivery:push", "out_for_delivery:sms"]);
  });

  it("the token cannot act on an order off its route, another store's order, or after revoke: each is not found", async () => {
    const onRoute = await order();
    const result = await assign();
    if (!result.ok) throw new Error("assign failed");
    const token = tokenFrom(getTestSentSms()[0].text);
    const offRoute = await order({ slot: OTHER_SLOT });
    const foreign = await order({ store: otherStoreId });

    for (const id of [offRoute.id, foreign.id]) {
      expect(await driverMarkOutForDelivery(storeId, token, id, NOW)).toEqual({ ok: false, error: "not_found" });
      expect(await driverMarkOutForDelivery(otherStoreId, token, id, NOW)).toEqual({ ok: false, error: "not_found" });
    }
    await revokeDriverRoute(storeId, result.routeId, NOW);
    expect(await driverMarkOutForDelivery(storeId, token, onRoute.id, NOW)).toEqual({ ok: false, error: "not_found" });
    expect(await driverMarkDelivered(storeId, token, onRoute.id, JPEG, NOW)).toEqual({ ok: false, error: "not_found" });

    expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: offRoute.id } })).status).toBe("READY");
    expect((await storeScoped(otherStoreId).order.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("READY");
    expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: onRoute.id } })).status).toBe("READY");
    expect(bucket.size).toBe(0);
  });

  it("store B cannot read or write store A's driver routes", async () => {
    await order();
    await assign();
    expect(await storeScoped(otherStoreId).driverRoute.findMany({})).toEqual([]);
    const updated = await storeScoped(otherStoreId).driverRoute.updateMany({ data: { revokedAt: NOW } });
    expect(updated.count).toBe(0);
    await expect(storeScoped(otherStoreId).driverRoute.create({
      data: { storeId, slot: SLOT, driverName: "X", driverPhone: "+17135552468", tokenHash: "h", expiresAt: DAY_END },
    })).rejects.toThrow();
  });
});
