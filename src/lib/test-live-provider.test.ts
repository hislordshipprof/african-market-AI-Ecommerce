import { APICallError } from "ai";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { DeliveryProviderError } from "./delivery/provider";
import { ProviderSendError } from "./notifications/provider-error";
import { isProviderQuotaError, providerSandbox } from "./test-live-provider";

function anthropicError(statusCode: number) {
  return new APICallError({ message: "anthropic", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode });
}

class Skipped extends Error {}
const ctx = { skip: () => { throw new Skipped(); } } as unknown as TestContext;

describe("isProviderQuotaError", () => {
  it("is true for the 429 each provider's client throws", () => {
    expect(isProviderQuotaError(new Error('Resend API error 429: {"name":"daily_quota_exceeded"}'))).toBe(true);
    expect(isProviderQuotaError(new Stripe.errors.StripeRateLimitError({ statusCode: 429, code: "rate_limit", message: "Too many requests" }))).toBe(true);
    expect(isProviderQuotaError(new DeliveryProviderError("uber", 429, "rate_limit_exceeded", "Uber Direct POST /quotes failed with 429"))).toBe(true);
    expect(isProviderQuotaError(new ProviderSendError(429, "10011"))).toBe(true);
    expect(isProviderQuotaError(anthropicError(429))).toBe(true);
  });

  it("is false for other provider refusals, so real failures still fail", () => {
    expect(isProviderQuotaError(new Error('Resend API error 422: {"name":"invalid_from_address"}'))).toBe(false);
    expect(isProviderQuotaError(new Stripe.errors.StripeCardError({ statusCode: 402, code: "card_declined", message: "declined" }))).toBe(false);
    expect(isProviderQuotaError(new DeliveryProviderError("uber", 401, "unauthorized", "Uber Direct token request failed with 401"))).toBe(false);
    expect(isProviderQuotaError(anthropicError(500))).toBe(false);
  });
});

describe("providerSandbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a quota refusal skips the test with a warning naming the provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const test = providerSandbox("Telnyx").test(async () => { throw new ProviderSendError(429, "10011"); });
    await expect(test(ctx)).rejects.toBeInstanceOf(Skipped);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^Telnyx sandbox skipped: provider quota or rate limit/);
  });

  it("any other error still fails the test", async () => {
    const test = providerSandbox("Telnyx").test(async () => { throw new ProviderSendError(403, "40310"); });
    await expect(test(ctx)).rejects.toMatchObject({ code: "40310" });
  });

  it("a watched refusal skips the test even when an expected-rejection assertion caught it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sandbox = providerSandbox("Telnyx");
    const test = sandbox.test(async () => {
      await expect(sandbox.watch(Promise.reject(new ProviderSendError(429, "10011")))).rejects.toMatchObject({ code: expect.stringMatching(/^\d{5}$/) });
    });
    await expect(test(ctx)).rejects.toBeInstanceOf(Skipped);
  });

  it("a quota refusal in a hook skips the tests after it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sandbox = providerSandbox("Stripe");
    await sandbox.hook(async () => { throw new Stripe.errors.StripeRateLimitError({ statusCode: 429, message: "slow down" }); })();
    let ran = false;
    await expect(sandbox.test(async () => { ran = true; })(ctx)).rejects.toBeInstanceOf(Skipped);
    expect(ran).toBe(false);
  });
});
