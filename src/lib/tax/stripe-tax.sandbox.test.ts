import { beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { stripeTaxCalculator } from "./calculator";

const key = process.env.STRIPE_SECRET_KEY ?? "";

// Opt-in (STRIPE_TAX_SANDBOX=1): the real Stripe Tax API on the platform sandbox (#65). Needs Tax active
// (head office set) and a Texas registration; it skips with that message otherwise.
describe.skipIf(!key.startsWith("sk_test_") || process.env.STRIPE_TAX_SANDBOX !== "1")("Stripe Tax sandbox (#65)", () => {
  const client = new Stripe(key);
  let active = false;

  beforeAll(async () => {
    const settings = await client.tax.settings.retrieve();
    const registrations = await client.tax.registrations.list({ status: "active", limit: 100 });
    active = settings.status === "active" && registrations.data.some((r) => r.country === "US" && r.country_options.us?.state === "TX");
    if (!active) console.warn(`Stripe Tax sandbox skipped: settings ${settings.status}; turn on Tax with a head office and add a Texas registration in the test dashboard.`);
  });

  it("taxes a Texas beauty line and records a transaction once per reference", async (ctx) => {
    if (!active) ctx.skip();
    const tax = stripeTaxCalculator(() => client);
    const reference = `order_sandbox_${Date.now()}`;
    const calculation = await tax.calculate({
      address: { line1: "600 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
      lines: [{ reference: "beauty", amountCents: 999, taxCode: "txcd_32050025" }, { reference: "food", amountCents: 2000, taxCode: "txcd_40040000" }],
      liableParty: "platform",
      stripeAccount: null,
      idempotencyKey: `tax-sandbox-${reference}`,
    });
    expect(calculation.taxCents).toBeGreaterThan(0);
    expect(calculation.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(calculation.taxCents);
    const first = await tax.recordTransaction({ calculationId: calculation.id!, reference, liableParty: "platform", stripeAccount: null });
    const again = await tax.recordTransaction({ calculationId: calculation.id!, reference, liableParty: "platform", stripeAccount: null });
    expect(again.id).toBe(first.id);
  });
});
