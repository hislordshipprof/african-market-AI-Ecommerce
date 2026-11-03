import { describe, it, expect, beforeEach } from "vitest";
import { fakeStripeProvider, reset, setAuthorizedAmount } from "./fake";

describe("Fake Stripe state machine (K6)", () => {
  beforeEach(() => {
    reset();
  });

  it("capture after cancel throws", async () => {
    setAuthorizedAmount("pi_1", 1000);
    await fakeStripeProvider.cancelPaymentIntent("pi_1");
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_1", 500),
    ).rejects.toThrow(/canceled/i);
  });

  it("cancel after capture throws", async () => {
    setAuthorizedAmount("pi_2", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_2", 800);
    await expect(
      fakeStripeProvider.cancelPaymentIntent("pi_2"),
    ).rejects.toThrow(/captured|succeeded/i);
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

  it("capture with different key on captured PI throws", async () => {
    setAuthorizedAmount("pi_7b", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_7b", 800, "key_a");
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_7b", 800, "key_b"),
    ).rejects.toThrow(/already been captured/i);
  });

  it("idempotent cancel with same key returns saved result", async () => {
    setAuthorizedAmount("pi_8", 1000);
    const r1 = await fakeStripeProvider.cancelPaymentIntent("pi_8", "key_c");
    const r2 = await fakeStripeProvider.cancelPaymentIntent("pi_8", "key_c");
    expect(r1).toEqual(r2);
  });

  it("cancel with different key on cancelled PI throws", async () => {
    await fakeStripeProvider.cancelPaymentIntent("pi_8b", "key_c");
    await expect(
      fakeStripeProvider.cancelPaymentIntent("pi_8b", "key_d"),
    ).rejects.toThrow(/canceled/i);
  });

  it("capture below 50c minimum throws amount_too_small", async () => {
    setAuthorizedAmount("pi_9", 1000);
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_9", 30),
    ).rejects.toThrow(/50 cents/i);
  });

  it("capture without registered PI succeeds (e2e compat)", async () => {
    const result = await fakeStripeProvider.capturePaymentIntent("pi_unregistered", 500, "key_e");
    expect(result.amountCaptured).toBe(500);
    expect(result.status).toBe("succeeded");
  });
});
