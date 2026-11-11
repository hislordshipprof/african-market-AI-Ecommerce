import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  fakeStripeProvider,
  reset,
  setAuthorizedAmount,
  setNextRefundStatus,
  setRefundStatus,
  feeRefunded,
} from "./fake";
import { stripeProvider } from "./provider";
import type { StripeProvider } from "./types";

const hasKey = !!process.env.STRIPE_SECRET_KEY;

type ErrorShape = {
  type: string | null;
  code: string | null;
  statusCode: number | null;
  message: string;
};

type World = {
  provider: StripeProvider;
  authorize(amountCents: number, paymentMethod?: string): Promise<string>;
  armPending(paymentIntentId: string): void;
  /** Fake: marks the refund failed. Sandbox: no-op, so its replay is read before or after a real change. */
  failRefund(refundId: string): void;
  feeRefundedCents(paymentIntentId: string): Promise<number>;
};

const cleanup: string[] = [];
let stripe: Stripe | undefined;
let accountId = "";
let fakeSeq = 0;

function fakeWorld(): World {
  return {
    provider: fakeStripeProvider,
    async authorize(amountCents) {
      fakeSeq += 1;
      const id = `pi_contract_${fakeSeq}`;
      setAuthorizedAmount(id, amountCents);
      return id;
    },
    armPending(paymentIntentId) {
      setNextRefundStatus(paymentIntentId, "pending");
    },
    failRefund(refundId) {
      setRefundStatus(refundId, "failed");
    },
    async feeRefundedCents(paymentIntentId) {
      return feeRefunded.get(paymentIntentId) ?? 0;
    },
  };
}

function liveWorld(): World {
  return {
    provider: stripeProvider,
    async authorize(amountCents, paymentMethod = "pm_card_visa") {
      const pi = await stripe!.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        capture_method: "manual",
        payment_method: paymentMethod,
        confirm: true,
        on_behalf_of: accountId,
        transfer_data: { destination: accountId },
        return_url: "https://example.com/return",
      });
      if (pi.status !== "requires_capture") {
        throw new Error(`Expected requires_capture, got ${pi.status}`);
      }
      cleanup.push(pi.id);
      return pi.id;
    },
    armPending() {},
    failRefund() {},
    async feeRefundedCents(paymentIntentId) {
      const pi = await stripe!.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.application_fee"] });
      const fee = (pi.latest_charge as Stripe.Charge).application_fee as Stripe.ApplicationFee | null;
      return fee?.amount_refunded ?? 0;
    },
  };
}

async function errorOf(run: () => Promise<unknown>): Promise<ErrorShape> {
  try {
    await run();
  } catch (err) {
    const error = err as { type?: string; code?: string; statusCode?: number; message?: string };
    return {
      type: error.type ?? null,
      code: error.code ?? null,
      statusCode: error.statusCode ?? null,
      message: (error.message ?? "").replace(/pi_\w+/g, "pi_X").replace(/ch_\w+/g, "ch_X"),
    };
  }
  throw new Error("expected the provider to reject the call");
}

async function compare(run: (world: World) => Promise<unknown>) {
  reset();
  const fake = await run(fakeWorld());
  if (!hasKey) return fake;
  const live = await run(liveWorld());
  expect(live).toEqual(fake);
  return fake;
}

describe("Stripe contract: fake and sandbox", () => {
  beforeAll(async () => {
    if (!hasKey) return;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    for await (const account of stripe.accounts.list({ limit: 100 })) {
      if (account.capabilities?.transfers === "active") {
        accountId = account.id;
        break;
      }
    }
    if (!accountId) throw new Error("Need a transfers-capable sandbox account");
  }, 60_000);

  afterAll(async () => {
    if (!stripe) return;
    for (const id of cleanup) {
      try {
        await stripe.paymentIntents.cancel(id);
      } catch {
        /* captured or already canceled */
      }
    }
  }, 60_000);

  it("same-key replay behaves the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(1000);
      const key = `contract-replay-${pi}`;
      const first = await world.provider.capturePaymentIntent(pi, 600, key);
      const second = await world.provider.capturePaymentIntent(pi, 600, key);
      return {
        first: { amount: first.amountCaptured, status: first.status },
        second: { amount: second.amountCaptured, status: second.status },
        same: first.amountCaptured === second.amountCaptured && first.status === second.status,
      };
    });
    expect(observed).toEqual({
      first: { amount: 600, status: "succeeded" },
      second: { amount: 600, status: "succeeded" },
      same: true,
    });
  }, 60_000);

  it("changed params on one key behave the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(1000);
      const key = `contract-mismatch-${pi}`;
      await world.provider.capturePaymentIntent(pi, 600, key);
      const error = await errorOf(() => world.provider.capturePaymentIntent(pi, 700, key));
      return { type: error.type, code: error.code, statusCode: error.statusCode };
    });
    expect(observed).toEqual({
      type: "StripeIdempotencyError",
      code: null,
      statusCode: 400,
    });
  }, 60_000);

  it("equal partial refunds and over-refund behave the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(1000);
      await world.provider.capturePaymentIntent(pi, 1000, `cap-${pi}`);
      await world.provider.refundPayment(pi, 500, `r1-${pi}`);
      await world.provider.refundPayment(pi, 500, `r2-${pi}`);
      const covered = await world.provider.retrievePaymentIntent(pi);
      const listed = await world.provider.listRefunds(pi);
      const partial = await world.authorize(1000);
      await world.provider.capturePaymentIntent(partial, 1000, `cap-${partial}`);
      await world.provider.refundPayment(partial, 400, `p1-${partial}`);
      const tooMuch = await errorOf(() => world.provider.refundPayment(partial, 601, `p2-${partial}`));
      const zero = await errorOf(() => world.provider.refundPayment(partial, 0, `p0-${partial}`));
      return {
        amountRefunded: covered.amountRefunded,
        listedAmounts: listed.map((refund) => refund.amountRefunded),
        tooMuch: { type: tooMuch.type, code: tooMuch.code, statusCode: tooMuch.statusCode, message: tooMuch.message },
        zero: { type: zero.type, code: zero.code, statusCode: zero.statusCode, message: zero.message },
      };
    });
    expect(observed).toMatchObject({
      amountRefunded: 1000,
      listedAmounts: [500, 500],
      tooMuch: {
        type: "StripeInvalidRequestError",
        code: null,
        statusCode: 400,
        message: "Refund amount ($6.01) is greater than unrefunded amount on charge ($6.00)",
      },
      zero: {
        type: "StripeInvalidRequestError",
        code: "parameter_invalid_integer",
        statusCode: 400,
        message: "This value must be greater than or equal to 1.",
      },
    });
  }, 90_000);

  // Fake only. The sandbox side of the same claim (the provider reads status
  // "failed" and amountRefunded 0) is pinned in pi-sandbox.test.ts, "a failed
  // destination-charge refund leaves its funds on the platform, reads failed
  // through the provider...", so a run waits on one pm_card_refundFail refund.
  it("an asynchronously failing refund ends failed with nothing refunded on the fake (sandbox side pinned in pi-sandbox.test.ts)", async () => {
    reset();
    const world = fakeWorld();
    const pi = await world.authorize(400, "pm_card_refundFail");
    await world.provider.capturePaymentIntent(pi, 400, `cap-fail-${pi}`);
    const refund = await world.provider.refundPayment(pi, 400, `refund-fail-${pi}`);
    setRefundStatus(refund.refundId, "failed");
    const settled = await world.provider.retrieveRefund(refund.refundId);
    const after = await world.provider.retrievePaymentIntent(pi);
    const observed = { status: settled.status, amountRefunded: after.amountRefunded ?? 0 };
    expect(observed).toEqual({ status: "failed", amountRefunded: 0 });
  });

  it("a pending refund behaves the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500, "pm_card_pendingRefund");
      world.armPending(pi);
      await world.provider.capturePaymentIntent(pi, 500, `cap-pend-${pi}`);
      const refund = await world.provider.refundPayment(pi, 200, `refund-pend-${pi}`);
      const retrieved = await world.provider.retrievePaymentIntent(pi);
      return { status: refund.status, amountRefunded: retrieved.amountRefunded };
    });
    expect(observed).toEqual({ status: "pending", amountRefunded: 200 });
  }, 60_000);

  it("refund before capture and after cancel behave the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const open = await world.authorize(600);
      const before = await errorOf(() => world.provider.refundPayment(open, 100, `before-${open}`));
      const cancelled = await world.authorize(600);
      await world.provider.cancelPaymentIntent(cancelled, `cancel-${cancelled}`);
      const after = await errorOf(() => world.provider.refundPayment(cancelled, 100, `after-${cancelled}`));
      return {
        before: { type: before.type, code: before.code, statusCode: before.statusCode, uncaptured: before.message.includes("uncaptured Charge") },
        after: { type: after.type, code: after.code, statusCode: after.statusCode, uncaptured: after.message.includes("uncaptured Charge") },
      };
    });
    expect(observed).toEqual({
      before: { type: "StripeInvalidRequestError", code: null, statusCode: 400, uncaptured: true },
      after: { type: "StripeInvalidRequestError", code: null, statusCode: 400, uncaptured: true },
    });
  }, 60_000);

  it("refund metadata carries the reservation key and order id", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-meta-${pi}`);
      const orderId = `order_meta_${pi}`;
      const key = `refund:${orderId}:1`;
      await world.provider.refundPayment(pi, 200, key, { reservationKey: key, orderId });
      const listed = await world.provider.listRefunds(pi);
      return {
        reservationMatches: listed[0]?.reservationKey === key,
        orderMatches: listed[0]?.orderId === orderId,
      };
    });
    expect(observed).toEqual({ reservationMatches: true, orderMatches: true });
  }, 60_000);

  it("charge_already_refunded is reported as not created", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-already-${pi}`);
      await world.provider.refundPayment(pi, 500, `refund-already-1-${pi}`);
      const error = await errorOf(() => world.provider.refundPayment(pi, 500, `refund-already-2-${pi}`));
      return { type: error.type, code: error.code, statusCode: error.statusCode };
    });
    expect(observed).toEqual({
      type: "StripeInvalidRequestError",
      code: "charge_already_refunded",
      statusCode: 400,
    });
  }, 60_000);

  it("same key with different metadata is an idempotency error", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-meta-idem-${pi}`);
      const key = `refund-meta-idem-${pi}`;
      await world.provider.refundPayment(pi, 200, key, { reservationKey: key, orderId: "order_a" });
      const error = await errorOf(() =>
        world.provider.refundPayment(pi, 200, key, { reservationKey: key, orderId: "order_b" }),
      );
      return { type: error.type, statusCode: error.statusCode };
    });
    expect(observed).toEqual({ type: "StripeIdempotencyError", statusCode: 400 });
  }, 60_000);

  it("same key with a different refund amount is an idempotency error", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-idem-${pi}`);
      const key = `refund-idem-${pi}`;
      await world.provider.refundPayment(pi, 100, key);
      const error = await errorOf(() => world.provider.refundPayment(pi, 200, key));
      return { type: error.type, statusCode: error.statusCode };
    });
    expect(observed).toEqual({ type: "StripeIdempotencyError", statusCode: 400 });
  }, 60_000);

  it("a validation error does not consume the idempotency key", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-valid-${pi}`);
      const key = `refund-valid-${pi}`;
      const rejected = await errorOf(() => world.provider.refundPayment(pi, 0, key));
      const refund = await world.provider.refundPayment(pi, 100, key);
      return {
        rejected: { type: rejected.type, code: rejected.code, statusCode: rejected.statusCode },
        refund: { status: refund.status, amountRefunded: refund.amountRefunded },
      };
    });
    expect(observed).toEqual({
      rejected: { type: "StripeInvalidRequestError", code: "parameter_invalid_integer", statusCode: 400 },
      refund: { status: "succeeded", amountRefunded: 100 },
    });
  }, 60_000);

  it("a refund key replays its saved first response after the refund changes", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(500);
      await world.provider.capturePaymentIntent(pi, 500, `cap-snap-${pi}`);
      const key = `refund-snap-${pi}`;
      const first = await world.provider.refundPayment(pi, 200, key);
      world.failRefund(first.refundId);
      const replay = await world.provider.refundPayment(pi, 200, key);
      return {
        first: { status: first.status, amount: first.amountRefunded },
        replay: { status: replay.status, amount: replay.amountRefunded, sameId: replay.refundId === first.refundId },
      };
    });
    expect(observed).toEqual({
      first: { status: "succeeded", amount: 200 },
      replay: { status: "succeeded", amount: 200, sameId: true },
    });
  }, 60_000);

  it("a cancel key reused on another PaymentIntent is an idempotency error", async () => {
    const observed = await compare(async (world) => {
      const first = await world.authorize(500);
      const second = await world.authorize(500);
      const key = `cancel-mismatch-${first}`;
      await world.provider.cancelPaymentIntent(first, key);
      const error = await errorOf(() => world.provider.cancelPaymentIntent(second, key));
      return { type: error.type, code: error.code, statusCode: error.statusCode };
    });
    expect(observed).toEqual({ type: "StripeIdempotencyError", code: null, statusCode: 400 });
  }, 60_000);

  it("a refund key reused with a different fee flag is an idempotency error", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(1000);
      await world.provider.capturePaymentIntent(pi, 1000, `cap-feeflag-${pi}`, 100);
      const key = `refund-feeflag-${pi}`;
      await world.provider.refundPayment(pi, 200, key, { refundApplicationFee: true });
      const error = await errorOf(() => world.provider.refundPayment(pi, 200, key));
      return { type: error.type, statusCode: error.statusCode };
    });
    expect(observed).toEqual({ type: "StripeIdempotencyError", statusCode: 400 });
  }, 60_000);

  it("partial refunds return the application fee proportionally with the same rounding", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(1000);
      await world.provider.capturePaymentIntent(pi, 1000, `cap-round-${pi}`, 100);
      const steps: number[] = [];
      for (const [n, amount] of [5, 15, 333].entries()) {
        await world.provider.refundPayment(pi, amount, `refund-round-${n}-${pi}`, { refundApplicationFee: true });
        steps.push(await world.feeRefundedCents(pi));
      }
      return steps;
    });
    expect(observed).toEqual([1, 3, 36]);
  }, 90_000);

  it("listing refunds for an unknown PaymentIntent is resource_missing on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const missing = await errorOf(() => world.provider.listRefunds("pi_missing_review186"));
      return { type: missing.type, code: missing.code, statusCode: missing.statusCode, message: missing.message };
    });
    expect(observed).toEqual({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
      message: "No such payment_intent: 'pi_X'",
    });
  }, 60_000);
});
