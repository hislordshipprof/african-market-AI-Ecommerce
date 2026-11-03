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

  it("idempotent capture returns same result", async () => {
    setAuthorizedAmount("pi_7", 1000);
    const r1 = await fakeStripeProvider.capturePaymentIntent("pi_7", 800);
    const r2 = await fakeStripeProvider.capturePaymentIntent("pi_7", 800);
    expect(r1).toEqual(r2);
  });

  it("idempotent cancel returns same result", async () => {
    setAuthorizedAmount("pi_8", 1000);
    const r1 = await fakeStripeProvider.cancelPaymentIntent("pi_8");
    const r2 = await fakeStripeProvider.cancelPaymentIntent("pi_8");
    expect(r1).toEqual(r2);
  });
});
