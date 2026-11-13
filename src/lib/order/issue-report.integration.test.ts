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
import { storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { feeRefundParts, fakeStripeProvider, refundRequests, reset, storeFundedRefundCents, setAuthorizedAmount, setNextRefundFailure, setNextRefundStatus, setRefundStatus } from "../stripe/fake";
import { systemAuditData } from "../system-actor";
import { countedListing } from "./stock-ledger-test-helpers";
import { ISSUE_ALREADY_REPORTED, submitIssueReport } from "./issue-report";
import { evaluateOrderRefundState } from "./refund-requests";
import { captureSplit } from "./platform-fee";

const hasDb = !!process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!hasDb)("customer issue report", () => {
  const run = `ir428-${Date.now()}`;
  let raw: PrismaClient;
  let store = { id: "", autoRefundLimitCents: 4000 };
  let variantId = "";
  let number = 0;
  let JPEG = new Uint8Array();

  beforeAll(async () => {
    JPEG = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c0392b" } }).jpeg().toBuffer());
    raw = testPrismaClient();
    const created = await raw.store.create({
      data: { slug: `ir-${run}`, name: "Issue Market", themePreset: "palm-and-shea", autoRefundLimitCents: 4000 },
    });
    store = { id: created.id, autoRefundLimitCents: created.autoRefundLimitCents };
    variantId = (await countedListing(store.id, 50)).variantId;
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
      await tx.stockEvent.deleteMany({ where: { storeId: store.id } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: store.id } } });
      await tx.listing.deleteMany({ where: { storeId: store.id } });
      await tx.store.deleteMany({ where: { id: store.id } });
    });
    await raw.$disconnect();
  });

  /** A completed order (pickup unless a courier fee is given): three lines, captured at the picked total. */
  async function completedOrder(lines: Array<{ qtyPicked: number; unitPriceCents: number }>, hoursAgo: number, serviceFeeCents = 0, courierFeeCents = 0) {
    number += 1;
    const customer = await storeScoped(store.id).customer.create({ data: { storeId: store.id, name: `Issue ${number}` } });
    const goods = lines.reduce((sum, line) => sum + line.qtyPicked * line.unitPriceCents, 0);
    const captured = goods + serviceFeeCents + courierFeeCents;
    const pi = `pi_issue_${number}_${run}`;
    setAuthorizedAmount(pi, captured);
    const fee = courierFeeCents > 0 ? captureSplit({ capturedCents: captured, serviceFeeCents, courierFeeCents }).applicationFeeCents : undefined;
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
        qtyOrdered: line.qtyPicked,
        qtyPicked: line.qtyPicked,
        unitPriceCents: line.unitPriceCents,
        status: "picked",
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

  it("#495: a courier fee share refund that errors is retried by the next evaluation", async () => {
    const { order, token } = await completedOrder([{ qtyPicked: 2, unitPriceCents: 1000 }], 1, 99, 899);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeStripeProvider, "refundApplicationFeePart").mockRejectedValueOnce(new Error("Stripe down"));
    const result = await submitIssueReport(store, token, { type: "missing", lines: [{ lineId: order.lines[0].id, qty: 1 }], note: "", photo: JPEG });
    expect(result).toMatchObject({ state: "auto_refunded", amountCents: 1050 });
    expect((await written(order.id)).requests[0]).toMatchObject({ serviceFeeShareCents: 50, feeRefundId: null });
    await evaluateOrderRefundState(order.id);
    expect((await written(order.id)).requests[0].feeRefundId).toMatch(/^fr_fake_/);
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1000);
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
});
