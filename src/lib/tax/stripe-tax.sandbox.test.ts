import { beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { liveSandbox, providerSandbox } from "../test-live-provider";
import { stripeTaxCalculator } from "./calculator";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const sandbox = providerSandbox("Stripe Tax");

// The real Stripe Tax API on the platform sandbox (#65), with LIVE_SANDBOX=1 like every provider sandbox test.
// Needs Tax active (head office set) and a Texas registration; it skips with that message otherwise.
describe.skipIf(!liveSandbox || !key.startsWith("sk_test_"))("Stripe Tax sandbox (#65)", () => {
  const client = new Stripe(key);
  let active = false;

  beforeAll(sandbox.hook(async () => {
    const settings = await client.tax.settings.retrieve();
    const registrations = await client.tax.registrations.list({ status: "active", limit: 100 });
    active = settings.status === "active" && registrations.data.some((r) => r.country === "US" && r.country_options.us?.state === "TX");
    if (!active) console.warn(`Stripe Tax sandbox skipped: settings ${settings.status}; turn on Tax with a head office and add a Texas registration in the test dashboard.`);
  }));

  it("taxes a Texas beauty line, records a transaction once per reference, and reverses the food line once", sandbox.test(async (ctx) => {
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

    // #671: each line carries its own tax; refunding the exempt food line reverses no tax, once per reference.
    const food = calculation.lineTaxes.find((line) => line.reference === "food")!;
    expect(food.taxCents).toBe(0);
    const reversal = { transactionId: first.id, reference: `${reference}-refund_1`, liableParty: "platform" as const, stripeAccount: null };
    const plan = { mode: "lines" as const, totalCents: 2000, lines: [{ reference: "food", amountCents: 2000, taxCents: 0 }] };
    const reversed = await tax.reverseTransaction({ ...reversal, plan });
    expect((await tax.reverseTransaction({ ...reversal, plan })).id).toBe(reversed.id);
  }));
});
