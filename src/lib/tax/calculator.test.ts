import { afterEach, describe, expect, it, vi } from "vitest";
import { stripeTaxCalculator, TaxUnavailableError } from "./calculator";

const INPUT = {
  address: { line1: "100 Main St", city: "Houston", state: "TX", postalCode: "77002" },
  lines: [{ reference: "v1", amountCents: 999, taxCode: null }],
  liableParty: "platform" as const,
  stripeAccount: null,
  idempotencyKey: "k",
};

function inactive() {
  const create = vi.fn().mockRejectedValue(Object.assign(new Error("Stripe Tax isn't active"), { code: "stripe_tax_inactive" }));
  return stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never);
}

describe("Stripe Tax adapter (#65)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("charges 0 with the reason when a test-mode account has Tax off, as the sandbox does today", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(await inactive().calculate(INPUT)).toEqual({
      id: null, taxCents: 0, lines: [{ amount: 0, rate: "0", jurisdiction: "TX", taxabilityReason: "stripe_tax_inactive" }],
    });
  });

  it("fails closed on a live key with Tax off", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    await expect(inactive().calculate(INPUT)).rejects.toBeInstanceOf(TaxUnavailableError);
  });

  it("maps Stripe's breakdown to lines that sum to tax_amount_exclusive", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "taxcalc_1",
      tax_amount_exclusive: 82,
      tax_breakdown: [{ amount: 82, taxability_reason: "standard_rated", tax_rate_details: { country: "US", state: "TX", percentage_decimal: "8.25", tax_type: "sales_tax" } }],
    });
    const result = await stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never).calculate({ ...INPUT, liableParty: "store", stripeAccount: "acct_1" });
    expect(result).toEqual({ id: "taxcalc_1", taxCents: 82, lines: [{ amount: 82, rate: "8.25", jurisdiction: "TX sales_tax", taxabilityReason: "standard_rated" }] });
    expect(create.mock.calls[0][0]).toMatchObject({ customer_details: { address_source: "shipping", address: { state: "TX", country: "US" } }, line_items: [{ amount: 999, reference: "v1", tax_behavior: "exclusive" }] });
    expect(create.mock.calls[0][1]).toEqual({ stripeAccount: "acct_1", idempotencyKey: "k" });
  });
});
