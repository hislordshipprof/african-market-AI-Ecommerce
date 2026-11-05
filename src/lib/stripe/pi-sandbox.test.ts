import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Stripe from "stripe";
import { stripeProvider } from "./provider";
import { OverRefundError } from "./errors";
import { ProviderStateError } from "./types";

const hasKey = !!process.env.STRIPE_SECRET_KEY;

const piToCleanup: string[] = [];
let stripeAccountId: string;
let stripe: Stripe;

async function createAuthorizedPI(amountCents: number): Promise<string> {
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    capture_method: "manual",
    on_behalf_of: stripeAccountId,
    transfer_data: { destination: stripeAccountId },
  });
  const confirmed = await stripe.paymentIntents.confirm(pi.id, {
    payment_method: "pm_card_visa",
    return_url: "https://example.com/return",
  });
  if (confirmed.status !== "requires_capture") {
    throw new Error(`Expected requires_capture, got ${confirmed.status}`);
  }
  piToCleanup.push(pi.id);
  return pi.id;
}

async function waitForRefundFailedEvent(refundId: string): Promise<Stripe.Event> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let startingAfter: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const events = await stripe.events.list({
        type: "refund.failed",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const match = events.data.find((event) => {
        const object = event.data.object as { id?: string };
        return object.id === refundId;
      });
      if (match) return match;
      if (!events.has_more || events.data.length === 0) break;
      startingAfter = events.data[events.data.length - 1]?.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`refund.failed event for ${refundId} did not appear`);
}

afterAll(async () => {
  if (!hasKey || piToCleanup.length === 0) return;
  for (const id of piToCleanup) {
    try {
      await stripe.paymentIntents.cancel(id);
    } catch { /* best-effort cleanup */ }
  }
}, 60_000);

describe.skipIf(!hasKey)(
  "Stripe PI sandbox (capture/cancel/refund/retrieve)",
  () => {
    beforeAll(async () => {
      stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      for await (const acct of stripe.accounts.list({ limit: 100 })) {
        if (acct.capabilities?.transfers === "active") {
          stripeAccountId = acct.id;
          break;
        }
      }
      if (!stripeAccountId) {
        throw new Error("Need at least 1 transfers-capable sandbox account");
      }
    }, 60_000);

    it("partial capture returns amount_received", async () => {
      const piId = await createAuthorizedPI(1000);
      const result = await stripeProvider.capturePaymentIntent(piId, 600, `test-cap-${piId}`);
      expect(result.amountCaptured).toBe(600);
      expect(result.status).toBe("succeeded");
    });

    it("capture replay with same key returns saved result (no error)", async () => {
      const piId = await createAuthorizedPI(1000);
      const key = `test-replay-${piId}`;
      const r1 = await stripeProvider.capturePaymentIntent(piId, 700, key);
      const r2 = await stripeProvider.capturePaymentIntent(piId, 700, key);
      expect(r2.amountCaptured).toBe(r1.amountCaptured);
      expect(r2.status).toBe("succeeded");
    });

    it("capture with new key on captured PI falls back to retrieve", async () => {
      const piId = await createAuthorizedPI(1000);
      await stripeProvider.capturePaymentIntent(piId, 800, `key-a-${piId}`);
      const r2 = await stripeProvider.capturePaymentIntent(piId, 800, `key-b-${piId}`);
      expect(r2.status).toBe("succeeded");
      expect(r2.amountCaptured).toBe(800);
    });

    it("cancel returns canceled status", async () => {
      const piId = await createAuthorizedPI(500);
      const result = await stripeProvider.cancelPaymentIntent(piId, `test-cancel-${piId}`);
      expect(result.status).toBe("canceled");
    });

    it("cancel on already-cancelled PI falls back to retrieve", async () => {
      const piId = await createAuthorizedPI(500);
      await stripeProvider.cancelPaymentIntent(piId, `key-c-${piId}`);
      const r2 = await stripeProvider.cancelPaymentIntent(piId, `key-d-${piId}`);
      expect(r2.status).toBe("canceled");
    });

    it("refund with reverse_transfer succeeds", async () => {
      const piId = await createAuthorizedPI(1000);
      await stripeProvider.capturePaymentIntent(piId, 1000, `cap-${piId}`);
      const result = await stripeProvider.refundPayment(piId, 1000, `refund-${piId}`);
      expect(result.amountRefunded).toBe(1000);
      expect(result.status).toBe("succeeded");
    });

    it("retrieve after capture returns succeeded with amount_received", async () => {
      const piId = await createAuthorizedPI(900);
      await stripeProvider.capturePaymentIntent(piId, 600, `cap-${piId}`);
      const result = await stripeProvider.retrievePaymentIntent(piId);
      expect(result.status).toBe("succeeded");
      expect(result.amountReceived).toBe(600);
      expect(result.amountCapturable).toBe(0);
    });

    it("retrieve before capture returns requires_capture", async () => {
      const piId = await createAuthorizedPI(800);
      const result = await stripeProvider.retrievePaymentIntent(piId);
      expect(result.status).toBe("requires_capture");
      expect(result.amountCapturable).toBe(800);
      expect(result.amountReceived).toBe(0);
    });

    it("P2: capture after cancel throws ProviderStateError", async () => {
      const piId = await createAuthorizedPI(1000);
      await stripeProvider.cancelPaymentIntent(piId, `cancel-${piId}`);
      try {
        await stripeProvider.capturePaymentIntent(piId, 500, `cap-${piId}`);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderStateError);
        expect((e as ProviderStateError).actualStatus).toBe("canceled");
      }
    });

    it("P2: cancel after capture throws ProviderStateError", async () => {
      const piId = await createAuthorizedPI(1000);
      await stripeProvider.capturePaymentIntent(piId, 800, `cap-${piId}`);
      try {
        await stripeProvider.cancelPaymentIntent(piId, `cancel-${piId}`);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderStateError);
        expect((e as ProviderStateError).actualStatus).toBe("succeeded");
      }
    });

    it("capture below 50c throws amount_too_small", async () => {
      const piId = await createAuthorizedPI(1000);
      await expect(
        stripeProvider.capturePaymentIntent(piId, 30, `cap-${piId}`),
      ).rejects.toThrow(/amount_too_small|\$0\.50/i);
    });

    it("capture with an application fee refunds that fee on a full refund", async () => {
      const piId = await createAuthorizedPI(1000);
      await stripeProvider.capturePaymentIntent(piId, 1000, `cap-fee-${piId}`, 100);
      const captured = await stripe.paymentIntents.retrieve(piId);
      expect(captured.application_fee_amount).toBe(100);

      const refund = await stripeProvider.refundPayment(piId, 1000, `refund-fee-${piId}`, {
        refundApplicationFee: true,
      });
      expect(refund.status).toBe("succeeded");
      expect(refund.amountRefunded).toBe(1000);

      const after = await stripe.paymentIntents.retrieve(piId, {
        expand: ["latest_charge.application_fee"],
      });
      const charge = after.latest_charge;
      if (!charge || typeof charge === "string") {
        throw new Error("expected expanded latest_charge");
      }
      const fee = charge.application_fee;
      if (!fee || typeof fee === "string") {
        throw new Error("expected expanded application_fee");
      }
      expect(fee.amount).toBe(100);
      expect(fee.amount_refunded).toBe(100);
    });

    it("cancel of an unknown PaymentIntent is resource_missing", async () => {
      await expect(
        stripeProvider.cancelPaymentIntent("pi_does_not_exist_review", "cancel-missing"),
      ).rejects.toMatchObject({ code: "resource_missing" });
    });

    it("retrieve of an unknown PaymentIntent is resource_missing", async () => {
      await expect(
        stripeProvider.retrievePaymentIntent("pi_does_not_exist_review"),
      ).rejects.toMatchObject({ code: "resource_missing" });
    });

    it("capture above authorization throws amount_too_large", async () => {
      const piId = await createAuthorizedPI(500);
      await expect(
        stripeProvider.capturePaymentIntent(piId, 800, `cap-${piId}`),
      ).rejects.toThrow(/amount_too_large|greater than/i);
    });

    it("charge_already_refunded is reported as not created", async () => {
      const piId = await createAuthorizedPI(500);
      await stripeProvider.capturePaymentIntent(piId, 500, `cap-already-${piId}`);
      await stripeProvider.refundPayment(piId, 500, `refund-already-1-${piId}`);
      await expect(
        stripeProvider.refundPayment(piId, 500, `refund-already-2-${piId}`),
      ).rejects.toMatchObject({
        code: "charge_already_refunded",
        statusCode: 400,
        type: "StripeInvalidRequestError",
      });
    });

    it("refund metadata carries the reservation key and order id", async () => {
      const piId = await createAuthorizedPI(500);
      await stripeProvider.capturePaymentIntent(piId, 500, `cap-meta-${piId}`);
      const orderId = `order_meta_${piId}`;
      const key = `refund:${orderId}:1`;
      await stripeProvider.refundPayment(piId, 200, key, { reservationKey: key, orderId });
      const listed = await stripeProvider.listRefunds(piId);
      expect(listed[0]).toMatchObject({ reservationKey: key, orderId });
    });

    it("same key with a different refund amount is an idempotency error", async () => {
      const piId = await createAuthorizedPI(500);
      await stripeProvider.capturePaymentIntent(piId, 500, `cap-idem-${piId}`);
      const key = `refund-idem-${piId}`;
      await stripeProvider.refundPayment(piId, 100, key);
      await expect(stripeProvider.refundPayment(piId, 200, key)).rejects.toMatchObject({
        type: "StripeIdempotencyError",
        statusCode: 400,
      });
    });

    it("a refund above the balance is reported as the typed over-refund error", async () => {
      const piId = await createAuthorizedPI(800);
      await stripeProvider.capturePaymentIntent(piId, 800, `cap-over-${piId}`);
      await stripeProvider.refundPayment(piId, 100, `refund-over-1-${piId}`);
      await expect(
        stripeProvider.refundPayment(piId, 900, `refund-over-2-${piId}`),
      ).rejects.toBeInstanceOf(OverRefundError);
    });

    it("listRefunds returns every refund past 100", async () => {
      const piId = await createAuthorizedPI(200);
      await stripeProvider.capturePaymentIntent(piId, 200, `cap-page-${piId}`);
      for (let i = 0; i < 101; i += 1) {
        await stripe.refunds.create(
          { payment_intent: piId, amount: 1 },
          { idempotencyKey: `page-${piId}-${i}` },
        );
      }
      const listed = await stripeProvider.listRefunds(piId);
      expect(listed).toHaveLength(101);
      expect(listed.reduce((sum, refund) => sum + refund.amountRefunded, 0)).toBe(101);
    }, 300_000);

    it("retrieveRefund reports pending for pm_card_pendingRefund", async () => {
      const created = await stripe.paymentIntents.create({
        amount: 600,
        currency: "usd",
        capture_method: "automatic",
        confirm: true,
        payment_method: "pm_card_pendingRefund",
        on_behalf_of: stripeAccountId,
        transfer_data: { destination: stripeAccountId },
        return_url: "https://example.com/return",
      });
      piToCleanup.push(created.id);
      const refund = await stripe.refunds.create({ payment_intent: created.id });
      const reported = await stripeProvider.retrieveRefund(refund.id);
      expect(reported.status).toBe("pending");
      expect(reported.amountRefunded).toBe(600);
    });

    it("a real refund.failed event payload parses into the refund id, status and PaymentIntent", async () => {
      const created = await stripe.paymentIntents.create({
        amount: 700,
        currency: "usd",
        capture_method: "automatic",
        confirm: true,
        payment_method: "pm_card_refundFail",
        on_behalf_of: stripeAccountId,
        transfer_data: { destination: stripeAccountId },
        return_url: "https://example.com/return",
      });
      piToCleanup.push(created.id);
      let refund = await stripe.refunds.create({ payment_intent: created.id });
      for (let i = 0; i < 90 && refund.status !== "failed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        refund = await stripe.refunds.retrieve(refund.id);
      }
      expect(refund.status).toBe("failed");
      const secret = process.env.STRIPE_WEBHOOK_SECRET?.split(",")[0]?.trim();
      expect(secret).toBeTruthy();
      const match = await waitForRefundFailedEvent(refund.id);
      expect(match.id).toBeTruthy();
      const payload = JSON.stringify(match);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: secret! });
      const parsed = stripeProvider.verifyWebhookSignature({ payload, signature });
      expect(parsed.type).toBe("refund.failed");
      expect(parsed.refund).toEqual({
        id: refund.id,
        status: "failed",
        paymentIntentId: created.id,
      });
    }, 200_000);

    it("a failed destination-charge refund leaves its funds on the platform", async () => {
      const created = await stripe.paymentIntents.create({
        amount: 900,
        currency: "usd",
        capture_method: "automatic",
        confirm: true,
        payment_method: "pm_card_refundFail",
        application_fee_amount: 50,
        on_behalf_of: stripeAccountId,
        transfer_data: { destination: stripeAccountId },
        return_url: "https://example.com/return",
      });
      piToCleanup.push(created.id);
      let refund = await stripe.refunds.create(
        { payment_intent: created.id, reverse_transfer: true },
      );
      for (let i = 0; i < 90 && refund.status !== "failed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        refund = await stripe.refunds.retrieve(refund.id);
      }
      expect(refund.status).toBe("failed");
      const settled = await stripe.refunds.retrieve(refund.id, {
        expand: ["transfer_reversal", "failure_balance_transaction", "balance_transaction"],
      });
      const reversal = settled.transfer_reversal;
      const failureBalance = settled.failure_balance_transaction;
      expect(reversal && typeof reversal === "object").toBe(true);
      expect(failureBalance && typeof failureBalance === "object").toBe(true);
      if (reversal && typeof reversal === "object") expect(reversal.amount).toBeGreaterThan(0);
      if (failureBalance && typeof failureBalance === "object") expect(failureBalance.amount).not.toBe(0);
      const pi = await stripe.paymentIntents.retrieve(created.id, { expand: ["latest_charge"] });
      const charge = pi.latest_charge;
      if (!charge || typeof charge === "string") throw new Error("expected expanded latest_charge");
      expect(pi.amount_received).toBe(900);
      expect(charge.amount_refunded).toBe(0);
      expect(charge.refunded).toBe(false);
    }, 200_000);
  },
  { timeout: 60_000 },
);
