import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider } from "../stripe/fake";
import { BasketChangedError, computeQuote, recordAuthorizedOrder, type RecordAuthorizedOrderInput } from "./service";
import { slotOptions, SlotUnavailableError } from "./slots";
import { addLine, CartError, updateLineQty } from "../cart/service";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";
import type { SlotSchedule } from "../order/slot-schedule";
import type { Fulfillment } from "../customer-flow/contracts";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t571.test" };
const PRICE = 6000;
const HOUR = 60 * 60_000;
const ALL_DAY = [{ start: 0, end: 1440 }];

function schedule(): SlotSchedule {
  return {
    slotMinutes: 60,
    leadMinutes: 120,
    capacity: 5,
    daysAhead: 2,
    closedDates: [],
    windows: [ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY],
  };
}

describe.skipIf(!hasDb)("catering pre-orders (#571)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    setStripeProvider(fakeStripeProvider);
  });

  afterAll(async () => {
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

  async function makeStore(scheduled: boolean) {
    const store = await raw.store.create({
      data: {
        slug: `t571-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
        name: "Catering Market",
        themePreset: "palm-and-shea",
        timezone: "America/Chicago",
        prepTimeMinutes: 15,
        pickupEnabled: true,
        storeDeliveryEnabled: true,
        storeDeliveryFeeCents: 500,
        lat: 41.88,
        lng: -87.63,
        ...(scheduled && { pickupSlotSettings: schedule(), storeDeliverySlotSettings: schedule() }),
      },
    });
    storeIds.push(store.id);
    const tray = await variantFor(store.id, { customName: "Jollof tray", prepared: "hot", prepMinutes: 30, cateringLeadHours: 48, cateringMinQty: 2 });
    const quick = await variantFor(store.id, { customName: "Suya tray", prepared: "hot", prepMinutes: 20, cateringLeadHours: 24, cateringMinQty: 1 });
    const yam = await variantFor(store.id, { customName: "Yam" });
    return { storeId: store.id, row: store, tray, quick, yam };
  }

  async function variantFor(
    storeId: string,
    data: { customName: string; prepared?: string; prepMinutes?: number; cateringLeadHours?: number; cateringMinQty?: number },
  ) {
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, price: PRICE, stockMode: "unlimited", frozen: false, perishable: false, ...data },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Tray", price: PRICE, weightG: 2_000 },
    });
    return variant.id;
  }

  async function cartWith(storeId: string, variantIds: string[], qty = 2) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, paymentIntentId: `pi_${crypto.randomUUID()}` } });
    for (const variantId of variantIds) {
      await storeScoped(storeId).cartLine.create({ data: { storeId, cartId: cart.id, variantId, qty, swapRule: "exact_only" } });
    }
    return cart;
  }

  async function orderInput(storeId: string, variantIds: string[], fulfillment: Fulfillment, pickupSlot: string | null, qty = 2): Promise<RecordAuthorizedOrderInput> {
    const cart = await cartWith(storeId, variantIds, qty);
    const quote = computeQuote(0, variantIds.map(() => ({ price: PRICE, qty, maxPerOrder: null })), CONTACT, fulfillment, ADR_0021_SERVICE_FEE);
    return {
      cartId: cart.id,
      contact: CONTACT,
      fulfillment,
      pickupSlot,
      notes: null,
      paymentIntentId: cart.paymentIntentId!,
      quote,
      lines: variantIds.map((variantId) => ({ variantId, qty, price: PRICE, swapRule: "exact_only", substituteVariantId: null })),
    };
  }

  it("AC2: a catering cart must take a slot at or past its longest lead time, up to the 5-day hold window", async () => {
    const { storeId, row, tray, quick, yam } = await makeStore(true);
    const cart = await cartWith(storeId, [yam, quick, tray]);
    const now = new Date();
    const options = await slotOptions(storeScoped(storeId), storeId, row, "pickup", now, cart.id);

    expect(options.required).toBe(true);
    expect(options.slots.some((slot) => slot.id === "asap")).toBe(false);
    const starts = options.slots.map((slot) => Date.parse(slot.id));
    expect(starts.length).toBeGreaterThan(0);
    // The tray's 48 h, not the suya's 24 h.
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(now.getTime() + 48 * HOUR);
    // Past the store's own 2 days ahead, never past the 5-day hold.
    expect(Math.max(...starts)).toBeGreaterThan(now.getTime() + 3 * 24 * HOUR);
    expect(Math.max(...starts) + HOUR).toBeLessThanOrEqual(now.getTime() + 5 * 24 * HOUR);

    // A grocery-only cart keeps the store's own schedule.
    const grocery = await slotOptions(storeScoped(storeId), storeId, row, "pickup", now, (await cartWith(storeId, [yam])).id);
    expect(Math.max(...grocery.slots.filter((slot) => slot.id !== "asap").map((slot) => Date.parse(slot.id)))).toBeLessThan(now.getTime() + 2 * 24 * HOUR);
  });

  it("AC2: placeOrder refuses ASAP or a slot inside the lead time before any write, and books one past it", async () => {
    const { storeId, row, tray, yam } = await makeStore(true);
    const early = (await slotOptions(storeScoped(storeId), storeId, row, "pickup", new Date(), null)).slots
      .find((slot) => slot.id !== "asap")!.id;

    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, [yam, tray], "pickup", null)))
      .rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, [yam, tray], "pickup", early)))
      .rejects.toBeInstanceOf(SlotUnavailableError);
    expect(await storeScoped(storeId).order.count()).toBe(0);

    const input = await orderInput(storeId, [yam, tray], "pickup", null);
    const slot = (await slotOptions(storeScoped(storeId), storeId, row, "pickup", new Date(), input.cartId)).slots[0]!.id;
    const placed = await recordAuthorizedOrder(storeId, { ...input, pickupSlot: slot });
    expect(await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.orderId } })).toMatchObject({ pickupSlot: slot, status: "AUTHORIZED" });
  });

  it("AC2: without a schedule a catering cart gets no time, so it cannot be placed for pickup, store delivery or courier", async () => {
    const { storeId, row, tray } = await makeStore(false);
    const cart = await cartWith(storeId, [tray]);
    for (const fulfillment of ["pickup", "store-delivery", "courier"] as const) {
      expect(await slotOptions(storeScoped(storeId), storeId, row, fulfillment, new Date(), cart.id)).toMatchObject({ required: true, slots: [] });
    }
    await expect(recordAuthorizedOrder(storeId, await orderInput(storeId, [tray], "pickup", null)))
      .rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("AC1: a catering line starts at its minimum quantity and cannot go below it", async () => {
    const { storeId, tray } = await makeStore(true);
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    await addLine(storeId, cart.id, tray, 1);
    const line = await storeScoped(storeId).cartLine.findFirstOrThrow({ where: { cartId: cart.id } });
    expect(line.qty).toBe(2);
    await expect(updateLineQty(storeId, cart.id, line.id, 1)).rejects.toBeInstanceOf(CartError);
    await updateLineQty(storeId, cart.id, line.id, 3);
    expect((await storeScoped(storeId).cartLine.findUniqueOrThrow({ where: { id: line.id } })).qty).toBe(3);
  });

  it("AC1: placeOrder refuses a catering line below its minimum, even at a valid slot", async () => {
    const { storeId, row, tray } = await makeStore(true);
    const input = await orderInput(storeId, [tray], "pickup", null, 1);
    const slot = (await slotOptions(storeScoped(storeId), storeId, row, "pickup", new Date(), input.cartId)).slots[0]!.id;
    await expect(recordAuthorizedOrder(storeId, { ...input, pickupSlot: slot })).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count()).toBe(0);
  });
});
