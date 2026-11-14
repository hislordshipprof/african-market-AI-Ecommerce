import { describe, expect, it } from "vitest";
import { isProviderQuotaError } from "./provider-quota";

describe("isProviderQuotaError", () => {
  it("is true for Resend's daily quota and rate-limit refusals", () => {
    expect(isProviderQuotaError(new Error('Resend API error 429: {"name":"daily_quota_exceeded"}'))).toBe(true);
    expect(isProviderQuotaError(new Error('Resend API error 429: {"name":"rate_limit_exceeded"}'))).toBe(true);
  });

  it("is false for other provider errors, so real failures still fail", () => {
    expect(isProviderQuotaError(new Error('Resend API error 401: {"name":"validation_error"}'))).toBe(false);
    expect(isProviderQuotaError(new Error('Resend API error 422: {"name":"invalid_from_address"}'))).toBe(false);
    expect(isProviderQuotaError("429 quota")).toBe(false);
  });
});
