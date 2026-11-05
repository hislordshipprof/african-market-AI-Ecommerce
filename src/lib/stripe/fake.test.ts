import { describe, it, expect, beforeEach } from "vitest";
import { fakeStripeProvider, reset, setAuthorizedAmount, setNextRefundFailure, setRefundCreatedLate, setRefundStatus } from "./fake";
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
    setAuthorizedAmount("pi_8b", 1000);
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

  it("cancel of an unregistered PaymentIntent is rejected", async () => {
    await expect(
      fakeStripeProvider.cancelPaymentIntent("pi_review_unknown", "key_unknown"),
    ).rejects.toThrow(/No such payment_intent/);
    await expect(
      fakeStripeProvider.retrievePaymentIntent("pi_review_unknown"),
    ).rejects.toThrow(/No such payment_intent/);
  });

  it("retrieve of an unregistered PaymentIntent is rejected", async () => {
    await expect(
      fakeStripeProvider.retrievePaymentIntent("pi_review_unknown2"),
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

  it("replays a failed refund for the same idempotency key", async () => {
    const { setNextRefundStatus } = await import("./fake");
    setAuthorizedAmount("pi_re_fail", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_re_fail", 1000);
    setNextRefundStatus("pi_re_fail", "failed");
    const first = await fakeStripeProvider.refundPayment("pi_re_fail", 400, "refund-fail-key");
    const replay = await fakeStripeProvider.refundPayment("pi_re_fail", 400, "refund-fail-key");
    expect(first.status).toBe("failed");
    expect(replay).toEqual(first);
    expect(replay.status).toBe("failed");
  });

  it("replays a canceled refund for the same idempotency key", async () => {
    const { setNextRefundStatus } = await import("./fake");
    setAuthorizedAmount("pi_re_cancel", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_re_cancel", 1000);
    setNextRefundStatus("pi_re_cancel", "canceled");
    const first = await fakeStripeProvider.refundPayment("pi_re_cancel", 250, "refund-cancel-key");
    const replay = await fakeStripeProvider.refundPayment("pi_re_cancel", 250, "refund-cancel-key");
    expect(replay.status).toBe("canceled");
    expect(replay.refundId).toBe(first.refundId);
    expect(replay.amountRefunded).toBe(250);
  });

  it("rejects a reused capture key with a different amount as idempotency_error", async () => {
    setAuthorizedAmount("pi_idem_cap", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_idem_cap", 600, "k1");
    await expect(
      fakeStripeProvider.capturePaymentIntent("pi_idem_cap", 700, "k1"),
    ).rejects.toMatchObject({
      type: "StripeIdempotencyError",
      statusCode: 400,
    });
  });

  it("rejects a reused cancel key with different params as idempotency_error", async () => {
    setAuthorizedAmount("pi_idem_cancel_a", 1000);
    setAuthorizedAmount("pi_idem_cancel_b", 1000);
    await fakeStripeProvider.cancelPaymentIntent("pi_idem_cancel_a", "cancel-key");
    await expect(
      fakeStripeProvider.cancelPaymentIntent("pi_idem_cancel_b", "cancel-key"),
    ).rejects.toMatchObject({
      type: "StripeIdempotencyError",
      statusCode: 400,
    });
  });

  it("rejects a reused refund key with a different amount as idempotency_error", async () => {
    setAuthorizedAmount("pi_idem_ref", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_idem_ref", 1000);
    await fakeStripeProvider.refundPayment("pi_idem_ref", 200, "refund-key");
    await expect(
      fakeStripeProvider.refundPayment("pi_idem_ref", 300, "refund-key"),
    ).rejects.toMatchObject({
      type: "StripeIdempotencyError",
      statusCode: 400,
    });
  });

  it("two equal partial refunds with different keys both reduce the balance", async () => {
    setAuthorizedAmount("pi_equal", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_equal", 1000);
    const first = await fakeStripeProvider.refundPayment("pi_equal", 500, "r1");
    const second = await fakeStripeProvider.refundPayment("pi_equal", 500, "r2");
    expect(second.refundId).not.toBe(first.refundId);
    const retrieved = await fakeStripeProvider.retrievePaymentIntent("pi_equal");
    expect(retrieved.amountRefunded).toBe(1000);
    const listed = await fakeStripeProvider.listRefunds("pi_equal");
    expect(listed.map((refund) => refund.amountRefunded)).toEqual([500, 500]);
    await expect(fakeStripeProvider.refundPayment("pi_equal", 1, "r3")).rejects.toMatchObject({
      code: "charge_already_refunded",
      statusCode: 400,
      type: "StripeInvalidRequestError",
    });
  });

  it("rejects a refund above the unrefunded balance as invalid_request_error 400", async () => {
    setAuthorizedAmount("pi_over", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_over", 1000);
    await fakeStripeProvider.refundPayment("pi_over", 400, "r1");
    await expect(
      fakeStripeProvider.refundPayment("pi_over", 601, "r2"),
    ).rejects.toMatchObject({
      type: "StripeInvalidRequestError",
      statusCode: 400,
      message: "Refund amount ($6.01) is greater than unrefunded amount on charge ($6.00)",
    });
    try {
      await fakeStripeProvider.refundPayment("pi_over", 601, "r3");
    } catch (err) {
      expect((err as { code?: string }).code).toBeUndefined();
    }
  });

  it("applies the configured pending status to a later partial refund", async () => {
    const { setNextRefundStatus } = await import("./fake");
    setAuthorizedAmount("pi_pending_later", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_pending_later", 1000);
    setNextRefundStatus("pi_pending_later", "pending");
    const first = await fakeStripeProvider.refundPayment("pi_pending_later", 400, "p1");
    const second = await fakeStripeProvider.refundPayment("pi_pending_later", 250, "p2");
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
  });

  it("a failed refund changes amountRefunded as the sandbox does", async () => {
    const { setRefundStatus } = await import("./fake");
    setAuthorizedAmount("pi_fail_balance", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_fail_balance", 1000);
    const refund = await fakeStripeProvider.refundPayment("pi_fail_balance", 1000, "full");
    expect((await fakeStripeProvider.retrievePaymentIntent("pi_fail_balance")).amountRefunded).toBe(1000);
    setRefundStatus(refund.refundId, "failed");
    expect((await fakeStripeProvider.retrievePaymentIntent("pi_fail_balance")).amountRefunded).toBe(0);
    const listed = await fakeStripeProvider.listRefunds("pi_fail_balance");
    expect(listed).toEqual([
      { refundId: refund.refundId, amountRefunded: 1000, status: "failed" },
    ]);
    setRefundStatus(refund.refundId, "canceled");
    expect((await fakeStripeProvider.retrievePaymentIntent("pi_fail_balance")).amountRefunded).toBe(0);
  });

  it("partial application fee refunds add up and stop at the fee charged", async () => {
    const { capturedFees, feeRefunded } = await import("./fake");
    setAuthorizedAmount("pi_fee_sum", 100);
    await fakeStripeProvider.capturePaymentIntent("pi_fee_sum", 100, "cap", 5);
    expect(capturedFees.get("pi_fee_sum")).toBe(5);
    await fakeStripeProvider.refundPayment("pi_fee_sum", 30, "f1", { refundApplicationFee: true });
    await fakeStripeProvider.refundPayment("pi_fee_sum", 30, "f2", { refundApplicationFee: true });
    expect(feeRefunded.get("pi_fee_sum")).toBe(4);
    await fakeStripeProvider.refundPayment("pi_fee_sum", 30, "f3", { refundApplicationFee: true });
    expect(feeRefunded.get("pi_fee_sum")).toBe(5);
  });

  it("unknown PaymentIntent errors carry code resource_missing and status 404", async () => {
    const ops = [
      () => fakeStripeProvider.capturePaymentIntent("pi_missing", 500),
      () => fakeStripeProvider.cancelPaymentIntent("pi_missing"),
      () => fakeStripeProvider.retrievePaymentIntent("pi_missing"),
      () => fakeStripeProvider.refundPayment("pi_missing", 500),
    ];
    for (const op of ops) {
      await expect(op()).rejects.toMatchObject({
        code: "resource_missing",
        statusCode: 404,
        type: "StripeInvalidRequestError",
      });
    }
  });

  it("accepts a refund of the exact unrefunded balance", async () => {
    setAuthorizedAmount("pi_exact", 800);
    await fakeStripeProvider.capturePaymentIntent("pi_exact", 800);
    await fakeStripeProvider.refundPayment("pi_exact", 300, "e1");
    const rest = await fakeStripeProvider.refundPayment("pi_exact", 500, "e2");
    expect(rest.status).toBe("succeeded");
    expect((await fakeStripeProvider.retrievePaymentIntent("pi_exact")).amountRefunded).toBe(800);
  });

  it("rejects a refund of 0 cents", async () => {
    setAuthorizedAmount("pi_zero", 800);
    await fakeStripeProvider.capturePaymentIntent("pi_zero", 800);
    await expect(fakeStripeProvider.refundPayment("pi_zero", 0, "zero")).rejects.toMatchObject({
      code: "parameter_invalid_integer",
      statusCode: 400,
      type: "StripeInvalidRequestError",
      message: "This value must be greater than or equal to 1.",
    });
  });

  it("does not save an idempotency key when Stripe would reject the refund before execution", async () => {
    setAuthorizedAmount("pi_invalid_key", 500);
    await fakeStripeProvider.capturePaymentIntent("pi_invalid_key", 500);
    await expect(fakeStripeProvider.refundPayment("pi_invalid_key", 0, "K")).rejects.toMatchObject({
      code: "parameter_invalid_integer",
    });
    await expect(fakeStripeProvider.refundPayment("pi_invalid_key", 100, "K")).resolves.toMatchObject({
      status: "succeeded",
      amountRefunded: 100,
    });

    await expect(fakeStripeProvider.refundPayment("pi_missing_key", 100, "K2")).rejects.toMatchObject({
      code: "resource_missing",
    });
    setAuthorizedAmount("pi_after_missing", 500);
    await fakeStripeProvider.capturePaymentIntent("pi_after_missing", 500);
    await expect(fakeStripeProvider.refundPayment("pi_after_missing", 100, "K2")).resolves.toMatchObject({
      status: "succeeded",
      amountRefunded: 100,
    });
  });

  it("rejects a refund before capture", async () => {
    const { feeRefunded } = await import("./fake");
    setAuthorizedAmount("pi_uncaptured", 800);
    await expect(fakeStripeProvider.refundPayment("pi_uncaptured", 100, "early")).rejects.toMatchObject({
      statusCode: 400,
      type: "StripeInvalidRequestError",
      message: expect.stringContaining("uncaptured Charge"),
    });
    expect(feeRefunded.has("pi_uncaptured")).toBe(false);
  });

  it("rejects a refund after cancel", async () => {
    setAuthorizedAmount("pi_after_cancel", 800);
    await fakeStripeProvider.cancelPaymentIntent("pi_after_cancel");
    await expect(
      fakeStripeProvider.refundPayment("pi_after_cancel", 100, "late"),
    ).rejects.toMatchObject({
      statusCode: 400,
      type: "StripeInvalidRequestError",
      message: expect.stringContaining("uncaptured Charge"),
    });
  });

  it("a replaced failed refund keeps its own id and replays as failed", async () => {
    const pi = "pi_refund_replace";
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const first = await fakeStripeProvider.refundPayment(pi, 400, "r1");
    const failed = await fakeStripeProvider.refundPayment(pi, 300, "r2");
    setRefundStatus(failed.refundId, "failed");
    const replacement = await fakeStripeProvider.refundPayment(pi, 300, "r3");
    expect(new Set([first.refundId, failed.refundId, replacement.refundId]).size).toBe(3);
    expect(await fakeStripeProvider.listRefunds(pi)).toHaveLength(3);
    const replay = await fakeStripeProvider.refundPayment(pi, 300, "r2");
    expect(replay).toEqual({ refundId: failed.refundId, amountRefunded: 300, status: "failed" });
  });

  it("listing refunds for an unknown PaymentIntent is resource_missing", async () => {
    await expect(fakeStripeProvider.listRefunds("pi_missing_review186")).rejects.toMatchObject({
      code: "resource_missing",
      statusCode: 404,
      type: "StripeInvalidRequestError",
      message: "No such payment_intent: 'pi_missing_review186'",
    });
  });

  it("lists refunds newest first", async () => {
    setAuthorizedAmount("pi_order", 1000);
    await fakeStripeProvider.capturePaymentIntent("pi_order", 1000);
    const older = await fakeStripeProvider.refundPayment("pi_order", 100, "old");
    const newer = await fakeStripeProvider.refundPayment("pi_order", 200, "new");
    const listed = await fakeStripeProvider.listRefunds("pi_order");
    expect(listed.map((refund) => refund.refundId)).toEqual([newer.refundId, older.refundId]);
  });

  it("same key with different metadata is an idempotency error", async () => {
    const pi = "pi_meta_idem";
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-meta-idem");
    await fakeStripeProvider.refundPayment(pi, 200, "k", { reservationKey: "k", orderId: "order_a" });
    await expect(
      fakeStripeProvider.refundPayment(pi, 200, "k", { reservationKey: "k", orderId: "order_b" }),
    ).rejects.toMatchObject({ type: "StripeIdempotencyError", statusCode: 400 });
  });

  it("a late-executed unknown request appears with its metadata", async () => {
    const pi = "pi_late_meta";
    const key = "refund:order_late:1";
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-late");
    setNextRefundFailure(pi, 1);
    await expect(
      fakeStripeProvider.refundPayment(pi, 600, key, { reservationKey: key, orderId: "order_late" }),
    ).rejects.toMatchObject({ statusCode: 500 });
    await expect(fakeStripeProvider.refundPayment(pi, 600, key, { reservationKey: key, orderId: "order_late" })).rejects.toMatchObject({
      statusCode: 500,
    });
    setRefundCreatedLate(key);
    const created = await fakeStripeProvider.refundPayment(pi, 600, key, { reservationKey: key, orderId: "order_late" });
    expect(created).toMatchObject({ reservationKey: key, orderId: "order_late", amountRefunded: 600, status: "succeeded" });
    const listed = await fakeStripeProvider.listRefunds(pi);
    expect(listed[0]).toMatchObject({ reservationKey: key, orderId: "order_late" });
  });
});
