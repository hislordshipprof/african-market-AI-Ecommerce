import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, storeScoped } from "../db";
import { testPrismaClient } from "@/lib/test-prisma";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { createPaymentIntent, placeOrder, quoteCheckout, saveDeliverySnapshot } from "../checkout/service";
import { writeGeocodeCache } from "../address/cache";
import { PREPARED_FOOD_TAX_CODE } from "../listing/prepared";
import { fakeTaxCalculator, setTaxCalculatorForTests, stripeTaxCalculator, TAX_LOCATION_MESSAGE, TAX_UNAVAILABLE_MESSAGE, type TaxCalculator } from "./calculator";

vi.mock("../inngest/send", () => ({ sendOrderAuthorized: vi.fn().mockResolvedValue(undefined) }));

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `t65q-${Date.now().toString(36)}`;
const CONTACT = { name: "Ada", phone: "+15551234567", email: "ada@example.test" };
const FOOD = "txcd_40040000";
const BEAUTY = "txcd_32050025";
// Texas exempts groceries; Montana has no sales tax; Arkansas is across the line from Texarkana, TX.
const RATES = { TX: { rate: 0.0825, exemptCodes: [FOOD] }, MT: { rate: 0 }, AR: { rate: 0.095 } };
const ACROSS_THE_LINE = { line1: "200 E BROAD ST", line2: null, city: "TEXARKANA", state: "AR", zip: "71854", leaveAtDoor: false };

describe.skipIf(!hasDb)("sales tax at checkout (#65, lane DB)", () => {
  const raw = testPrismaClient();
  const storeIds: string[] = [];
  const categoryIds: string[] = [];
  const masterIds: string[] = [];
  let tx = "";
  let mt = "";
  let bare = "";
  let liable = "";
  let foodMaster = "";
  let beautyMaster = "";
  const variants = new Map<string, { food: string; beauty: string }>();

  async function category(code: string) {
    const row = await platformAdmin.category.create({ data: { name: `${RUN} ${code}`, slug: `${RUN}-${code}`, sortOrder: 900, taxCode: code } });
    categoryIds.push(row.id);
    return platformAdmin.masterProduct.create({ data: { name: `${RUN} ${code} product`, categoryId: row.id } }).then((m) => { masterIds.push(m.id); return m.id; });
  }

  async function store(slug: string, address: { state: string; city: string; zip: string } | null, taxLiableParty = "platform") {
    const row = await platformAdmin.store.create({
      data: {
        slug: `${RUN}-${slug}`, name: `Tax ${slug}`, pickupEnabled: true, stripeOnboardingStatus: "complete", taxLiableParty,
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        ...(address ? { addressLine1: "100 Main St", ...address } : {}),
      },
    });
    storeIds.push(row.id);
    return row.id;
  }

  async function stock(storeId: string, foodId: string, beautyId: string) {
    const make = async (masterProductId: string, price: number) => {
      const listing = await storeScoped(storeId).listing.create({ data: { storeId, masterProductId, price, stockMode: "unlimited" } });
      return (await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label: "1", price, weightG: 100 } })).id;
    };
    variants.set(storeId, { food: await make(foodId, 1000), beauty: await make(beautyId, 333) });
  }

  async function cart(storeId: string, lines: Array<["food" | "beauty", number]>) {
    const row = await storeScoped(storeId).cart.create({ data: { storeId } });
    for (const [kind, qty] of lines) {
      await storeScoped(storeId).cartLine.create({ data: { storeId, cartId: row.id, variantId: variants.get(storeId)![kind], qty, swapRule: "exact_only" } });
    }
    return row.id;
  }

  /** The guest flow: quote, hold, card, place. */
  async function checkout(storeId: string, cartId: string) {
    const quote = await quoteCheckout(storeId, 0, cartId, CONTACT, "pickup");
    expect(quote.problems).toEqual([]);
    const pi = await createPaymentIntent(storeId, cartId, quote.holdCents);
    await getCheckoutPayments().confirmPaymentIntent(pi.paymentIntentId, { payment_method: "pm_card_visa" });
    const placed = await placeOrder(storeId, 0, cartId, CONTACT, "pickup", null, null, pi.paymentIntentId);
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.token } });
    return { quote, pi, order };
  }

  function install<T extends TaxCalculator>(calculator: T): T {
    setTaxCalculatorForTests(calculator);
    return calculator;
  }

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    // Store delivery is offered only while its proof photo can be kept (#765).
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    resetFakeCheckoutPayments();
    foodMaster = await category(FOOD);
    beautyMaster = await category(BEAUTY);
    tx = await store("tx", { state: "TX", city: "Houston", zip: "77002" });
    mt = await store("mt", { state: "MT", city: "Billings", zip: "59101" });
    bare = await store("bare", null);
    liable = await store("liable", { state: "TX", city: "Austin", zip: "78701" }, "store");
    for (const id of [tx, mt, bare, liable]) await stock(id, foodMaster, beautyMaster);
  });

  afterEach(() => setTaxCalculatorForTests(null));

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.stockEvent.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.cartLine.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    await platformAdmin.masterProduct.deleteMany({ where: { id: { in: masterIds } } });
    await platformAdmin.category.deleteMany({ where: { id: { in: categoryIds } } });
    resetFakeCheckoutPayments();
    await raw.$disconnect();
  });

  it("AC1, E8: a Texas pickup taxes the beauty line, not the food line, and the order and hold carry it", async () => {
    install(fakeTaxCalculator(RATES));
    const cartId = await cart(tx, [["food", 2], ["beauty", 3]]);
    const { quote, pi, order } = await checkout(tx, cartId);
    // 3 × $3.33 = 999 at 8.25% = 82.4 → 82; $20.00 of food is exempt.
    expect(quote.taxCents).toBe(82);
    expect(order.taxCents).toBe(82);
    const lines = order.taxLines as Array<{ amount: number; rate: string; jurisdiction: string; taxabilityReason: string }>;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(order.taxCents);
    expect(lines).toContainEqual({ amount: 0, rate: "0", jurisdiction: "TX", taxabilityReason: "product_exempt" });
    expect(lines).toContainEqual(expect.objectContaining({ amount: 82, jurisdiction: "TX" }));
    expect(order.taxLiableParty).toBe("platform");
    expect(order.taxCalculationId).toMatch(/^taxcalc_fake_/);
    expect(order.status).toBe("AUTHORIZED");
    // Hold = goods + tax + fee + 10% of (goods + tax).
    expect(order.totalCents).toBe(2999 + 82 + quote.serviceFeeCents);
    expect(order.totalAuthorizedCents).toBe(order.totalCents + Math.round((2999 + 82) / 10));
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.paymentIntentId)).amount).toBe(order.totalAuthorizedCents);
  });

  it("a basket whose lines the database returns in another order than they were added still places, taxed once", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    const cartId = await cart(tx, [["food", 1], ["beauty", 3]]);
    // Updating the first line writes a new row version, so a plain scan returns it after the second.
    await storeScoped(tx).cartLine.updateMany({ where: { cartId, variantId: variants.get(tx)!.food }, data: { qty: 2 } });
    const { order } = await checkout(tx, cartId);
    expect(order).toMatchObject({ status: "AUTHORIZED", taxCents: 82 });
    expect(fake.calls).toHaveLength(1);
  });

  it("a first delivery checkout is taxed at the confirmed delivery address, and places with that tax", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    const row = await platformAdmin.store.create({
      data: {
        slug: `${RUN}-texarkana`, name: "Tax delivery", pickupEnabled: true, stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        addressLine1: "100 Main St", city: "Texarkana", state: "TX", zip: "75501",
        lat: 33.4251, lng: -94.0477, deliveryRadiusMi: 8, storeDeliveryEnabled: true, storeDeliveryFeeCents: 500,
      },
    });
    storeIds.push(row.id);
    await stock(row.id, foodMaster, beautyMaster);
    const match = { lat: 33.4418, lng: -94.0377 };
    await writeGeocodeCache(ACROSS_THE_LINE, { ...ACROSS_THE_LINE, formattedAddress: "200 E BROAD ST, TEXARKANA, AR, 71854", ...match });
    const cartId = await cart(row.id, [["beauty", 3]]);

    // The order of createPaymentIntentAction: quote, hold, then the confirmed address is saved on the cart.
    const quote = await quoteCheckout(row.id, 0, cartId, CONTACT, "store-delivery", ACROSS_THE_LINE);
    expect(quote.problems).toEqual([]);
    const pi = await createPaymentIntent(row.id, cartId, quote.holdCents);
    await getCheckoutPayments().confirmPaymentIntent(pi.paymentIntentId, { payment_method: "pm_card_visa" });
    await saveDeliverySnapshot(row.id, cartId, { ...ACROSS_THE_LINE, ...match });
    const placed = await placeOrder(row.id, 0, cartId, CONTACT, "store-delivery", null, null, pi.paymentIntentId);

    // 3 × $3.33 = 999 at Arkansas's 9.5% = 94.9 → 95, shown before Pay and charged.
    expect(quote.taxCents).toBe(95);
    const order = await storeScoped(row.id).order.findUniqueOrThrow({ where: { id: placed.token } });
    expect(order).toMatchObject({ status: "AUTHORIZED", taxCents: 95, totalAuthorizedCents: quote.holdCents });
    const states = fake.calls.map((call) => (call.input as { address: { state: string } }).address.state);
    expect(states).toEqual(["AR"]);
  });

  it("#570 AC2, AC4: a prepared dish is taxed as prepared food, not exempt grocery, and its order line is exact item only", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    const scoped = storeScoped(tx);
    // Jollof on the exempt food master: the prepared flag, not the category, sets its tax code.
    const listing = await scoped.listing.create({ data: { storeId: tx, masterProductId: foodMaster, price: 1000, stockMode: "unlimited", prepared: "hot", prepMinutes: 15 } });
    const jollof = (await scoped.listingVariant.create({ data: { listingId: listing.id, label: "Plate", price: 1000, weightG: 400 } })).id;
    const cartId = (await scoped.cart.create({ data: { storeId: tx } })).id;
    // A line written before the owner marked it prepared still carries a swap; placement drops it.
    await scoped.cartLine.create({ data: { storeId: tx, cartId, variantId: jollof, qty: 1, swapRule: "named_substitute", substituteVariantId: variants.get(tx)!.food } });

    const { order } = await checkout(tx, cartId);

    const call = fake.calls[0]!.input as { lines: Array<{ reference: string; taxCode: string | null }> };
    expect(call.lines).toEqual([expect.objectContaining({ reference: jollof, taxCode: PREPARED_FOOD_TAX_CODE })]);
    // $10.00 at 8.25% = 82.5 → 83: prepared food is taxed where grocery food is exempt.
    expect(order.taxCents).toBe(83);
    const lines = await scoped.orderLine.findMany({ where: { orderId: order.id } });
    expect(lines).toEqual([expect.objectContaining({ listingVariantId: jollof, swapRule: "exact_only", substituteVariantId: null })]);
  });

  it("AC2: a Montana store collects no tax, and the zero is explained", async () => {
    install(fakeTaxCalculator(RATES));
    const { order } = await checkout(mt, await cart(mt, [["beauty", 3]]));
    expect(order.taxCents).toBe(0);
    expect((order.taxLines as Array<{ amount: number }>).every((line) => line.amount === 0)).toBe(true);
  });

  it("E2: a state the account is not registered in collects nothing, says why, and the order proceeds", async () => {
    install(fakeTaxCalculator(RATES));
    const oregon = await store("or", { state: "OR", city: "Portland", zip: "97201" });
    await stock(oregon, foodMaster, beautyMaster);
    const { order } = await checkout(oregon, await cart(oregon, [["beauty", 3]]));
    expect(order).toMatchObject({ status: "AUTHORIZED", taxCents: 0 });
    expect(order.taxLines).toEqual([{ amount: 0, rate: "0", jurisdiction: "OR", taxabilityReason: "not_collecting" }]);
  });

  it("a tax outage at placement releases the hold and places no order", async () => {
    install(fakeTaxCalculator(RATES));
    const cartId = await cart(tx, [["beauty", 1]]);
    const quote = await quoteCheckout(tx, 0, cartId, CONTACT, "pickup");
    const pi = await createPaymentIntent(tx, cartId, quote.holdCents);
    await getCheckoutPayments().confirmPaymentIntent(pi.paymentIntentId, { payment_method: "pm_card_visa" });
    // The pinned calculation no longer matches, so placement must ask Stripe again, and Stripe is down.
    await storeScoped(tx).cart.update({ where: { id: cartId }, data: { taxQuoteKey: null } });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { type: "StripeConnectionError" }));
    install(stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never));

    await expect(placeOrder(tx, 0, cartId, CONTACT, "pickup", null, null, pi.paymentIntentId)).rejects.toThrow(TAX_UNAVAILABLE_MESSAGE);
    expect((await getCheckoutPayments().retrievePaymentIntent(pi.paymentIntentId)).status).toBe("canceled");
    expect(await storeScoped(tx).order.count({ where: { sourceCartId: cartId } })).toBe(0);
  });

  it("E7: refreshing the quote reuses the pinned calculation; a basket change makes one new one", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    const cartId = await cart(tx, [["beauty", 1]]);
    await quoteCheckout(tx, 0, cartId, CONTACT, "pickup");
    await quoteCheckout(tx, 0, cartId, { ...CONTACT, name: "Ada Obi" }, "pickup");
    expect(fake.calls).toHaveLength(1);
    await storeScoped(tx).cartLine.updateMany({ where: { cartId }, data: { qty: 2 } });
    const quote = await quoteCheckout(tx, 0, cartId, CONTACT, "pickup");
    expect(fake.calls).toHaveLength(2);
    expect(quote.taxCents).toBe(Math.round(666 * 0.0825));
  });

  it("E1: a store without an address blocks checkout before any tax call or PaymentIntent", async () => {
    const create = vi.fn();
    install(stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never));
    const cartId = await cart(bare, [["beauty", 1]]);
    const quote = await quoteCheckout(bare, 0, cartId, CONTACT, "pickup");
    expect(quote.problems).toContainEqual({ code: "ineligible", message: TAX_LOCATION_MESSAGE });
    expect(create).not.toHaveBeenCalled();
    expect(await storeScoped(bare).cart.findUniqueOrThrow({ where: { id: cartId } })).toMatchObject({ paymentIntentId: null, taxQuoteKey: null });
  });

  it("E3, E4: an invalid location or a tax outage fails closed with no PaymentIntent and no order", async () => {
    for (const [error, message] of [
      [Object.assign(new Error("bad"), { code: "customer_tax_location_invalid" }), TAX_LOCATION_MESSAGE],
      [Object.assign(new Error("timeout"), { type: "StripeConnectionError" }), TAX_UNAVAILABLE_MESSAGE],
    ] as const) {
      const create = vi.fn().mockRejectedValue(error);
      install(stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never));
      const cartId = await cart(tx, [["beauty", 1]]);
      const quote = await quoteCheckout(tx, 0, cartId, CONTACT, "pickup");
      expect(quote.problems).toContainEqual({ code: "ineligible", message });
      expect(create).toHaveBeenCalledTimes(1);
      expect(await storeScoped(tx).order.count({ where: { sourceCartId: cartId } })).toBe(0);
    }
  });

  it("E13: a store-liable calculation carries the store's account; a platform one does not", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    await quoteCheckout(liable, 0, await cart(liable, [["beauty", 1]]), CONTACT, "pickup");
    await quoteCheckout(tx, 0, await cart(tx, [["beauty", 1]]), CONTACT, "pickup");
    const [storeCall, platformCall] = fake.calls.map((call) => call.input as { liableParty: string; stripeAccount: string | null });
    const account = (await platformAdmin.store.findUniqueOrThrow({ where: { id: liable } })).stripeAccountId;
    expect(storeCall).toMatchObject({ liableParty: "store", stripeAccount: account });
    expect(platformCall).toMatchObject({ liableParty: "platform" });
  });

  it("E16: each store's checkout is taxed at its own address", async () => {
    const fake = install(fakeTaxCalculator(RATES));
    await quoteCheckout(mt, 0, await cart(mt, [["beauty", 1]]), CONTACT, "pickup");
    await quoteCheckout(tx, 0, await cart(tx, [["beauty", 1]]), CONTACT, "pickup");
    const states = fake.calls.map((call) => (call.input as { address: { state: string } }).address.state);
    expect(states).toEqual(["MT", "TX"]);
  });
});
