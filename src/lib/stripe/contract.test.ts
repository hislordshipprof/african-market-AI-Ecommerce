import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  fakeStripeProvider,
  reset,
  setAuthorizedAmount,
  setNextRefundStatus,
  setRefundStatus,
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
  settleFailed(refundId: string, paymentIntentId: string): Promise<{
    status: string;
    amountRefunded: number;
  }>;
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
    async settleFailed(refundId, paymentIntentId) {
      setRefundStatus(refundId, "failed");
      const refund = await fakeStripeProvider.retrieveRefund(refundId);
      const pi = await fakeStripeProvider.retrievePaymentIntent(paymentIntentId);
      return { status: refund.status, amountRefunded: pi.amountRefunded ?? 0 };
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
    async settleFailed(refundId, paymentIntentId) {
      const start = Date.now();
      let last = "missing";
      while (Date.now() - start < 170_000) {
        const refund = await stripeProvider.retrieveRefund(refundId);
        last = refund.status;
        if (refund.status === "failed") {
          const pi = await stripeProvider.retrievePaymentIntent(paymentIntentId);
          return { status: refund.status, amountRefunded: pi.amountRefunded ?? 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      throw new Error(`refund stayed ${last}`);
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

  it("an asynchronously failing refund behaves the same on the fake and the sandbox", async () => {
    const observed = await compare(async (world) => {
      const pi = await world.authorize(400, "pm_card_refundFail");
      await world.provider.capturePaymentIntent(pi, 400, `cap-fail-${pi}`);
      const refund = await world.provider.refundPayment(pi, 400, `refund-fail-${pi}`);
      return world.settleFailed(refund.refundId, pi);
    });
    expect(observed).toEqual({ status: "failed", amountRefunded: 0 });
  }, 200_000);

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
});
