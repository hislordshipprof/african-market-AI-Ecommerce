import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Stripe from "stripe";
import { stripeProvider } from "./provider";
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

afterAll(async () => {
  if (!hasKey || piToCleanup.length === 0) return;
  for (const id of piToCleanup) {
    try {
      await stripe.paymentIntents.cancel(id);
    } catch { /* best-effort cleanup */ }
  }
});

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
    });

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

    it("capture above authorization throws amount_too_large", async () => {
      const piId = await createAuthorizedPI(500);
      await expect(
        stripeProvider.capturePaymentIntent(piId, 800, `cap-${piId}`),
      ).rejects.toThrow(/amount_too_large|greater than/i);
    });
  },
  { timeout: 60_000 },
);
