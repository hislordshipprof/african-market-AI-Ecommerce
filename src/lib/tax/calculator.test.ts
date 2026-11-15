import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeTaxCalculator, stripeTaxCalculator, TaxUnavailableError } from "./calculator";

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
      id: null, taxCents: 0, lines: [{ amount: 0, rate: "0", jurisdiction: "TX", taxabilityReason: "stripe_tax_inactive" }], lineTaxes: [{ reference: "v1", taxCents: 0 }],
    });
  });

  it("fails closed on a live key with Tax off", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    await expect(inactive().calculate(INPUT)).rejects.toBeInstanceOf(TaxUnavailableError);
  });

  it("maps Stripe's breakdown to lines that sum to tax_amount_exclusive, and each line item's tax to its reference", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "taxcalc_1",
      tax_amount_exclusive: 82,
      line_items: { has_more: false, data: [{ reference: "v1", amount_tax: 82 }] },
      tax_breakdown: [{ amount: 82, taxability_reason: "standard_rated", tax_rate_details: { country: "US", state: "TX", percentage_decimal: "8.25", tax_type: "sales_tax" } }],
    });
    const result = await stripeTaxCalculator(() => ({ tax: { calculations: { create } } }) as never).calculate({ ...INPUT, liableParty: "store", stripeAccount: "acct_1" });
    expect(result).toEqual({
      id: "taxcalc_1", taxCents: 82, lines: [{ amount: 82, rate: "8.25", jurisdiction: "TX sales_tax", taxabilityReason: "standard_rated" }], lineTaxes: [{ reference: "v1", taxCents: 82 }],
    });
    expect(create.mock.calls[0][0]).toMatchObject({ expand: ["line_items"], customer_details: { address_source: "shipping", address: { state: "TX", country: "US" } }, line_items: [{ amount: 999, reference: "v1", tax_behavior: "exclusive" }] });
    expect(create.mock.calls[0][1]).toEqual({ stripeAccount: "acct_1", idempotencyKey: "k" });
  });
});

describe("Stripe Tax reversal (#671)", () => {
  function client() {
    const createReversal = vi.fn().mockResolvedValue({ id: "tax_txn_rev_1" });
    const listLineItems = vi.fn().mockReturnValue({
      autoPagingToArray: async () => [{ id: "tax_li_a", reference: "line_a" }, { id: "tax_li_b", reference: "line_b" }],
    });
    return { createReversal, listLineItems, tax: stripeTaxCalculator(() => ({ tax: { transactions: { createReversal, listLineItems } } }) as never) };
  }
  const base = { transactionId: "tax_txn_1", reference: "refund_r1", liableParty: "store" as const, stripeAccount: "acct_1" };

  it("reverses each refunded line against its original line item, in negative cents, once per refund", async () => {
    const { createReversal, listLineItems, tax } = client();
    expect(await tax.reverseTransaction({ ...base, plan: { mode: "lines", totalCents: 1083, lines: [{ reference: "line_b", amountCents: 1000, taxCents: 83 }] } }))
      .toEqual({ id: "tax_txn_rev_1" });
    expect(listLineItems.mock.calls[0][0]).toBe("tax_txn_1");
    expect(listLineItems.mock.calls[0][2]).toEqual({ stripeAccount: "acct_1" });
    expect(createReversal).toHaveBeenCalledWith(
      { mode: "partial", original_transaction: "tax_txn_1", reference: "refund_r1", line_items: [{ original_line_item: "tax_li_b", reference: "line_b", amount: -1000, amount_tax: -83 }] },
      { stripeAccount: "acct_1", idempotencyKey: "tax-reversal:refund_r1" },
    );
  });

  it("reverses an amount not tied to a line as a flat amount, and a whole order in full", async () => {
    const { createReversal, tax } = client();
    await tax.reverseTransaction({ ...base, liableParty: "platform", stripeAccount: null, plan: { mode: "flat", totalCents: 555 } });
    await tax.reverseTransaction({ ...base, reference: "refund_r2", liableParty: "platform", stripeAccount: null, plan: { mode: "full", totalCents: 3083 } });
    expect(createReversal.mock.calls).toEqual([
      [{ mode: "partial", original_transaction: "tax_txn_1", reference: "refund_r1", flat_amount: -555 }, { idempotencyKey: "tax-reversal:refund_r1" }],
      [{ mode: "full", original_transaction: "tax_txn_1", reference: "refund_r2" }, { idempotencyKey: "tax-reversal:refund_r2" }],
    ]);
  });
});

describe("fake Stripe Tax (#65)", () => {
  it("records a transaction only for a calculation it made, on the account that made it, as Stripe does", async () => {
    const fake = fakeTaxCalculator({ TX: { rate: 0.0825 } });
    const storeCalc = await fake.calculate({ ...INPUT, liableParty: "store", stripeAccount: "acct_1" });
    await expect(fake.recordTransaction({ calculationId: "taxcalc_unknown", reference: "order_1", liableParty: "platform", stripeAccount: null }))
      .rejects.toThrow(/No such tax calculation/);
    await expect(fake.recordTransaction({ calculationId: storeCalc.id!, reference: "order_1", liableParty: "platform", stripeAccount: null }))
      .rejects.toThrow(/No such tax calculation/);
    expect(await fake.recordTransaction({ calculationId: storeCalc.id!, reference: "order_1", liableParty: "store", stripeAccount: "acct_1" }))
      .toEqual({ id: "tax_txn_fake_1" });
  });
});

describe("fake Stripe Tax reversals (#671)", () => {
  async function recorded() {
    const fake = fakeTaxCalculator({ TX: { rate: 0.0825, exemptCodes: ["txcd_40040000"] } });
    const calc = await fake.calculate({ ...INPUT, lines: [{ reference: "food", amountCents: 2000, taxCode: "txcd_40040000" }, { reference: "soap", amountCents: 1000, taxCode: null }] });
    const txn = await fake.recordTransaction({ calculationId: calc.id!, reference: "order_1", liableParty: "platform", stripeAccount: null });
    return { fake, calc, txn, base: { transactionId: txn.id, liableParty: "platform" as const, stripeAccount: null } };
  }

  it("gives each line its own tax, and returns the same reversal for a repeated reference", async () => {
    const { fake, calc, base } = await recorded();
    expect(calc.lineTaxes).toEqual([{ reference: "food", taxCents: 0 }, { reference: "soap", taxCents: 83 }]);
    const plan = { mode: "lines" as const, totalCents: 1083, lines: [{ reference: "soap", amountCents: 1000, taxCents: 83 }] };
    const first = await fake.reverseTransaction({ ...base, reference: "refund_1", plan });
    expect(await fake.reverseTransaction({ ...base, reference: "refund_1", plan })).toEqual(first);
    expect(fake.reversals).toEqual([{ id: first.id, transactionId: base.transactionId, reference: "refund_1", plan }]);
  });

  it("refuses what Stripe refuses: an unknown transaction or account, more than a line has left, a full reversal after a partial", async () => {
    const { fake, base } = await recorded();
    const soap = (amountCents: number, taxCents: number) => ({ mode: "lines" as const, totalCents: amountCents + taxCents, lines: [{ reference: "soap", amountCents, taxCents }] });
    await expect(fake.reverseTransaction({ ...base, transactionId: "tax_txn_unknown", reference: "r0", plan: soap(1, 0) })).rejects.toThrow(/No such transaction/);
    await expect(fake.reverseTransaction({ ...base, liableParty: "store", stripeAccount: "acct_1", reference: "r0", plan: soap(1, 0) })).rejects.toThrow(/No such transaction/);
    await expect(fake.reverseTransaction({ ...base, reference: "r1", plan: soap(1000, 84) })).rejects.toThrow(/exceeds/);
    await fake.reverseTransaction({ ...base, reference: "r2", plan: soap(500, 42) });
    await expect(fake.reverseTransaction({ ...base, reference: "r3", plan: soap(501, 41) })).rejects.toThrow(/exceeds/);
    await expect(fake.reverseTransaction({ ...base, reference: "r4", plan: { mode: "full", totalCents: 2541 } })).rejects.toThrow(/full/);
    await expect(fake.reverseTransaction({ ...base, reference: "r5", plan: { mode: "flat", totalCents: 2542 } })).rejects.toThrow(/exceeds/);
    expect(await fake.reverseTransaction({ ...base, reference: "r6", plan: { mode: "flat", totalCents: 2541 } })).toMatchObject({ id: expect.any(String) });
  });
});
