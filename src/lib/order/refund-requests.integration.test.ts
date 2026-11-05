import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { OverRefundError } from "../stripe/errors";
import { fakeStripeProvider, refundRequests, reset, setAuthorizedAmount } from "../stripe/fake";
import { autoCancelOrder, reconcileStuckOrder } from "./service";
import { reconcileRefundRequest, REPLAY_LEASE_MS, submitRefund } from "./refund-requests";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("refund request ledger", () => {
  const run = `rr186-${Date.now()}`;
  let raw: PrismaClient;
  let storeId = "";
  let number = 27000;

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    const store = await raw.store.create({
      data: { slug: `rr-${run}`, name: "Refund requests", themePreset: "palm-and-shea", prepTimeMinutes: 20 },
    });
    storeId = store.id;
    reset();
    setStripeProvider(fakeStripeProvider);
  });

  afterAll(async () => {
    setStripeProvider(null);
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId } });
      await tx.order.deleteMany({ where: { storeId } });
      await tx.customer.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
    });
    await raw.$disconnect();
  });

  async function cancellingOrder(cents = 1000) {
    number += 1;
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: `Ledger ${number}` },
    });
    const pi = `pi_ledger_${number}_${run}`;
    setAuthorizedAmount(pi, cents);
    await fakeStripeProvider.capturePaymentIntent(pi, cents, `cap-${number}`);
    const order = await storeScoped(storeId).order.create({
      data: {
        storeId,
        number,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: cents,
        bufferCents: 0,
        totalAuthorizedCents: cents,
        totalCents: cents,
        capturedAmountCents: cents,
        paymentIntentId: pi,
      },
    });
    return { order, pi };
  }

  async function readyToRefund(cents = 1000) {
    const created = await cancellingOrder(cents);
    await storeScoped(storeId).order.update({
      where: { id: created.order.id },
      data: { status: "CANCELLING" },
    });
    return created;
  }

  it("a replay after a partial dashboard refund reuses the stored amount, then refunds the rest", async () => {
    const { order, pi } = await readyToRefund();
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    let calls = 0;
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        await original(pi, 100, "dashboard-100");
        throw new OverRefundError("Refund amount ($10.00) is greater than unrefunded amount on charge ($9.00)");
      }
      return original(...args);
    });
    try {
      const result = await submitRefund(storeId, order.id, pi);
      expect(result).toMatchObject({ status: "succeeded", amountRefunded: 900 });
      const rows = await storeScoped(storeId).refundRequest.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      expect(rows.map((row) => ({ state: row.state, amount: row.amountCents }))).toEqual([
        { state: "NOT_CREATED", amount: 1000 },
        { state: "CREATED", amount: 900 },
      ]);
      const listed = await fakeStripeProvider.listRefunds(pi);
      const succeeded = listed.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amountRefunded, 0);
      expect(succeeded).toBe(1000);
    } finally {
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a 409 keeps the same key and amount", async () => {
    const { order, pi } = await readyToRefund();
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const keys: string[] = [];
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (paymentIntentId, amount, key, options) => {
      keys.push(key ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("in flight"), { statusCode: 409, code: "idempotency_key_in_use" });
      }
      return original(paymentIntentId, amount, key, options);
    });
    try {
      const first = await submitRefund(storeId, order.id, pi);
      expect(first).toEqual({ inFlight: true });
      const second = await submitRefund(storeId, order.id, pi);
      expect(second).toMatchObject({ status: "succeeded", amountRefunded: 1000 });
      expect(keys).toEqual([`refund:${order.id}:1`, `refund:${order.id}:1`]);
      expect(refundRequests.filter((request) => request.paymentIntentId === pi)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a connection error never releases the request on an unchanged read", async () => {
    const { order, pi } = await readyToRefund();
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async () => {
      throw Object.assign(new Error("connection"), { type: "StripeConnectionError" });
    });
    try {
      await expect(submitRefund(storeId, order.id, pi)).rejects.toThrow(/connection/);
      const during = await storeScoped(storeId).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
      expect(during.state).toBe("UNKNOWN");
      expect(await submitRefund(storeId, order.id, pi)).toEqual({ inFlight: true });
      const after = await storeScoped(storeId).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
      expect(after.state).toBe("UNKNOWN");
      expect(after.key).toBe(during.key);
      expect(await fakeStripeProvider.listRefunds(pi)).toHaveLength(0);
    } finally {
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("settlement does not finalize while a request is open", async () => {
    const { order } = await cancellingOrder();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const cancel = autoCancelOrder(storeId, order.id);
    try {
      await enteredGate;
      const swept = await reconcileStuckOrder(storeId, order.id);
      expect(swept).toEqual({ ok: false, error: "Refund is still confirming with the bank", waiting: true });
      const stored = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(stored?.status).toBe("CANCELLING");
    } finally {
      release();
      await cancel.catch(() => {});
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("sweep reconciles open requests on REFUND_FAILED and CANCELLED orders", async () => {
    const failed = await cancellingOrder();
    const cancelled = await cancellingOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: failed.order.id }, data: { status: "REFUND_FAILED" } });
      await tx.order.update({ where: { id: cancelled.order.id }, data: { status: "CANCELLED" } });
      const stale = new Date(Date.now() - 23 * 60 * 60 * 1000 - 1000);
      await tx.refundRequest.create({
        data: {
          storeId,
          orderId: failed.order.id,
          paymentIntentId: failed.pi,
          key: `refund:${failed.order.id}:1`,
          amountCents: 1000,
          refundApplicationFee: true,
          state: "UNKNOWN",
          createdAt: stale,
        },
      });
      await tx.refundRequest.create({
        data: {
          storeId,
          orderId: cancelled.order.id,
          paymentIntentId: cancelled.pi,
          key: `refund:${cancelled.order.id}:1`,
          amountCents: 1000,
          refundApplicationFee: true,
          state: "RESERVED",
          createdAt: stale,
        },
      });
    });
    expect(await reconcileStuckOrder(storeId, failed.order.id)).toEqual({ ok: true, action: "already_resolved" });
    expect(await reconcileStuckOrder(storeId, cancelled.order.id)).toEqual({ ok: true, action: "already_resolved" });
    const rows = await storeScoped(storeId).refundRequest.findMany({
      where: { orderId: { in: [failed.order.id, cancelled.order.id] } },
    });
    expect(rows.every((row) => row.state === "ABANDONED")).toBe(true);
    const alerts = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: { in: [failed.order.id, cancelled.order.id] }, action: "refund_request_unknown" },
    });
    expect(alerts).toHaveLength(2);
  });

  it("concurrent abandonment writes one alert", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "REFUND_FAILED" } });
      await tx.refundRequest.create({
        data: {
          storeId,
          orderId: order.id,
          paymentIntentId: pi,
          key,
          amountCents: 1000,
          refundApplicationFee: true,
          state: "UNKNOWN",
          createdAt: stale,
        },
      });
    });
    const row = await storeScoped(storeId).refundRequest.findFirst({ where: { key } });
    await Promise.all([reconcileRefundRequest(row!), reconcileRefundRequest(row!)]);
    await reconcileRefundRequest(row!);
    const alerts = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_request_unknown" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.after).toMatchObject({ key, alert: "platform" });
  });

  it("two replays of one request send one refund", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const row = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "UNKNOWN",
      },
    });
    await Promise.all([reconcileRefundRequest(row), reconcileRefundRequest(row)]);
    const sent = refundRequests.filter((call) => call.paymentIntentId === pi);
    expect(sent).toHaveLength(1);
    const listed = await fakeStripeProvider.listRefunds(pi);
    expect(listed.filter((refund) => refund.status === "succeeded")).toHaveLength(1);
  });

  it("an expired replay inside the abandon window is sent once", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const row = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "REPLAYING",
        lastCheckedAt: new Date(Date.now() - REPLAY_LEASE_MS - 1_000),
      },
    });
    const saved = await reconcileRefundRequest(row);
    expect(saved.state).toBe("CREATED");
    expect(refundRequests.filter((call) => call.paymentIntentId === pi)).toHaveLength(1);
  });

  it("an expired replay past 23 hours is abandoned and not sent", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const row = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "REPLAYING",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastCheckedAt: new Date(Date.now() - REPLAY_LEASE_MS - 1_000),
      },
    });
    const saved = await reconcileRefundRequest(row);
    expect(saved.state).toBe("ABANDONED");
    expect(refundRequests.filter((call) => call.paymentIntentId === pi)).toHaveLength(0);
  });

  it("a stale snapshot does not abandon a replay another server just reserved", async () => {
    const { order, pi } = await cancellingOrder(400);
    const key = `refund:${order.id}:1`;
    const stale = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 400,
        refundApplicationFee: true,
        state: "UNKNOWN",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    await storeScoped(storeId).refundRequest.update({
      where: { id: stale.id },
      data: { state: "REPLAYING", lastCheckedAt: new Date() },
    });
    const saved = await reconcileRefundRequest(stale);
    expect(saved.state).toBe("REPLAYING");
    expect((await storeScoped(storeId).refundRequest.findUnique({ where: { id: stale.id } }))?.state).toBe("REPLAYING");
    expect(refundRequests.filter((call) => call.paymentIntentId === pi)).toHaveLength(0);
    expect(await storeScoped(storeId).auditLog.count({
      where: { entityId: order.id, action: "refund_request_unknown" },
    })).toBe(0);
  });

  it("a stale snapshot does not abandon a request the provider already answered", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const stale = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "UNKNOWN",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    await storeScoped(storeId).refundRequest.update({
      where: { id: stale.id },
      data: { state: "CREATED", providerStatus: "succeeded", providerRefundId: "re_done" },
    });
    const saved = await reconcileRefundRequest(stale);
    expect(saved.state).toBe("CREATED");
    const notCreated = await storeScoped(storeId).refundRequest.update({
      where: { id: stale.id },
      data: { state: "NOT_CREATED", providerStatus: null, providerRefundId: null },
    });
    const rejected = await reconcileRefundRequest({ ...stale, state: "UNKNOWN" });
    expect(rejected.state).toBe("NOT_CREATED");
    expect(notCreated.state).toBe("NOT_CREATED");
  });

  it("a stale expired lease does not overwrite a lease that was just refreshed", async () => {
    const { order, pi } = await cancellingOrder();
    const key = `refund:${order.id}:1`;
    const current = await storeScoped(storeId).refundRequest.create({
      data: {
        storeId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "REPLAYING",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastCheckedAt: new Date(),
      },
    });
    const stale = {
      ...current,
      state: "REPLAYING",
      lastCheckedAt: new Date(Date.now() - REPLAY_LEASE_MS - 1_000),
    };
    const saved = await reconcileRefundRequest(stale);
    expect(saved.state).toBe("REPLAYING");
    expect(refundRequests.filter((call) => call.paymentIntentId === pi)).toHaveLength(0);
  });
});
