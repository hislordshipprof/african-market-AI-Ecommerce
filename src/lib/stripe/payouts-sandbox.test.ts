import { describe, it, expect, beforeAll } from "vitest";
import Stripe from "stripe";
import { stripeProvider } from "./provider";
import { sandboxConnectedAccountId } from "./test-sandbox-account";

const hasKey = !!process.env.STRIPE_SECRET_KEY;

// Reads the sandbox account's real payouts; creates nothing (#548).
describe.skipIf(!hasKey)("Stripe payouts sandbox (#548)", () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await sandboxConnectedAccountId(new Stripe(process.env.STRIPE_SECRET_KEY!));
  }, 120_000);

  it("lists at most 12 payouts and traces each payment in the newest paid one to its PaymentIntent", { timeout: 120_000 }, async () => {
    const payouts = await stripeProvider.listPayouts(accountId, 12);
    expect(payouts.length).toBeGreaterThan(0);
    expect(payouts.length).toBeLessThanOrEqual(12);
    const paid = payouts.find((p) => p.status === "paid")!;
    expect(await stripeProvider.retrievePayout(accountId, paid.id)).toMatchObject({ id: paid.id, amountCents: paid.amountCents });

    const txns = await stripeProvider.listPayoutTransactions(accountId, paid.id);
    expect(txns.some((t) => t.type === "payout")).toBe(false);
    expect(txns.reduce((sum, t) => sum + t.netCents, 0)).toBe(paid.amountCents);
    for (const t of txns.filter((t) => t.type === "payment" || t.type === "payment_refund")) {
      expect(t.paymentIntentId).toMatch(/^pi_/);
    }
  });

  it("returns a 404 for a payout id that is not the account's", { timeout: 30_000 }, async () => {
    await expect(stripeProvider.retrievePayout(accountId, "po_not_this_account")).rejects.toMatchObject({ statusCode: 404 });
  });
});
