import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const bucket = vi.hoisted(() => new Map<string, { body: Uint8Array; contentType: string; bucket: string }>());
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, { body: command.input.Body, contentType: command.input.ContentType, bucket: command.input.Bucket });
        return {};
      }
      throw new Error("NoSuchKey");
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

import sharp from "sharp";
import { testPrismaClient } from "@/lib/test-prisma";
import { findStuckTransitionalOrders, storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { feeRefundParts, fakeStripeProvider, refundRequests, reset, storeFundedRefundCents, setAuthorizedAmount, setNextRefundFailure, setNextRefundStatus, setRefundStatus } from "../stripe/fake";
import { systemAuditData } from "../system-actor";
import { countedListing } from "./stock-ledger-test-helpers";
import { ISSUE_ALREADY_REPORTED, ISSUE_PHOTO_INVALID, submitIssueReport } from "./issue-report";
import { evaluateOrderRefundState } from "./refund-requests";
import { captureSplit } from "./platform-fee";
import { reconcileStuckOrder } from "./service";
import { fakeTaxCalculator, setTaxCalculatorForTests } from "../tax/calculator";
import { reversePendingTaxRefunds } from "../tax/capture-tax";

const hasDb = !!process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!hasDb)("customer issue report", () => {
  const run = `ir428-${Date.now()}`;
  let raw: PrismaClient;
  let store = { id: "", autoRefundLimitCents: 4000 };
  let variantId = "";
  let number = 0;
  let ownerId = "";
  let couponId = "";
  let JPEG = new Uint8Array();

  beforeAll(async () => {
    JPEG = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c0392b" } }).jpeg().toBuffer());
    raw = testPrismaClient();
    const created = await raw.store.create({
      data: { slug: `ir-${run}`, name: "Issue Market", themePreset: "palm-and-shea", autoRefundLimitCents: 4000 },
    });
    store = { id: created.id, autoRefundLimitCents: created.autoRefundLimitCents };
    variantId = (await countedListing(store.id, 50)).variantId;
    ownerId = (await raw.user.create({ data: { id: crypto.randomUUID(), email: `${run}@example.com`, name: "Owner", emailVerified: true } })).id;
    couponId = (await storeScoped(store.id).storeCoupon.create({
      data: { storeId: store.id, code: "TENOFF", kind: "percent", percentOff: 10, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: ownerId },
    })).id;
    reset();
    setStripeProvider(fakeStripeProvider);
  });

  beforeEach(() => {
    bucket.clear();
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setTaxCalculatorForTests(null);
  });

  afterAll(async () => {
    setStripeProvider(null);
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId: store.id } });
      await tx.order.deleteMany({ where: { storeId: store.id } });
      await tx.customer.deleteMany({ where: { storeId: store.id } });
      await tx.storeCoupon.deleteMany({ where: { storeId: store.id } });
      await tx.stockEvent.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.store.deleteMany({ where: { id: store.id } });
    });
    if (ownerId) await raw.user.deleteMany({ where: { id: ownerId } });
    await raw.$disconnect();
  });

  type IssueLine = { qtyPicked: number; unitPriceCents: number; discountCents?: number; taxCents?: number; swap?: { qtyOrdered: number; unitPriceCents: number } };

  /**
   * A completed order (pickup unless a courier fee is given), captured at the picked total plus the sales tax
   * the final calculation gave (#65). A swapped line charges its substitute units too.
   */
  async function completedOrder(
    lines: IssueLine[],
    hoursAgo: number,
    serviceFeeCents = 0,
    courierFeeCents = 0,
    tax: { cents: number; liable?: "platform" | "store" } = { cents: 0 },
  ) {
    number += 1;
    const customer = await storeScoped(store.id).customer.create({ data: { storeId: store.id, name: `Issue ${number}` } });
    const goods = lines.reduce((sum, line) => sum + line.qtyPicked * line.unitPriceCents
      + (line.swap ? (line.swap.qtyOrdered - line.qtyPicked) * line.swap.unitPriceCents : 0), 0);
    const discountCents = lines.reduce((sum, line) => sum + (line.discountCents ?? 0), 0);
    const taxLiableParty = tax.liable ?? "platform";
    const captured = goods - discountCents + serviceFeeCents + courierFeeCents + tax.cents;
    const pi = `pi_issue_${number}_${run}`;
    setAuthorizedAmount(pi, captured);
    const platformTaxCents = taxLiableParty === "platform" ? tax.cents : 0;
    const fee = courierFeeCents > 0 || platformTaxCents > 0
      ? captureSplit({ capturedCents: captured, serviceFeeCents, courierFeeCents, platformTaxCents }).applicationFeeCents
      : undefined;
    await fakeStripeProvider.capturePaymentIntent(pi, captured, `cap-issue-${number}`, fee);
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        number,
        customerId: customer.id,
        status: "COMPLETED",
        fulfillment: courierFeeCents > 0 ? "courier" : "pickup",
        deliveryFeeCents: courierFeeCents,
        subtotalCents: goods,
        bufferCents: 0,
        totalAuthorizedCents: captured,
        totalCents: captured,
        capturedAmountCents: captured,
        serviceFeeCents,
        taxCents: tax.cents,
        taxLiableParty,
        discountCents,
        couponId: discountCents > 0 ? couponId : null,
        paymentIntentId: pi,
        trackingToken: `tok_${number}_${run}`,
        completedAt: new Date(Date.now() - hoursAgo * HOUR),
      },
    });
    await storeScoped(store.id).orderLine.createMany({
      data: lines.map((line) => ({
        storeId: store.id,
        orderId: order.id,
        listingVariantId: variantId,
        qtyOrdered: line.swap?.qtyOrdered ?? line.qtyPicked,
        qtyPicked: line.qtyPicked,
        unitPriceCents: line.unitPriceCents,
        substitutedUnitPriceCents: line.swap?.unitPriceCents ?? null,
        discountCents: line.discountCents ?? 0,
        taxCents: line.taxCents ?? 0,
        status: line.swap ? "substituted" : "picked",
      })),
    });
    const withLines = await storeScoped(store.id).order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: { orderBy: { unitPriceCents: "asc" } } },
    });
    return { order: withLines, token: order.trackingToken! };
  }

  async function written(orderId: string) {
    const scoped = storeScoped(store.id);
    return {
      issues: await scoped.issueReport.findMany({ where: { orderId } }),
      requests: await scoped.refundRequest.findMany({ where: { orderId } }),
      order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
    };
  }

  it("a completed order 47 h old reporting 2 of 3 lines with a photo is auto-refunded those lines and becomes Partly refunded", async () => {
    const { order, token } = await completedOrder([
      { qtyPicked: 2, unitPriceCents: 450 },
      { qtyPicked: 1, unitPriceCents: 1200 },
      { qtyPicked: 3, unitPriceCents: 1500 },
    ], 47);
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged",
      lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }],
      note: "Box was crushed",
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2100 });
    const after = await written(order.id);
    expect(after.issues).toHaveLength(1);
    expect(after.requests).toHaveLength(1);
    expect(after.issues[0]).toMatchObject({ amountCents: 2100, state: "auto_refunded", refundRequestId: after.requests[0].id });
    expect(after.requests[0]).toMatchObject({ amountCents: 2100, refundApplicationFee: true });
    const refunds = await fakeStripeProvider.listRefunds(order.paymentIntentId!);
    expect(refunds.map((refund) => refund.reservationKey)).toEqual([after.requests[0].key]);
    expect(after.order.status).toBe("PARTIALLY_REFUNDED");
    const photoKey = `issue-photo/${order.id}/${after.issues[0].id}.jpg`;
    expect(after.issues[0].photoKey).toBe(photoKey);
    expect(bucket.get(photoKey)).toMatchObject({ bucket: "proof-bucket", contentType: "image/jpeg" });
  });

  it("#495: an issue refund refunds the service fee in proportion to the goods refunded", async () => {
    // $66 of goods with a $1.98 fee; $21 of goods reported is 21/66 of the fee, 63¢.
    const { order, token } = await completedOrder([
      { qtyPicked: 2, unitPriceCents: 450 },
      { qtyPicked: 1, unitPriceCents: 1200 },
      { qtyPicked: 3, unitPriceCents: 1500 },
    ], 1, 198);
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged",
      lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }],
      note: "",
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2163 });
    expect((await written(order.id)).requests[0]).toMatchObject({ amountCents: 2163 });
  });

  it("#557: an issue refund deducts each line's share of the coupon discount, and the fee share follows the discounted goods", async () => {
    // $66.00 goods, 10% off stored per line (90 / 120 / 450), $59.40 charged for goods + $1.78 fee.
    const { order, token } = await completedOrder([
      { qtyPicked: 2, unitPriceCents: 450, discountCents: 90 },
      { qtyPicked: 1, unitPriceCents: 1200, discountCents: 120 },
      { qtyPicked: 3, unitPriceCents: 1500, discountCents: 450 },
    ], 1, 178);
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged",
      lines: [{ lineId: cheap.id, qty: 1 }, { lineId: middle.id, qty: 1 }],
      note: "",
      photo: JPEG,
    });
    // Goods (450 − 45) + (1200 − 120) = 1485; fee 178 × 1485 / 5940 = 44.5 → 45. Refund $15.30.
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 1530 });
    expect((await written(order.id)).requests[0]).toMatchObject({ amountCents: 1530 });
  });

  it("#495: a courier issue refund returns the service fee share from the platform fee, so the store funds the goods only", async () => {
    const { order, token } = await completedOrder([
      { qtyPicked: 2, unitPriceCents: 450 },
      { qtyPicked: 1, unitPriceCents: 1200 },
      { qtyPicked: 3, unitPriceCents: 1500 },
    ], 1, 198, 899);
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged",
      lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }],
      note: "",
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2163 });
    const [request] = (await written(order.id)).requests;
    // Courier recovery stays with the platform; only the 63¢ fee share comes back from it.
    expect(request).toMatchObject({ amountCents: 2163, refundApplicationFee: false, serviceFeeShareCents: 63 });
    expect(feeRefundParts.get(request.key)).toMatchObject({ amountCents: 63 });
    expect(request.feeRefundId).toBe(feeRefundParts.get(request.key)!.feeRefundId);
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(2100);
  });

  const THREE_LINES: IssueLine[] = [
    { qtyPicked: 2, unitPriceCents: 450 },
    { qtyPicked: 1, unitPriceCents: 1200 },
    { qtyPicked: 3, unitPriceCents: 1500 },
  ];

  it("#65 B6: an issue refund gives back the tax paid on the refunded goods", async () => {
    // $66 of goods, $1.98 fee, $5.45 tax. $21 of goods reported: 63¢ fee share + 545 × 2100 / 6600 = 173.4 → $1.73 tax.
    const { order, token } = await completedOrder(THREE_LINES, 1, 198, 0, { cents: 545 });
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged", lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }], note: "", photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2100 + 63 + 173 });
    expect((await written(order.id)).requests[0]).toMatchObject({ amountCents: 2336, refundApplicationFee: true, taxShareCents: 173, platformTaxShareCents: 0 });
  });

  it("#65 B5/B6: a courier issue refund of a platform-taxed order gives the tax back from the platform fee, so the store funds the goods only", async () => {
    const { order, token } = await completedOrder(THREE_LINES, 1, 198, 899, { cents: 545 });
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged", lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }], note: "", photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2336 });
    const [request] = (await written(order.id)).requests;
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(2100);
    expect(request).toMatchObject({ refundApplicationFee: false, serviceFeeShareCents: 63, taxShareCents: 173, platformTaxShareCents: 173 });
    expect(feeRefundParts.get(request.key)).toMatchObject({ amountCents: 63 + 173 });
  });

  it("#65 B5/B6: when the store collects the tax, a courier issue refund reverses the tax with the store's transfer", async () => {
    const { order, token } = await completedOrder(THREE_LINES, 1, 198, 899, { cents: 545, liable: "store" });
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged", lines: [{ lineId: cheap.id, qty: 2 }, { lineId: middle.id, qty: 1 }], note: "", photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2336 });
    const [request] = (await written(order.id)).requests;
    expect(request).toMatchObject({ serviceFeeShareCents: 63, taxShareCents: 173, platformTaxShareCents: 0 });
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(2100 + 173);
  });

  it("#65 B6: with a coupon, the tax share follows the discounted goods and an odd half cent rounds up", async () => {
    // $59.40 charged for goods after 10% off, $1.78 fee, $4.90 tax. Goods 1485: fee 44.5 → 45, tax 490 × 1485 / 5940 = 122.5 → 123.
    const { order, token } = await completedOrder([
      { qtyPicked: 2, unitPriceCents: 450, discountCents: 90 },
      { qtyPicked: 1, unitPriceCents: 1200, discountCents: 120 },
      { qtyPicked: 3, unitPriceCents: 1500, discountCents: 450 },
    ], 1, 178, 0, { cents: 490 });
    const [cheap, middle] = order.lines;
    const result = await submitIssueReport(store, token, {
      type: "damaged", lines: [{ lineId: cheap.id, qty: 1 }, { lineId: middle.id, qty: 1 }], note: "", photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 1485 + 45 + 123 });
  });

  it("#65 B6: after a swap, the tax share comes from the final tax on the goods actually charged", async () => {
    // 1 of 2 found at $12 and 1 swapped at $8: $20 charged, 60¢ fee, $1.65 final tax. The found unit: 36¢ + 99¢.
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 1200, swap: { qtyOrdered: 2, unitPriceCents: 800 } }], 1, 60, 899, { cents: 165 });
    const result = await submitIssueReport(store, token, { type: "missing", lines: [{ lineId: order.lines[0].id, qty: 1 }], note: "", photo: JPEG });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 1200 + 36 + 99 });
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1200);
  });

  // #671: $10 of soap (2 × $5, 83¢ tax at 8.25%) and $20 of exempt food in one basket; Stripe Tax recorded the sale.
  const MIXED: IssueLine[] = [{ qtyPicked: 2, unitPriceCents: 500, taxCents: 83 }, { qtyPicked: 1, unitPriceCents: 2000, taxCents: 0 }];
  const FOOD = "txcd_40040000";

  async function recordedSale(order: Awaited<ReturnType<typeof completedOrder>>["order"], liable: "platform" | "store" = "platform") {
    const tax = fakeTaxCalculator({ TX: { rate: 0.0825, exemptCodes: [FOOD] } });
    setTaxCalculatorForTests(tax);
    const calculation = await tax.calculate({
      address: { line1: "600 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
      lines: order.lines.map((line) => ({ reference: line.id, amountCents: line.qtyPicked * line.unitPriceCents, taxCode: line.taxCents > 0 ? null : FOOD })),
      liableParty: liable,
      stripeAccount: null,
      idempotencyKey: `sale-${order.id}`,
    });
    expect(calculation.lineTaxes.map((line) => line.taxCents)).toEqual(order.lines.map((line) => line.taxCents));
    const transaction = await tax.recordTransaction({ calculationId: calculation.id!, reference: `order_${order.id}`, liableParty: liable, stripeAccount: null });
    await storeScoped(store.id).order.update({ where: { id: order.id }, data: { taxCalculationId: calculation.id, taxTransactionId: transaction.id } });
    return tax;
  }

  it("#671 AC1/AC3: refunding the exempt food line of a mixed basket returns no tax and reverses that line once", async () => {
    const { order, token } = await completedOrder(MIXED, 1, 90, 0, { cents: 83 });
    const tax = await recordedSale(order);
    const [, food] = order.lines;
    const result = await submitIssueReport(store, token, { type: "damaged", lines: [{ lineId: food.id, qty: 1 }], note: "", photo: JPEG });
    // The proportional rule gave 83 × 2000 / 3000 = 55¢ of tax on food that carried none.
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 2000 + 60 });
    const [request] = (await written(order.id)).requests;
    expect(request).toMatchObject({ amountCents: 2060, taxShareCents: 0, platformTaxShareCents: 0 });
    expect(tax.reversals).toEqual([{
      id: request.taxReversalId, transactionId: "tax_txn_fake_1", reference: `refund_${request.id}`,
      plan: { mode: "lines", totalCents: 2000, lines: [{ reference: food.id, amountCents: 2000, taxCents: 0 }] },
    }]);
    // A second evaluation and the sweep make no second reversal.
    await evaluateOrderRefundState(order.id);
    expect(await reversePendingTaxRefunds(50, { storeIds: [store.id] })).toBe(0);
    expect(tax.reversals).toHaveLength(1);
  });

  it("#671 AC1: refunding the taxable line returns exactly its tax", async () => {
    const { order, token } = await completedOrder(MIXED, 1, 90, 0, { cents: 83 });
    const tax = await recordedSale(order);
    const [soap] = order.lines;
    const result = await submitIssueReport(store, token, { type: "damaged", lines: [{ lineId: soap.id, qty: 2 }], note: "", photo: JPEG });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 1000 + 30 + 83 });
    expect((await written(order.id)).requests[0]).toMatchObject({ taxShareCents: 83 });
    expect(tax.reversals.map((reversal) => reversal.plan)).toEqual([{ mode: "lines", totalCents: 1083, lines: [{ reference: soap.id, amountCents: 1000, taxCents: 83 }] }]);
  });

  it("#671 AC2: a courier refund of one taxed unit splits platform and store on the same exact amounts", async () => {
    const { order, token } = await completedOrder(MIXED, 1, 90, 899, { cents: 83 });
    const tax = await recordedSale(order);
    const [soap] = order.lines;
    // One of two soap units: $5 goods, 15¢ fee share, 83 / 2 = 41.5 → 42¢ tax.
    const result = await submitIssueReport(store, token, { type: "damaged", lines: [{ lineId: soap.id, qty: 1 }], note: "", photo: JPEG });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 500 + 15 + 42 });
    const [request] = (await written(order.id)).requests;
    expect(request).toMatchObject({ refundApplicationFee: false, serviceFeeShareCents: 15, taxShareCents: 42, platformTaxShareCents: 42 });
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(500);
    expect(feeRefundParts.get(request.key)).toMatchObject({ amountCents: 15 + 42 });
    expect(tax.reversals.map((reversal) => reversal.plan)).toEqual([{ mode: "lines", totalCents: 542, lines: [{ reference: soap.id, amountCents: 500, taxCents: 42 }] }]);
  });

  it("#671 AC3: a reversal that fails is made by the sweep, and a retry after a crash makes none extra", async () => {
    const { order, token } = await completedOrder(MIXED, 1, 90, 0, { cents: 83 });
    const tax = await recordedSale(order);
    const [soap] = order.lines;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(tax, "reverseTransaction").mockRejectedValueOnce(new Error("Stripe 500"));
    await submitIssueReport(store, token, { type: "damaged", lines: [{ lineId: soap.id, qty: 2 }], note: "", photo: JPEG });
    expect((await written(order.id)).requests[0].taxReversalId).toBeNull();
    expect(tax.reversals).toHaveLength(0);

    expect(await reversePendingTaxRefunds(50, { storeIds: [store.id] })).toBe(1);
    const [request] = (await written(order.id)).requests;
    expect(request.taxReversalId).toBe(tax.reversals[0].id);
    // The crash: Stripe made the reversal but the request never stored its id. The retry finds the same one.
    await storeScoped(store.id).refundRequest.update({ where: { id: request.id }, data: { taxReversalId: null } });
    expect(await reversePendingTaxRefunds(50, { storeIds: [store.id] })).toBe(1);
    expect(await reversePendingTaxRefunds(50, { storeIds: [store.id] })).toBe(0);
    expect(tax.reversals).toHaveLength(1);
    expect((await written(order.id)).requests[0].taxReversalId).toBe(tax.reversals[0].id);
  });

  it("#495: a courier fee share refund that errors is retried by the stuck-order sweep", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 2, unitPriceCents: 1000 }], 1, 99, 899);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeStripeProvider, "refundApplicationFeePart").mockRejectedValueOnce(new Error("Stripe down"));
    const result = await submitIssueReport(store, token, { type: "missing", lines: [{ lineId: order.lines[0].id, qty: 1 }], note: "", photo: JPEG });
    expect(result).toMatchObject({ state: "auto_refunded", amountCents: 1050 });
    expect((await written(order.id)).requests[0]).toMatchObject({ serviceFeeShareCents: 50, feeRefundId: null });
    const swept = async () => (await findStuckTransitionalOrders({ storeIds: [store.id] })).map((row) => row.id);
    expect(await swept()).toContain(order.id);
    await reconcileStuckOrder(store.id, order.id);
    expect((await written(order.id)).requests[0].feeRefundId).toMatch(/^fr_fake_/);
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1000);
    expect(await swept()).not.toContain(order.id);
  });

  it("#65: a tax share refund that errors on a courier order with no service fee is retried by the stuck-order sweep", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 2, unitPriceCents: 1000 }], 1, 0, 899, { cents: 165 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeStripeProvider, "refundApplicationFeePart").mockRejectedValueOnce(new Error("Stripe down"));
    const result = await submitIssueReport(store, token, { type: "missing", lines: [{ lineId: order.lines[0].id, qty: 1 }], note: "", photo: JPEG });
    // $10 of $20 goods: 82.5 → 83¢ of tax.
    expect(result).toMatchObject({ state: "auto_refunded", amountCents: 1083 });
    expect((await written(order.id)).requests[0]).toMatchObject({ serviceFeeShareCents: 0, platformTaxShareCents: 83, feeRefundId: null });
    const swept = async () => (await findStuckTransitionalOrders({ storeIds: [store.id] })).map((row) => row.id);
    expect(await swept()).toContain(order.id);
    await reconcileStuckOrder(store.id, order.id);
    expect((await written(order.id)).requests[0].feeRefundId).toMatch(/^fr_fake_/);
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1000);
    expect(await swept()).not.toContain(order.id);
  });

  it("the same order 49 h after completion is refused and nothing is written", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 49);
    const calls = refundRequests.length;
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result.ok).toBe(false);
    const after = await written(order.id);
    expect(after.issues).toHaveLength(0);
    expect(after.requests).toHaveLength(0);
    expect(refundRequests.length).toBe(calls);
    expect(bucket.size).toBe(0);
  });

  it("a report covering every captured cent makes the order Refunded", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 2, unitPriceCents: 800 }], 1);
    const result = await submitIssueReport(store, token, {
      type: "poor_freshness",
      lines: [{ lineId: order.lines[0].id, qty: 2 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 1600 });
    expect((await written(order.id)).order.status).toBe("REFUNDED");
  });

  it("a full issue refund that fails after it succeeded puts the order back to Completed", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 1000 }], 1);
    await submitIssueReport(store, token, {
      type: "damaged",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect((await written(order.id)).order.status).toBe("REFUNDED");
    const [refund] = await fakeStripeProvider.listRefunds(order.paymentIntentId!);
    setRefundStatus(refund.refundId, "failed");
    await evaluateOrderRefundState(order.id);
    const after = await written(order.id);
    expect(after.issues[0].state).toBe("refund_failed");
    expect(after.order.status).toBe("COMPLETED");
  });

  it("a refund Stripe answers as failed is reported to the customer as failed, not refunded", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    setNextRefundStatus(order.paymentIntentId!, "failed");
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "refund_failed", amountCents: 900 });
    expect((await written(order.id)).order.status).toBe("COMPLETED");
  });

  it("a refund Stripe refuses at creation marks the issue refund_failed with one alert", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    vi.spyOn(fakeStripeProvider, "refundPayment").mockRejectedValue(
      Object.assign(new Error("charge is disputed"), { type: "StripeInvalidRequestError", statusCode: 400, code: "charge_disputed" }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "refund_failed", amountCents: 900 });
    const after = await written(order.id);
    expect(after.issues[0].state).toBe("refund_failed");
    expect(after.order.status).toBe("COMPLETED");
    const alerts = await storeScoped(store.id).auditLog.findMany({ where: { entityId: order.id, action: "issue_refund_failed" } });
    expect(alerts).toHaveLength(1);
    const issueRequest = after.requests.find((request) => request.id === after.issues[0].refundRequestId);
    expect(alerts[0].after).toMatchObject({ key: issueRequest!.key });
    await evaluateOrderRefundState(order.id);
    expect(await storeScoped(store.id).auditLog.count({ where: { entityId: order.id, action: "issue_refund_failed" } })).toBe(1);
  });

  it("a Stripe read error before the refund request is saved marks the issue refund_failed with one alert, not in_review", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    vi.spyOn(fakeStripeProvider, "retrievePaymentIntent").mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { type: "StripeRateLimitError", statusCode: 429 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "refund_failed", amountCents: 900 });
    const after = await written(order.id);
    expect(after.issues[0]).toMatchObject({ state: "refund_failed", refundRequestId: null });
    expect(after.requests).toHaveLength(0);
    expect(after.order.status).toBe("COMPLETED");
    const alerts = await storeScoped(store.id).auditLog.findMany({ where: { entityId: order.id, action: "issue_refund_failed" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].after).toMatchObject({ issueReportId: after.issues[0].id, alert: "store_and_platform" });
  });

  it("after a dashboard refund, a report for more than remains is refunded only the remainder and the issue shows that amount", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    await fakeStripeProvider.refundPayment(order.paymentIntentId!, 500, `dashboard-${order.id}`);
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 400 });
    const after = await written(order.id);
    expect(after.issues[0].amountCents).toBe(400);
    expect(after.requests[0].amountCents).toBe(400);
    expect(after.order.status).toBe("REFUNDED");
  });

  it("a capped issue refund whose Stripe call errors still shows the capped amount, not the reported one", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    await fakeStripeProvider.refundPayment(order.paymentIntentId!, 500, `dashboard-${order.id}`);
    setNextRefundFailure(order.paymentIntentId!);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toMatchObject({ ok: true, amountCents: 400 });
    const after = await written(order.id);
    expect(after.issues[0]).toMatchObject({ amountCents: 400, refundRequestId: after.requests[0].id });
  });

  it("an under-limit report the refund ledger blocks goes to review with no refund request", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 1);
    await storeScoped(store.id).auditLog.create({ data: systemAuditData(store.id, order.id, "refund_resolved_manually") });
    const calls = refundRequests.length;
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "in_review", amountCents: 900 });
    const after = await written(order.id);
    expect(after.issues[0]).toMatchObject({ state: "in_review", refundRequestId: null });
    expect(after.requests).toHaveLength(0);
    expect(refundRequests.length).toBe(calls);
    expect(await storeScoped(store.id).auditLog.count({ where: { entityId: order.id, action: "issue_refund_failed" } })).toBe(0);
  });

  it("an amount $1 over the limit goes to review with no refund and the order unchanged", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 4100 }], 2);
    const calls = refundRequests.length;
    const result = await submitIssueReport(store, token, {
      type: "wrong",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result).toEqual({ ok: true, state: "in_review", amountCents: 4100 });
    const after = await written(order.id);
    expect(after.issues[0]).toMatchObject({ amountCents: 4100, state: "in_review", refundRequestId: null });
    expect(after.requests).toHaveLength(0);
    expect(refundRequests.length).toBe(calls);
    expect(after.order.status).toBe("COMPLETED");
  });

  it("a second report on the same order is refused with contact the store", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 4100 }, { qtyPicked: 1, unitPriceCents: 4200 }], 2);
    const input = (lineId: string) => ({ type: "wrong" as const, lines: [{ lineId, qty: 1 }], note: null, photo: JPEG });
    expect((await submitIssueReport(store, token, input(order.lines[0].id))).ok).toBe(true);
    expect(await submitIssueReport(store, token, input(order.lines[1].id))).toEqual({ ok: false, error: ISSUE_ALREADY_REPORTED });
    expect(ISSUE_ALREADY_REPORTED).toMatch(/contact the store/i);
    expect((await written(order.id)).issues).toHaveLength(1);
  });

  it("token A submitting a line from order B is refused and nothing is written", async () => {
    const a = await completedOrder([{ qtyPicked: 1, unitPriceCents: 500 }], 1);
    const b = await completedOrder([{ qtyPicked: 1, unitPriceCents: 700 }], 1);
    const calls = refundRequests.length;
    const result = await submitIssueReport(store, a.token, {
      type: "missing",
      lines: [{ lineId: b.order.lines[0].id, qty: 1 }],
      note: null,
      photo: JPEG,
    });
    expect(result.ok).toBe(false);
    for (const id of [a.order.id, b.order.id]) {
      const after = await written(id);
      expect(after.issues).toHaveLength(0);
      expect(after.requests).toHaveLength(0);
      expect(after.order.status).toBe("COMPLETED");
    }
    expect(refundRequests.length).toBe(calls);
    expect(bucket.size).toBe(0);
  });
  it("#743 AC1: a missing item needs no photo, so the report is saved with none and nothing is uploaded", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 2, unitPriceCents: 450 }], 3);
    const result = await submitIssueReport(store, token, {
      type: "missing",
      lines: [{ lineId: order.lines[0].id, qty: 1 }],
      note: null,
      photo: null,
    });
    expect(result).toEqual({ ok: true, state: "auto_refunded", amountCents: 450 });
    const after = await written(order.id);
    expect(after.issues).toHaveLength(1);
    expect(after.issues[0].photoKey).toBeNull();
    expect(bucket.size).toBe(0);
  });

  it("#743 AC1: a damaged or wrong item with no photo is refused and nothing is written", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 1, unitPriceCents: 900 }], 3);
    for (const type of ["damaged", "wrong"] as const) {
      const result = await submitIssueReport(store, token, { type, lines: [{ lineId: order.lines[0].id, qty: 1 }], note: null, photo: null });
      expect(result).toEqual({ ok: false, error: ISSUE_PHOTO_INVALID });
    }
    expect((await written(order.id)).issues).toHaveLength(0);
    expect(bucket.size).toBe(0);
  });
});
