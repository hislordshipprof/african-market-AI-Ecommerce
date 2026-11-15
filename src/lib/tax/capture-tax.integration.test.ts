import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { capturedPayments, fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { markReady } from "../order/service";
import { fakeTaxCalculator, setTaxCalculatorForTests, TaxUnavailableError, type FakeTaxCall } from "./calculator";
import { recordPendingTaxTransactions } from "./capture-tax";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t65c-${Date.now().toString(36)}`;
const RATES = { TX: { rate: 0.0825, exemptCodes: ["txcd_40040000"] } };

type LineSpec = { price: number; qty: number; status: "picked" | "refunded"; qtyPicked: number };
type OrderSpec = { lines: LineSpec[]; taxCents: number; taxCalculationId: string | null; holdCents?: number; couponId?: string };

function calls(fake: { calls: FakeTaxCall[] }, kind: FakeTaxCall["kind"]) {
  return fake.calls.filter((call) => call.kind === kind).map((call) => call.input);
}

describe.skipIf(!hasDb)("tax at capture (#65 E9–E14, lane DB)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];
  let storeId = "";
  let liableStoreId = "";
  const customers = new Map<string, string>();
  let seq = 0;
  let ownerId = "";

  async function newStore(slug: string, liable: "platform" | "store") {
    const store = await raw.store.create({
      data: {
        slug, name: "Ada's Market", themePreset: "palm-and-shea",
        addressLine1: "100 Main St", city: "Houston", state: "TX", zip: "77002",
        taxLiableParty: liable, stripeAccountId: liable === "store" ? `acct_${RUN}` : null,
      },
    });
    storeIds.push(store.id);
    customers.set(store.id, (await storeScoped(store.id).customer.create({
      data: { storeId: store.id, name: "Ada", phone: "+13014482210", email: "ada@example.com" },
    })).id);
    return store.id;
  }

  async function order(spec: OrderSpec, inStore = storeId) {
    const subtotal = spec.lines.reduce((sum, line) => sum + line.price * line.qty, 0);
    const hold = spec.holdCents ?? subtotal + spec.taxCents + Math.min(2000, Math.round((subtotal + spec.taxCents) / 10));
    const paymentIntentId = `pi_${RUN}_${++seq}`;
    const liable = inStore === liableStoreId ? "store" : "platform";
    const created = await storeScopedTransaction(inStore, async (tx) => {
      const row = await tx.order.create({
        data: {
          storeId: inStore, number: seq, customerId: customers.get(inStore)!, status: "PICKING",
          subtotalCents: subtotal, bufferCents: hold - subtotal - spec.taxCents, totalAuthorizedCents: hold,
          totalCents: subtotal + spec.taxCents, paymentIntentId, acceptedAt: new Date(),
          taxCents: spec.taxCents, taxCalculationId: spec.taxCalculationId, taxLiableParty: liable,
          couponId: spec.couponId ?? null,
          trackingToken: `tok_${RUN}_${seq}_${"x".repeat(20)}`,
        },
      });
      const lineIds: string[] = [];
      for (const [index, line] of spec.lines.entries()) {
        const listing = await tx.listing.create({ data: { storeId: inStore, customName: `Item ${seq}-${index}`, price: line.price, stockMode: "untracked" } });
        const variant = await tx.listingVariant.create({ data: { listingId: listing.id, label: "1 unit", price: line.price, weightG: 100 } });
        lineIds.push((await tx.orderLine.create({
          data: {
            storeId: inStore, orderId: row.id, listingVariantId: variant.id, qtyOrdered: line.qty,
            qtyPicked: line.qtyPicked, unitPriceCents: line.price, status: line.status, swapRule: "exact_only",
          },
        })).id);
      }
      return { id: row.id, lineIds };
    });
    setAuthorizedAmount(paymentIntentId, hold);
    return { ...created, paymentIntentId, hold };
  }

  async function stored(orderId: string, inStore = storeId) {
    return storeScoped(inStore).order.findUniqueOrThrow({ where: { id: orderId } });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    setStripeProvider(fakeStripeProvider);
    storeId = await newStore(`tax-${RUN}`, "platform");
    liableStoreId = await newStore(`tax-liable-${RUN}`, "store");
  });

  afterEach(() => {
    setTaxCalculatorForTests(null);
  });

  afterAll(async () => {
    setStripeProvider(null);
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.notificationLog.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.storeCoupon.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
    });
    await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    if (ownerId) await raw.user.deleteMany({ where: { id: ownerId } });
    await raw.$disconnect();
  });

  it("E9: a short makes a fresh calculation on the picked goods, captures goods plus that tax, and records it", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    // Checkout taxed $25.00 at 8.25%: 165 + 41 = 206. One of the two $10 units was short.
    const placed = await order({
      taxCents: 206, taxCalculationId: "taxcalc_checkout",
      lines: [{ price: 1000, qty: 2, status: "refunded", qtyPicked: 1 }, { price: 500, qty: 1, status: "picked", qtyPicked: 1 }],
    });

    const result = await markReady(storeId, placed.id);

    // Final goods $15.00: 83 + 41 = 124 tax.
    expect(result).toEqual({ ok: true, capturedAmountCents: 1500 + 124 });
    expect(capturedPayments.get(placed.paymentIntentId)).toBe(1624);
    expect(1624).toBeLessThanOrEqual(placed.hold);
    const [calculation] = calls(tax, "calculate") as Array<{ lines: Array<{ reference: string; amountCents: number }>; address: { state: string } }>;
    expect(calculation.address.state).toBe("TX");
    expect(calculation.lines).toEqual([
      expect.objectContaining({ reference: placed.lineIds[0], amountCents: 1000 }),
      expect.objectContaining({ reference: placed.lineIds[1], amountCents: 500 }),
    ]);
    expect(calls(tax, "transaction")).toEqual([
      { calculationId: "taxcalc_fake_1", reference: `order_${placed.id}`, liableParty: "platform", stripeAccount: null },
    ]);
    const row = await stored(placed.id);
    expect(row).toMatchObject({ status: "AWAITING_PICKUP", taxCents: 124, taxCalculationId: "taxcalc_fake_1", taxTransactionId: "tax_txn_fake_1" });
  });

  it("taxes each line after its share of the coupon discount", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    ownerId = (await raw.user.create({ data: { id: crypto.randomUUID(), email: `${RUN}-owner@example.com`, name: "Owner", emailVerified: true } })).id;
    const coupon = await storeScoped(storeId).storeCoupon.create({
      data: { storeId, code: `TEN${seq}`, kind: "percent", percentOff: 10, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: ownerId },
    });
    const placed = await order({ taxCents: 149, taxCalculationId: "taxcalc_checkout", couponId: coupon.id, lines: [{ price: 2000, qty: 1, status: "picked", qtyPicked: 1 }] });

    // $20.00 less 10% is $18.00, taxed 148.5 -> 149.
    expect(await markReady(storeId, placed.id)).toEqual({ ok: true, capturedAmountCents: 1800 + 149 });
    expect(await stored(placed.id)).toMatchObject({ discountCents: 200, taxCents: 149 });
  });

  it("an order placed before tax captures its goods as before, with no tax call", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const placed = await order({ taxCents: 0, taxCalculationId: null, lines: [{ price: 1200, qty: 1, status: "picked", qtyPicked: 1 }] });

    expect(await markReady(storeId, placed.id)).toEqual({ ok: true, capturedAmountCents: 1200 });
    expect(tax.calls).toEqual([]);
    expect(await stored(placed.id)).toMatchObject({ status: "AWAITING_PICKUP", taxCents: 0, taxCalculationId: null, taxTransactionId: null });
  });

  it("E10: a failed tax transaction leaves the capture standing and pending, and the sweep records it", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests({ calculate: tax.calculate, recordTransaction: async () => { throw new Error("Stripe 500"); } });
    const placed = await order({ taxCents: 83, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "picked", qtyPicked: 1 }] });

    expect(await markReady(storeId, placed.id)).toEqual({ ok: true, capturedAmountCents: 1083 });
    expect(capturedPayments.get(placed.paymentIntentId)).toBe(1083);
    expect(await stored(placed.id)).toMatchObject({ status: "AWAITING_PICKUP", taxCalculationId: "taxcalc_fake_1", taxTransactionId: null });

    setTaxCalculatorForTests(tax);
    expect(await recordPendingTaxTransactions(50, { storeIds: [storeId] })).toBe(1);
    expect(calls(tax, "transaction")).toEqual([
      { calculationId: "taxcalc_fake_1", reference: `order_${placed.id}`, liableParty: "platform", stripeAccount: null },
    ]);
    expect(await stored(placed.id)).toMatchObject({ status: "AWAITING_PICKUP", capturedAmountCents: 1083, taxTransactionId: "tax_txn_fake_1" });
  });

  it("E11: a retry after a crash finds the same transaction for the reference and records it once", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const placed = await order({ taxCents: 83, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "picked", qtyPicked: 1 }] });
    await markReady(storeId, placed.id);
    // The crash: Stripe recorded the transaction but the order never stored its id.
    await storeScoped(storeId).order.update({ where: { id: placed.id }, data: { taxTransactionId: null } });

    expect(await recordPendingTaxTransactions(50, { storeIds: [storeId] })).toBe(1);
    expect(await recordPendingTaxTransactions(50, { storeIds: [storeId] })).toBe(0);
    const references = calls(tax, "transaction").map((input) => (input as { reference: string }).reference);
    expect(references).toEqual([`order_${placed.id}`, `order_${placed.id}`]);
    expect(await stored(placed.id)).toMatchObject({ taxTransactionId: "tax_txn_fake_1" });
  });

  it("E12: an order voided before capture gets no transaction, now or from the sweep", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const placed = await order({ taxCents: 83, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "refunded", qtyPicked: 0 }] });

    expect(await markReady(storeId, placed.id)).toEqual({ ok: true, capturedAmountCents: 0, voided: true });
    expect(await recordPendingTaxTransactions(50, { storeIds: [storeId] })).toBe(0);
    expect(calls(tax, "transaction")).toEqual([]);
    expect(await stored(placed.id)).toMatchObject({ status: "CANCELLED", taxTransactionId: null });
  });

  it("E13: when the store is liable, the calculation and the transaction go to its account", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const placed = await order({ taxCents: 83, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "picked", qtyPicked: 1 }] }, liableStoreId);

    expect(await markReady(liableStoreId, placed.id)).toEqual({ ok: true, capturedAmountCents: 1083 });
    expect(calls(tax, "calculate")).toEqual([expect.objectContaining({ liableParty: "store", stripeAccount: `acct_${RUN}` })]);
    expect(calls(tax, "transaction")).toEqual([
      { calculationId: "taxcalc_fake_1", reference: `order_${placed.id}`, liableParty: "store", stripeAccount: `acct_${RUN}` },
    ]);
    // The PaymentIntent is captured on the platform: the provider's capture takes no connected account.
    expect(capturedPayments.get(placed.paymentIntentId)).toBe(1083);
  });

  it("E14: odd cents (3 x $3.33) store a tax equal to the sum of its lines, within the hold", async () => {
    const tax = fakeTaxCalculator(RATES);
    setTaxCalculatorForTests(tax);
    const odd = { price: 333, qty: 1, status: "picked" as const, qtyPicked: 1 };
    const placed = await order({ taxCents: 81, taxCalculationId: "taxcalc_checkout", lines: [odd, odd, odd] });

    const result = await markReady(storeId, placed.id);

    const row = await stored(placed.id);
    const lines = row.taxLines as Array<{ amount: number }>;
    expect(row.taxCents).toBe(81);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(81);
    expect(result).toEqual({ ok: true, capturedAmountCents: 999 + 81 });
    expect(999 + 81).toBeLessThanOrEqual(placed.hold);
  });

  it("a tax outage before capture fails with a retryable message and captures nothing", async () => {
    setTaxCalculatorForTests({
      calculate: async () => { throw new TaxUnavailableError(new Error("timeout")); },
      recordTransaction: async () => ({ id: "unused" }),
    });
    const placed = await order({ taxCents: 83, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "picked", qtyPicked: 1 }] });

    const result = await markReady(storeId, placed.id);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/try again/i) });
    expect(capturedPayments.has(placed.paymentIntentId)).toBe(false);
    expect(await stored(placed.id)).toMatchObject({ status: "PICKING", capturedAmountCents: null });
  });

  it("a line that changes while tax is calculated stops the capture, to try again", async () => {
    const tax = fakeTaxCalculator(RATES);
    const placed = await order({ taxCents: 124, taxCalculationId: "taxcalc_checkout", lines: [{ price: 1000, qty: 1, status: "picked", qtyPicked: 1 }, { price: 500, qty: 1, status: "picked", qtyPicked: 1 }] });
    // Staff mark a line short while Stripe works out the tax.
    setTaxCalculatorForTests({
      calculate: async (input) => {
        await storeScoped(storeId).orderLine.update({ where: { id: placed.lineIds[0] }, data: { status: "refunded", qtyPicked: 0 } });
        return tax.calculate(input);
      },
      recordTransaction: tax.recordTransaction,
    });

    expect(await markReady(storeId, placed.id)).toEqual({ ok: false, error: "Order changed during capture, try again" });
    expect(capturedPayments.has(placed.paymentIntentId)).toBe(false);
    expect(await stored(placed.id)).toMatchObject({ status: "PICKING" });
  });
});
