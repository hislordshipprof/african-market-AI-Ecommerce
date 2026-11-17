import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider } from "../stripe/fake";
import { computeQuote, recordAuthorizedOrder, type RecordAuthorizedOrderInput } from "./service";
import { slotOptions } from "./slots";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";
import type { SlotSchedule } from "../order/slot-schedule";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t573.test" };
const PRICE = 1200;
const ALL_DAY = [{ start: 0, end: 1440 }];
const SCHEDULE: SlotSchedule = {
  slotMinutes: 60,
  leadMinutes: 60,
  capacity: 20,
  daysAhead: 2,
  closedDates: [],
  windows: [ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY, ALL_DAY],
};

describe.skipIf(!hasDb)("orders from agent checkout links are attributed (#573)", () => {
  let raw: PrismaClient;
  let storeId = "";
  let variantId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    setStripeProvider(fakeStripeProvider);
    const store = await raw.store.create({
      data: {
        slug: `t573-attr-${Date.now().toString(36)}`,
        name: "Agent Market",
        themePreset: "palm-and-shea",
        timezone: "America/Chicago",
        pickupEnabled: true,
        pickupSlotSettings: SCHEDULE,
      },
    });
    storeId = store.id;
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: "Egusi", price: PRICE, stockMode: "unlimited", frozen: false, perishable: false },
    });
    variantId = (await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: PRICE, weightG: 454 } })).id;
  });

  afterAll(async () => {
    setStripeProvider(null);
    if (storeId) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.auditLog.deleteMany({ where: { storeId } }),
        raw.notificationLog.deleteMany({ where: { storeId } }),
        raw.stockEvent.deleteMany({ where: { storeId } }),
        raw.cart.deleteMany({ where: { storeId } }),
        raw.orderLine.deleteMany({ where: { storeId } }),
        raw.order.deleteMany({ where: { storeId } }),
        raw.customer.deleteMany({ where: { storeId } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId } } }),
        raw.listing.deleteMany({ where: { storeId } }),
      ]);
      await raw.store.delete({ where: { id: storeId } });
    }
    await raw?.$disconnect();
  });

  /** Fills the cart with one line and a fresh intent, as the checkout does before Pay. */
  async function readyToPay(cartId: string): Promise<RecordAuthorizedOrderInput> {
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    await storeScoped(storeId).cart.update({ where: { id: cartId }, data: { paymentIntentId } });
    await storeScoped(storeId).cartLine.create({ data: { storeId, cartId, variantId, qty: 1, swapRule: "exact_only" } });
    const store = await raw.store.findUniqueOrThrow({ where: { id: storeId } });
    const slot = (await slotOptions(storeScoped(storeId), storeId, store, "pickup", new Date(), cartId)).slots.find((s) => s.id !== "asap")!.id;
    return {
      cartId,
      contact: CONTACT,
      fulfillment: "pickup",
      pickupSlot: slot,
      notes: null,
      paymentIntentId,
      quote: computeQuote(0, [{ price: PRICE, qty: 1, maxPerOrder: null }], CONTACT, "pickup", ADR_0021_SERVICE_FEE),
      lines: [{ variantId, qty: 1, price: PRICE, swapRule: "exact_only", substituteVariantId: null }],
    };
  }

  const sourceOf = async (orderId: string) =>
    (await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } })).acquisitionSource;

  it("the order placed from an agent-built cart is source agent, even over a directory visit", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "agent" } });
    const placed = await recordAuthorizedOrder(storeId, { ...(await readyToPay(cart.id)), acquisitionSource: "directory" });
    expect(await sourceOf(placed.orderId)).toBe("agent");
  });

  it("the next order from the same cart is not the agent's", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "agent" } });
    const first = await recordAuthorizedOrder(storeId, await readyToPay(cart.id));
    const second = await recordAuthorizedOrder(storeId, await readyToPay(cart.id));
    expect(await sourceOf(first.orderId)).toBe("agent");
    expect(await sourceOf(second.orderId)).toBeNull();
  });

  it("an ordinary cart keeps the directory attribution", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    const placed = await recordAuthorizedOrder(storeId, { ...(await readyToPay(cart.id)), acquisitionSource: "directory" });
    expect(await sourceOf(placed.orderId)).toBe("directory");
  });
});
