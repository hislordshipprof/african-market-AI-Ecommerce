import { beforeEach, describe, expect, it } from "vitest";
import { fakeStripeProvider, reset } from "./fake";

describe("fake Stripe payouts (#548)", () => {
  beforeEach(() => reset());

  it("refuses another account's payout as Stripe does, with a 404", async () => {
    const [mine] = await fakeStripeProvider.listPayouts("acct_a", 12);
    await expect(fakeStripeProvider.retrievePayout("acct_b", mine.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(fakeStripeProvider.listPayoutTransactions("acct_b", mine.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await fakeStripeProvider.retrievePayout("acct_a", mine.id)).id).toBe(mine.id);
  });

  it("gives each payout's transactions with their PaymentIntents", async () => {
    const [, paid] = await fakeStripeProvider.listPayouts("acct_a", 12);
    const txns = await fakeStripeProvider.listPayoutTransactions("acct_a", paid.id);
    expect(txns.reduce((sum, t) => sum + t.netCents, 0)).toBe(paid.amountCents);
    expect(txns.every((t) => t.paymentIntentId?.endsWith("_acct_a"))).toBe(true);
  });
});
