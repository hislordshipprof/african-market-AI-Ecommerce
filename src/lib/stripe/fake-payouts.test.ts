import { beforeEach, describe, expect, it } from "vitest";
import { fakeStripeProvider, loginLinksCreated, reset, setFakePayouts, setNextPayoutsFailure } from "./fake";

describe("fake Stripe payouts (#548)", () => {
  beforeEach(() => reset());

  it("lists an account's payouts newest first, capped at the limit", async () => {
    const payouts = Array.from({ length: 14 }, (_, i) => ({
      id: `po_${i}`, amountCents: 100 + i, arrivalDate: 1_790_000_000 + i * 86_400, status: "paid",
    }));
    setFakePayouts("acct_many", { payouts, transactions: new Map() });
    const listed = await fakeStripeProvider.listPayouts("acct_many", 12);
    expect(listed).toHaveLength(12);
    expect(listed[0].id).toBe("po_13");
  });

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

  it("fails the next payouts call with a provider error when armed", async () => {
    setNextPayoutsFailure("No such destination: 'acct_secret'");
    await expect(fakeStripeProvider.listPayouts("acct_a", 12)).rejects.toMatchObject({ statusCode: 500 });
    expect(await fakeStripeProvider.listPayouts("acct_a", 12)).toHaveLength(2);
  });

  it("creates a login link for the account and counts it", async () => {
    const link = await fakeStripeProvider.createLoginLink("acct_a");
    expect(link.url).toContain("acct_a");
    expect(loginLinksCreated).toEqual(["acct_a"]);
  });
});
