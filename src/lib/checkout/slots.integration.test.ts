import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider } from "../stripe/fake";
import { cancelOrder } from "../order/service";
import { computeQuote, recordAuthorizedOrder, type RecordAuthorizedOrderInput } from "./service";
import { slotOptions, SlotUnavailableError } from "./slots";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";
import type { SlotSchedule } from "../order/slot-schedule";
import type { Fulfillment } from "../customer-flow/contracts";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t565.test" };
const PRICE = 4000;
const ALL_DAY = [{ start: 0, end: 1440 }];

function schedule(capacity: number): SlotSchedule {
  return {
    slotMinutes: 60,
    leadMinutes: 120,
    capacity,
    daysAhead: 2,
    closedDates: [],
    windows: [ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY],
  };
}

describe.skipIf(!hasDb)("slot reservation at placeOrder (#565)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    setStripeProvider({ ...fakeStripeProvider, cancelPaymentIntent: async (id) => ({ paymentIntentId: id, status: "canceled" }) });
    // Store delivery is offered only while its proof photo can be kept (#765).
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setStripeProvider(null);
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.auditLog.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.stockEvent.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.cartLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.cart.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    await raw?.$disconnect();
  });

  async function makeStore(capacity: number) {
    const store = await raw.store.create({
      data: {
        slug: `t565-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
        name: "Slot Market",
        themePreset: "palm-and-shea",
        timezone: "America/Chicago",
        pickupEnabled: true,
        storeDeliveryEnabled: true,
        storeDeliveryFeeCents: 500,
        lat: 41.88,
        lng: -87.63,
        pickupSlotSettings: schedule(capacity),
        storeDeliverySlotSettings: schedule(capacity),
      },
    });
    storeIds.push(store.id);
    const listing = await storeScoped(store.id).listing.create({
      data: { storeId: store.id, customName: "Yam", price: PRICE, stockMode: "unlimited", frozen: false, perishable: false },
    });
    const variant = await storeScoped(store.id).listingVariant.create({
      data: { listingId: listing.id, label: "Bag", price: PRICE, weightG: 25_000 },
    });
    return { storeId: store.id, variantId: variant.id, row: store };
  }

  async function orderInput(
    storeId: string,
    variantId: string,
    fulfillment: Fulfillment,
    pickupSlot: string | null,
  ): Promise<RecordAuthorizedOrderInput> {
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const delivering = fulfillment === "store-delivery";
    const cart = await storeScoped(storeId).cart.create({
      data: delivering
        ? { storeId, paymentIntentId, deliveryLine1: "1 Main St", deliveryCity: "Chicago", deliveryState: "IL", deliveryZip: "60601", deliveryLat: 41.89, deliveryLng: -87.63 }
        : { storeId, paymentIntentId },
    });
    // Two 25 kg bags: over 50 lb, so no courier (spec D4).
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 2, swapRule: "exact_only" },
    });
    const delivery = delivering
      ? { enabled: true, feeCents: 500, radiusMi: 8, hasCoordinates: true, confirmed: { withinRadius: true }, leaveAtDoor: false }
      : null;
    const quote = computeQuote(0, [{ price: PRICE, qty: 2, maxPerOrder: null }], CONTACT, fulfillment, ADR_0021_SERVICE_FEE, delivery);
    expect(quote.problems).toEqual([]);
    return {
      cartId: cart.id,
      contact: CONTACT,
      fulfillment,
      pickupSlot,
      notes: null,
      paymentIntentId,
      quote,
      lines: [{ variantId, qty: 2, price: PRICE, swapRule: "exact_only", substituteVariantId: null }],
    };
  }

  it("lets one of two concurrent orders take a slot's last place, refuses the other with fresh slots, and a cancel releases it", async () => {
    const { storeId, variantId, row } = await makeStore(1);
    const before = await slotOptions(storeScoped(storeId), storeId, row, "pickup", new Date(), null);
    const slot = before.slots[0]!.id;
    const results = await Promise.allSettled([
      recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "pickup", slot)),
      recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "pickup", slot)),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const refusal = (lost[0] as PromiseRejectedResult).reason;
    expect(refusal).toBeInstanceOf(SlotUnavailableError);
    expect((refusal as SlotUnavailableError).options.slots.map((s) => s.id)).not.toContain(slot);
    expect((refusal as SlotUnavailableError).options.slots.length).toBeGreaterThan(0);
    expect(await storeScoped(storeId).order.count({ where: { pickupSlot: slot } })).toBe(1);

    const orderId = (won[0] as PromiseFulfilledResult<{ orderId: string }>).value.orderId;
    expect(await cancelOrder(storeId, orderId, { action: "auto_cancel" })).toEqual({ ok: true });
    const after = await slotOptions(storeScoped(storeId), storeId, row, "pickup", new Date(), null);
    expect(after.slots.map((s) => s.id)).toContain(slot);
    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "pickup", slot))).resolves.toMatchObject({ created: true });
  });

  it("a heavy store delivery order carries a slot: ASAP and unoffered times are refused before any write", async () => {
    const { storeId, variantId, row } = await makeStore(3);
    const options = await slotOptions(storeScoped(storeId), storeId, row, "store-delivery", new Date(), null);
    expect(options.required).toBe(true);
    const slot = options.slots[0]!.id;

    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "store-delivery", null)))
      .rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "store-delivery", "2026-01-01T15:00:00.000Z")))
      .rejects.toBeInstanceOf(SlotUnavailableError);
    expect(await storeScoped(storeId).order.count()).toBe(0);

    const placed = await recordAuthorizedOrder(storeId, await orderInput(storeId, variantId, "store-delivery", slot));
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order).toMatchObject({ fulfillment: "store-delivery", pickupSlot: slot, deliveryFeeCents: 500 });
    // The acceptance alert clock is unchanged by a slot: it starts at placement while the store is open.
    expect(order.acceptanceClockStartsAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("counts only this store's orders against a slot", async () => {
    const a = await makeStore(1);
    const b = await makeStore(1);
    const slot = (await slotOptions(storeScoped(a.storeId), a.storeId, a.row, "pickup", new Date(), null)).slots[0]!.id;
    await recordAuthorizedOrder(a.storeId, await orderInput(a.storeId, a.variantId, "pickup", slot));
    const forB = await slotOptions(storeScoped(b.storeId), b.storeId, b.row, "pickup", new Date(), null);
    expect(forB.slots.map((s) => s.id)).toContain(slot);
    await expect(recordAuthorizedOrder(b.storeId, await orderInput(b.storeId, b.variantId, "pickup", slot))).resolves.toMatchObject({ created: true });
  });
});
