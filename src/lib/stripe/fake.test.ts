import { describe, it, expect, beforeEach } from "vitest";
import { fakeStripeProvider, reset, setAuthorizedAmount } from "./fake";
import { ProviderStateError } from "./types";

describe("Fake Stripe state machine (K6)", () => {
  beforeEach(() => {
    reset();
  });

  it("capture after cancel throws ProviderStateError", async () => {
    setAuthorizedAmount("pi_1", 1000);
    await fakeStripeProvider.cancelPaymentIntent("pi_1");
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_1", 500),
    ).rejects.toThrow(ProviderStateError);
    try {
      await fakeStripeProvider.capturePaymentIntent("pi_1", 500);
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderStateError);
      expect((e as ProviderStateError).actualStatus).toBe("canceled");
    }
  });

  it("cancel after capture throws ProviderStateError", async () => {
    setAuthorizedAmount("pi_2", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_2", 800);
    await expect(
      fakeStripeProvider.cancelPaymentIntent("pi_2"),
    ).rejects.toThrow(ProviderStateError);
    try {
      await fakeStripeProvider.cancelPaymentIntent("pi_2");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderStateError);
      expect((e as ProviderStateError).actualStatus).toBe("succeeded");
    }
  });

  it("capture above amount_capturable throws", async () => {
    setAuthorizedAmount("pi_3", 1000);
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_3", 1500),
    ).rejects.toThrow(/exceeds/i);
  });

  it("retrievePaymentIntent returns requires_capture for authorized PI", async () => {
    setAuthorizedAmount("pi_4", 2000);
    const result = await fakeStripeProvider.retrievePaymentIntent("pi_4");
    expect(result.status).toBe("requires_capture");
    expect(result.amountCapturable).toBe(2000);
    expect(result.amountReceived).toBe(0);
  });

  it("retrievePaymentIntent returns succeeded after capture", async () => {
    setAuthorizedAmount("pi_5", 2000);
    await fakeStripeProvider.capturePaymentIntent("pi_5", 1500);
    const result = await fakeStripeProvider.retrievePaymentIntent("pi_5");
    expect(result.status).toBe("succeeded");
    expect(result.amountCapturable).toBe(0);
    expect(result.amountReceived).toBe(1500);
  });

  it("retrievePaymentIntent returns canceled after cancel", async () => {
    setAuthorizedAmount("pi_6", 2000);
    await fakeStripeProvider.cancelPaymentIntent("pi_6");
    const result = await fakeStripeProvider.retrievePaymentIntent("pi_6");
    expect(result.status).toBe("canceled");
    expect(result.amountCapturable).toBe(0);
    expect(result.amountReceived).toBe(0);
  });

  it("idempotent capture with same key returns saved result", async () => {
    setAuthorizedAmount("pi_7", 1000);
    const r1 = await fakeStripeProvider.capturePaymentIntent("pi_7", 800, "key_a");
    const r2 = await fakeStripeProvider.capturePaymentIntent("pi_7", 800, "key_a");
    expect(r1).toEqual(r2);
  });

  it("capture with different key on captured PI returns idempotent result", async () => {
    setAuthorizedAmount("pi_7b", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_7b", 800, "key_a");
    const r2 = await fakeStripeProvider.capturePaymentIntent("pi_7b", 800, "key_b");
    expect(r2.status).toBe("succeeded");
    expect(r2.amountCaptured).toBe(800);
  });

  it("idempotent cancel with same key returns saved result", async () => {
    setAuthorizedAmount("pi_8", 1000);
    const r1 = await fakeStripeProvider.cancelPaymentIntent("pi_8", "key_c");
    const r2 = await fakeStripeProvider.cancelPaymentIntent("pi_8", "key_c");
    expect(r1).toEqual(r2);
  });

  it("cancel with different key on cancelled PI returns idempotent result", async () => {
    await fakeStripeProvider.cancelPaymentIntent("pi_8b", "key_c");
    const r2 = await fakeStripeProvider.cancelPaymentIntent("pi_8b", "key_d");
    expect(r2.status).toBe("canceled");
  });

  it("capture below 50c minimum throws amount_too_small", async () => {
    setAuthorizedAmount("pi_9", 1000);
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_9", 30),
    ).rejects.toThrow(/50 cents/i);
  });

  it("capture of an unregistered PaymentIntent is rejected", async () => {
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_unregistered", 500, "key_e"),
    ).rejects.toThrow(/No such payment_intent/);
  });

  it("caps an application fee above the captured amount", async () => {
    setAuthorizedAmount("pi_fee_cap", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_fee_cap", 500, "key_fee", 800);
    const { capturedFees } = await import("./fake");
    expect(capturedFees.get("pi_fee_cap")).toBe(500);
  });

  it("replays a capture 500 for the same idempotency key and allows a new key to succeed", async () => {
    const { setNextCaptureFailure } = await import("./fake");
    setAuthorizedAmount("pi_500", 1000);
    setNextCaptureFailure("pi_500", 1);
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_500", 500, "same-key"),
    ).rejects.toThrow(/Internal server error/);
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_500", 500, "same-key"),
    ).rejects.toThrow(/Internal server error/);
    const ok = await fakeStripeProvider.capturePaymentIntent("pi_500", 500, "new-key");
    expect(ok.status).toBe("succeeded");
  });
});
