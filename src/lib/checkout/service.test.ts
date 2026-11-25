import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const retrieve = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("../stripe/provider", () => ({
  getStripeClient: () => ({ paymentIntents: { retrieve } }),
}));

vi.mock("../inngest/client", () => ({
  inngest: { send },
}));

import { computeQuote, placeOrder } from "./service";
import { HOT_FOOD_HANDOFF } from "./quote";
import { storeScoped, storeScopedTransaction } from "../db";
import type { Contact } from "../customer-flow/contracts";
import { ADR_0021_SERVICE_FEE, NO_SERVICE_FEE } from "../order/platform-fee";


const validContact: Contact = {
  name: "Jane Doe",
  phone: "+15551234567",
  email: "jane@test.com",
};

function baseLines(
  overrides?: Array<{ price: number; qty: number; maxPerOrder: number | null }>,
) {
  return (
    overrides ?? [{ price: 1200, qty: 2, maxPerOrder: null }]
  );
}

describe("computeQuote", () => {
  it("calculates subtotal and 10% buffer", () => {
    const q = computeQuote(0, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    expect(q.subtotalCents).toBe(2400);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(2640);
    expect(q.totalCents).toBe(2400);
    expect(q.problems).toHaveLength(0);
  });

  it("blocks a line above the counted stock left, so an order never reserves less than it charges for (#808)", () => {
    const q = computeQuote(0, [{ price: 1899, qty: 6, maxPerOrder: null, stockLeft: 4 }], validContact, "pickup", NO_SERVICE_FEE);
    expect(q.problems).toContainEqual({ code: "max-quantity", message: "Only 4 left of this item." });
    const ok = computeQuote(0, [{ price: 1899, qty: 4, maxPerOrder: null, stockLeft: 4 }], validContact, "pickup", NO_SERVICE_FEE);
    expect(ok.problems).toHaveLength(0);
  });

  it("caps buffer at $20 (2000 cents)", () => {
    const q = computeQuote(
      0,
      [{ price: 25000, qty: 1, maxPerOrder: null }],
      validContact,
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.subtotalCents).toBe(25000);
    expect(q.bufferCents).toBe(2000);
    expect(q.holdCents).toBe(27000);
  });

  it("forces tip to 0 for pickup", () => {
    const q = computeQuote(0, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    expect(q.tipCents).toBe(0);
    expect(q.totalCents).toBe(2400);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(2640);
  });

  it("flags minimum order violation", () => {
    const q = computeQuote(5000, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags empty cart", () => {
    const q = computeQuote(0, [], validContact, "pickup", NO_SERVICE_FEE);
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags missing contact name", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "", phone: "+15551234567", email: "a@b.com" },
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags missing email", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "+15551234567", email: "" },
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags invalid email format (no @ sign)", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "+15551234567", email: "notanemail" },
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags invalid phone (too short)", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "123", email: "a@b.com" },
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags bad quantity (zero)", () => {
    const q = computeQuote(
      0,
      [{ price: 500, qty: 0, maxPerOrder: null }],
      validContact,
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "max-quantity" }),
      ]),
    );
  });

  it("flags non-pickup fulfillment", () => {
    const q = computeQuote(0, baseLines(), validContact, "courier", NO_SERVICE_FEE);
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ineligible" }),
      ]),
    );
    expect(q.deliveryFeeCents).toBe(0);
  });

  it("store delivery adds the store's fee to total and hold", () => {
    const q = computeQuote(
      0,
      [{ price: 4000, qty: 1, maxPerOrder: null }],
      validContact,
      "store-delivery", NO_SERVICE_FEE,
      {
        enabled: true,
        feeCents: 500,
        radiusMi: 8,
        hasCoordinates: true,
        confirmed: { withinRadius: true },
        leaveAtDoor: false,
      },
    );
    expect(q.problems).toEqual([]);
    expect(q.subtotalCents).toBe(4000);
    expect(q.deliveryFeeCents).toBe(500);
    expect(q.totalCents).toBe(4500);
    expect(q.bufferCents).toBe(400);
    expect(q.holdCents).toBe(4900);
  });

  it("courier adds the quoted fee, unmarked, to total and hold", () => {
    const q = computeQuote(
      0,
      [{ price: 4000, qty: 1, maxPerOrder: null }],
      validContact,
      "courier", NO_SERVICE_FEE, null,
      { ok: true, feeCents: 899, provider: "Uber Direct", leaveAtDoor: false },
    );
    expect(q.problems).toEqual([]);
    expect(q.courierFeeCents).toBe(899);
    expect(q.courierProvider).toBe("Uber Direct");
    expect(q.deliveryFeeCents).toBe(0);
    expect(q.totalCents).toBe(4899);
    expect(q.holdCents).toBe(5299);
  });

  it("courier shows why it is unavailable and adds no fee", () => {
    const q = computeQuote(
      0,
      [{ price: 4000, qty: 1, maxPerOrder: null }],
      validContact,
      "courier", NO_SERVICE_FEE, null,
      { ok: false, problem: { code: "ineligible", message: "This order is over the 50 lb courier limit." } },
    );
    expect(q.problems).toEqual([{ code: "ineligible", message: "This order is over the 50 lb courier limit." }]);
    expect(q.courierFeeCents).toBe(0);
    expect(q.totalCents).toBe(4000);
  });

  it("courier refuses leave at door with frozen, perishable or hot (#570) items", () => {
    for (const line of [{ frozen: true }, { perishable: true }, { hot: true }]) {
      const q = computeQuote(
        0,
        [{ price: 4000, qty: 1, maxPerOrder: null, ...line }],
        validContact,
        "courier", NO_SERVICE_FEE, null,
        { ok: true, feeCents: 899, provider: "DoorDash Drive", leaveAtDoor: true },
      );
      expect(q.problems).toEqual([expect.objectContaining({ code: "ineligible" })]);
    }
  });

  it("#570 AC5: store delivery refuses leave at door with a hot item, and allows it with a cold one", () => {
    const delivery = (leaveAtDoor: boolean) => ({
      enabled: true, feeCents: 500, radiusMi: 5, hasCoordinates: true, confirmed: { withinRadius: true }, leaveAtDoor,
    });
    const quote = (hot: boolean, leaveAtDoor: boolean) => computeQuote(
      0, [{ price: 4000, qty: 1, maxPerOrder: null, hot }], validContact, "store-delivery", NO_SERVICE_FEE, delivery(leaveAtDoor),
    );
    expect(quote(true, true).problems).toEqual([{ code: "ineligible", message: HOT_FOOD_HANDOFF }]);
    expect(quote(true, false).problems).toEqual([]);
    expect(quote(false, true).problems).toEqual([]);
  });

  it("returns a valid expiration ~15 minutes out", () => {
    const before = Date.now();
    const q = computeQuote(0, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    const expires = new Date(q.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 14 * 60_000);
    expect(expires).toBeLessThanOrEqual(before + 16 * 60_000);
  });

  it("returns unique quote ids", () => {
    const q1 = computeQuote(0, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    const q2 = computeQuote(0, baseLines(), validContact, "pickup", NO_SERVICE_FEE);
    expect(q1.id).not.toBe(q2.id);
  });

  it("enforces maxPerOrder limit", () => {
    const q = computeQuote(
      0,
      [{ price: 1000, qty: 5, maxPerOrder: 3 }],
      validContact,
      "pickup", NO_SERVICE_FEE,
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "max-quantity" }),
      ]),
    );
  });

  it("adds the service fee to the total and sizes the hold buffer on goods", () => {
    const q = computeQuote(0, [{ price: 6000, qty: 1, maxPerOrder: null }], validContact, "pickup", ADR_0021_SERVICE_FEE);
    expect(q.serviceFeeCents).toBe(180);
    expect(q.totalCents).toBe(6180);
    expect(q.bufferCents).toBe(600);
    expect(q.holdCents).toBe(6780);
  });

  describe("store coupon (#557)", () => {
    const SAVE20 = { code: "SAVE20", coupon: { id: "c1", kind: "percent" as const, percentOff: 20, amountOffCents: null, minGoodsCents: 2500 } };
    const FIVE_OFF = { code: "FIVEOFF", coupon: { id: "c2", kind: "fixed" as const, percentOff: null, amountOffCents: 500, minGoodsCents: 0 } };
    const STORE_DELIVERY = { enabled: true, feeCents: 500, radiusMi: 5, hasCoordinates: true, confirmed: { withinRadius: true }, leaveAtDoor: false };

    it("takes the discount off goods, charges the service fee on discounted goods, and holds the discounted total plus the buffer", () => {
      // $50.00 goods, 20% off = $10.00. Fee 3% of $40.00 = $1.20. Delivery $5.00 is never discounted.
      // Total 4000 + 120 + 500 = 4620; buffer 10% of $40.00 = 400; hold 5020.
      const q = computeQuote(0, [{ price: 2500, qty: 2, maxPerOrder: null }], validContact, "store-delivery", ADR_0021_SERVICE_FEE, STORE_DELIVERY, null, SAVE20);
      expect(q.problems).toEqual([]);
      expect(q.subtotalCents).toBe(5000);
      expect(q.discountCents).toBe(1000);
      expect(q.serviceFeeCents).toBe(120);
      expect(q.deliveryFeeCents).toBe(500);
      expect(q.totalCents).toBe(4620);
      expect(q.bufferCents).toBe(400);
      expect(q.holdCents).toBe(5020);
      expect(q.coupon).toEqual({ code: "SAVE20", discountCents: 1000 });
    });

    it("caps a fixed discount at the goods, so fees are never discounted", () => {
      // $3.20 goods, $5 off → $3.20 off; the fee on $0 goods is 0; the $5 delivery stays.
      const q = computeQuote(0, [{ price: 320, qty: 1, maxPerOrder: null }], validContact, "store-delivery", ADR_0021_SERVICE_FEE, STORE_DELIVERY, null, FIVE_OFF);
      expect(q.discountCents).toBe(320);
      expect(q.serviceFeeCents).toBe(0);
      expect(q.totalCents).toBe(500);
      expect(q.holdCents).toBe(500);
    });

    it("gives no discount below the code's minimum and says how much more to add, without blocking checkout", () => {
      const q = computeQuote(0, [{ price: 2000, qty: 1, maxPerOrder: null }], validContact, "pickup", ADR_0021_SERVICE_FEE, null, null, SAVE20);
      expect(q.discountCents).toBe(0);
      expect(q.serviceFeeCents).toBe(99);
      expect(q.totalCents).toBe(2099);
      expect(q.problems).toEqual([]);
      expect(q.coupon).toEqual({ code: "SAVE20", discountCents: 0, message: "Add $5.00 more to use SAVE20." });
    });

    // Decision 2026-11-24-07 (#806): the store funds both, so the minimum protects what it takes after its coupon.
    it("checks the store minimum order on goods after the discount and says how much more to add", () => {
      const TEN10 = { code: "TEN10", coupon: { id: "c3", kind: "percent" as const, percentOff: 10, amountOffCents: null, minGoodsCents: 0 } };
      const q = computeQuote(3500, [{ price: 3597, qty: 1, maxPerOrder: null }], validContact, "pickup", ADR_0021_SERVICE_FEE, null, null, TEN10);
      expect(q.discountCents).toBe(360);
      expect(q.problems).toEqual([{ code: "minimum-order", message: "$2.63 more to reach the $35.00 minimum" }]);
    });

    it("meets the store minimum when goods after the discount equal it", () => {
      const q = computeQuote(4000, [{ price: 2500, qty: 2, maxPerOrder: null }], validContact, "pickup", ADR_0021_SERVICE_FEE, null, null, SAVE20);
      expect(q.discountCents).toBe(1000);
      expect(q.problems.some((p) => p.code === "minimum-order")).toBe(false);
    });

    it("passes a refused code through with no discount", () => {
      const q = computeQuote(0, [{ price: 2500, qty: 2, maxPerOrder: null }], validContact, "pickup", ADR_0021_SERVICE_FEE, null, null, { code: "SAVE20", refusal: "This code has reached its limit." });
      expect(q.discountCents).toBe(0);
      expect(q.coupon).toEqual({ code: "SAVE20", discountCents: 0, message: "This code has reached its limit." });
    });
  });

  it("client-supplied price has no effect on server-derived amount", () => {
    const serverLines = [{ price: 1200, qty: 2, maxPerOrder: null }];
    const q = computeQuote(0, serverLines, validContact, "pickup", NO_SERVICE_FEE);
    expect(q.subtotalCents).toBe(2400);
    expect(q.holdCents).toBe(2640);
  });
});

const hasDb = !!process.env.DATABASE_URL;
const FEE_CONTACT: Contact = {
  name: "Fee Buyer",
  phone: "+15551230000",
  email: "fee@t186.test",
};

describe.skipIf(!hasDb)("placeOrder Inngest and platform fee (lane DB)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
  }, 30_000);

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
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
  }, 30_000);

  async function seedStore(price: number) {
    const store = await raw.store.create({
      data: {
        slug: `t186-fee-${crypto.randomUUID().slice(0, 8)}`,
        name: "Fee store",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_t186_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    const listing = await storeScoped(store.id).listing.create({
      data: {
        storeId: store.id,
        customName: "Fee pack",
        price,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(store.id).listingVariant.create({
      data: { listingId: listing.id, label: "V", price, weightG: 100 },
    });
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const quote = computeQuote(0, [{ price, qty: 1, maxPerOrder: null }], FEE_CONTACT, "pickup", ADR_0021_SERVICE_FEE);
    retrieve.mockResolvedValue({
      status: "requires_capture",
      amount: quote.holdCents,
      on_behalf_of: store.stripeAccountId,
      transfer_data: { destination: store.stripeAccountId },
      metadata: { store_id: store.id },
    });
    return { store, cart, paymentIntentId, quote };
  }

  it("placeOrder returns the committed order while the Inngest send is still pending", async () => {
    const { store, cart, paymentIntentId } = await seedStore(1234);
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    send.mockReset();
    send.mockImplementation(() => gate);

    const started = Date.now();
    const result = await placeOrder(store.id, 0, cart.id, FEE_CONTACT, "pickup", null, null, paymentIntentId);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.token).toBeTruthy();

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const pending = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
    expect(pending?.status).toBe("AUTHORIZED");
    expect(pending?.inngestEventSentAt).toBeNull();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: `order-authorized-${result.token}`, name: "order/authorized" }),
    );

    release(undefined);
    await vi.waitFor(async () => {
      const sent = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
      expect(sent?.inngestEventSentAt).not.toBeNull();
    });
  }, 20_000);

  it("placeOrder stores the service fee, the settings it was quoted with, and the platform fee", async () => {
    const { store, cart, paymentIntentId, quote } = await seedStore(6000);
    send.mockReset();
    send.mockResolvedValue(undefined);
    const result = await placeOrder(store.id, 0, cart.id, FEE_CONTACT, "pickup", null, null, paymentIntentId);
    const order = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
    expect(quote.totalCents).toBe(6180);
    expect(order?.serviceFeeCents).toBe(180);
    expect(order?.totalCents).toBe(6180);
    expect(order?.totalAuthorizedCents).toBe(6780);
    expect([order?.serviceFeeBps, order?.serviceFeeMinCents, order?.serviceFeeMaxCents]).toEqual([300, 99, 299]);
    // $1.80 fee + the store's card fee on $60 of goods (2.9% + 30¢ = $2.04).
    expect(order?.platformFeeCents).toBe(384);
  });

  it("a checkout replay after commit does not send a second event", async () => {
    const { store, cart, paymentIntentId } = await seedStore(800);
    send.mockReset();
    send.mockResolvedValue(undefined);
    const first = await placeOrder(store.id, 0, cart.id, FEE_CONTACT, "pickup", null, null, paymentIntentId);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    send.mockClear();
    const second = await placeOrder(store.id, 0, cart.id, FEE_CONTACT, "pickup", null, null, paymentIntentId);
    expect(second.token).toBe(first.token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
  });

  it("storeScoped for store B cannot read the new order or its lines", async () => {
    const { store, cart, paymentIntentId } = await seedStore(900);
    const other = await raw.store.create({
      data: {
        slug: `t186-other-${crypto.randomUUID().slice(0, 8)}`,
        name: "Other",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_t186b_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
        stripeOnboardingStatus: "complete",
      },
    });
    storeIds.push(other.id);
    send.mockReset();
    send.mockResolvedValue(undefined);
    const result = await placeOrder(store.id, 0, cart.id, FEE_CONTACT, "pickup", null, null, paymentIntentId);

    const who = await storeScopedTransaction(store.id, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ session_user: string }>>`SELECT session_user`;
      return rows[0]?.session_user;
    });
    expect(who).toBe("app_runtime");

    expect(await storeScoped(other.id).order.findUnique({ where: { id: result.token } })).toBeNull();
    expect(await storeScoped(other.id).orderLine.findMany({ where: { orderId: result.token } })).toEqual([]);
    const before = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
    const touched = await storeScoped(other.id).order.updateMany({
      where: { id: result.token },
      data: { inngestEventSentAt: new Date(0) },
    });
    expect(touched.count).toBe(0);
    const after = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
    expect(after?.inngestEventSentAt?.getTime() ?? null).toBe(before?.inngestEventSentAt?.getTime() ?? null);
  });
});
