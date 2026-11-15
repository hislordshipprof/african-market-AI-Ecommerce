import type Stripe from "stripe";
import { getStripeClient } from "../stripe/provider";
import { checkoutPaymentsUseFake } from "../stripe/checkout-payments";

/**
 * Sales tax through the Stripe Tax API (#65, ADR-0008). PaymentIntents have no automatic tax, so a
 * calculation sizes the hold and, after capture, a transaction records the sale.
 * https://docs.stripe.com/tax/payment-intent/custom
 */

export type TaxLiableParty = "platform" | "store";

export type TaxAddress = {
  line1: string | null;
  line2?: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export type TaxLineInput = { reference: string; amountCents: number; taxCode: string | null };

export type TaxLine = { amount: number; rate: string; jurisdiction: string; taxabilityReason: string };

/** One basket line's tax (#671), by the reference the calculation was made with: the variant at checkout, the order line at capture. */
export type LineTaxAmount = { reference: string; taxCents: number };

export type TaxCalculation = { id: string | null; taxCents: number; lines: TaxLine[]; lineTaxes: LineTaxAmount[] };

export type TaxCalculationInput = {
  address: TaxAddress;
  lines: TaxLineInput[];
  liableParty: TaxLiableParty;
  /** The store's connected account; used only when the store is liable. */
  stripeAccount: string | null;
  idempotencyKey: string;
};

export type TaxTransactionInput = {
  calculationId: string;
  reference: string;
  liableParty: TaxLiableParty;
  stripeAccount: string | null;
};

/**
 * What one refund reverses of the order's tax transaction (#671): its lines' goods and exact tax, a flat amount
 * with tax for a refund not tied to a line, or the whole sale. Amounts are positive cents, tax included in totalCents.
 */
export type TaxReversalPlan =
  | { mode: "lines"; totalCents: number; lines: Array<{ reference: string; amountCents: number; taxCents: number }> }
  | { mode: "flat"; totalCents: number }
  | { mode: "full"; totalCents: number };

export type TaxReversalInput = {
  transactionId: string;
  /** Unique per refund; also the idempotency key, so a retry makes no second reversal. */
  reference: string;
  liableParty: TaxLiableParty;
  stripeAccount: string | null;
  plan: TaxReversalPlan;
};

export interface TaxCalculator {
  calculate(input: TaxCalculationInput): Promise<TaxCalculation>;
  recordTransaction(input: TaxTransactionInput): Promise<{ id: string }>;
  reverseTransaction(input: TaxReversalInput): Promise<{ id: string }>;
}

export const TAX_LOCATION_MESSAGE = "The store address is incomplete, so tax can't be worked out. Please contact the store.";
export const TAX_UNAVAILABLE_MESSAGE = "We couldn't work out the tax just now. Please try again in a minute.";

/** E1 and E3: the address cannot be taxed. No PaymentIntent, no order. */
export class TaxLocationError extends Error {
  readonly code = "tax_location_invalid" as const;
  constructor() {
    super(TAX_LOCATION_MESSAGE);
    this.name = "TaxLocationError";
  }
}

/** E4: tax could not be worked out. Fails closed: never take an untaxed order. */
export class TaxUnavailableError extends Error {
  readonly code = "tax_unavailable" as const;
  constructor(cause?: unknown) {
    super(TAX_UNAVAILABLE_MESSAGE, { cause });
    this.name = "TaxUnavailableError";
  }
}

export function completeAddress(address: TaxAddress): boolean {
  return Boolean(
    address.line1?.trim()
    && address.city?.trim()
    && /^[A-Z]{2}$/.test(address.state?.trim().toUpperCase() ?? "")
    && /^\d{5}(-\d{4})?$/.test(address.postalCode?.trim() ?? ""),
  );
}

function accountOption(liableParty: TaxLiableParty, stripeAccount: string | null): Stripe.RequestOptions {
  if (liableParty !== "store") return {};
  if (!stripeAccount) throw new TaxUnavailableError(new Error("Store is tax-liable but has no Stripe account"));
  return { stripeAccount };
}

function stripeErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function testModeKey(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_") || (process.env.STRIPE_SECRET_KEY ?? "").startsWith("rk_test_");
}

export function stripeTaxCalculator(client: () => Stripe = getStripeClient): TaxCalculator {
  return {
    async calculate(input) {
      if (!completeAddress(input.address)) throw new TaxLocationError();
      const options = { ...accountOption(input.liableParty, input.stripeAccount), idempotencyKey: input.idempotencyKey };
      let calculation: Stripe.Tax.Calculation;
      try {
        calculation = await client().tax.calculations.create({
          currency: "usd",
          customer_details: {
            address: {
              line1: input.address.line1!.trim(),
              line2: input.address.line2?.trim() || undefined,
              city: input.address.city!.trim(),
              state: input.address.state!.trim().toUpperCase(),
              postal_code: input.address.postalCode!.trim(),
              country: "US",
            },
            address_source: "shipping",
          },
          expand: ["line_items"],
          line_items: input.lines.map((line) => ({
            amount: line.amountCents,
            reference: line.reference,
            tax_behavior: "exclusive",
            ...(line.taxCode ? { tax_code: line.taxCode } : {}),
          })),
        }, options);
      } catch (error) {
        if (stripeErrorCode(error) === "customer_tax_location_invalid") throw new TaxLocationError();
        // A test-mode account without Tax set up collects nothing; a live one must never take an untaxed order.
        if (stripeErrorCode(error) === "stripe_tax_inactive" && testModeKey()) {
          return {
            id: null,
            taxCents: 0,
            lines: [{ amount: 0, rate: "0", jurisdiction: input.address.state!.trim().toUpperCase(), taxabilityReason: "stripe_tax_inactive" }],
            lineTaxes: input.lines.map((line) => ({ reference: line.reference, taxCents: 0 })),
          };
        }
        throw new TaxUnavailableError(error);
      }
      let items = calculation.line_items?.data ?? [];
      if (calculation.line_items?.has_more) {
        items = await client().tax.calculations.listLineItems(calculation.id!, { limit: 100 }, accountOption(input.liableParty, input.stripeAccount))
          .autoPagingToArray({ limit: 10_000 });
      }
      return {
        id: calculation.id,
        taxCents: calculation.tax_amount_exclusive,
        lines: calculation.tax_breakdown.map((entry) => ({
          amount: entry.amount,
          rate: entry.tax_rate_details.percentage_decimal,
          jurisdiction: [entry.tax_rate_details.state, entry.tax_rate_details.tax_type].filter(Boolean).join(" ") || entry.tax_rate_details.country || "US",
          taxabilityReason: entry.taxability_reason,
        })),
        lineTaxes: items.map((item) => ({ reference: item.reference, taxCents: item.amount_tax })),
      };
    },
    async recordTransaction(input) {
      const transaction = await client().tax.transactions.createFromCalculation(
        { calculation: input.calculationId, reference: input.reference },
        { ...accountOption(input.liableParty, input.stripeAccount), idempotencyKey: `tax-transaction:${input.reference}` },
      );
      return { id: transaction.id };
    },
    async reverseTransaction(input) {
      const account = accountOption(input.liableParty, input.stripeAccount);
      const base = { original_transaction: input.transactionId, reference: input.reference };
      let params: Stripe.Tax.TransactionCreateReversalParams;
      if (input.plan.mode === "full") params = { mode: "full", ...base };
      else if (input.plan.mode === "flat") params = { mode: "partial", ...base, flat_amount: -input.plan.totalCents };
      else {
        const items = await client().tax.transactions.listLineItems(input.transactionId, { limit: 100 }, account).autoPagingToArray({ limit: 10_000 });
        const byReference = new Map(items.map((item) => [item.reference, item.id]));
        params = {
          mode: "partial",
          ...base,
          line_items: input.plan.lines.map((line) => {
            const original = byReference.get(line.reference);
            if (!original) throw new Error(`Tax transaction ${input.transactionId} has no line ${line.reference}`);
            return { original_line_item: original, reference: line.reference, amount: -line.amountCents, amount_tax: -line.taxCents };
          }),
        };
      }
      const reversal = await client().tax.transactions.createReversal(params, { ...account, idempotencyKey: `tax-reversal:${input.reference}` });
      return { id: reversal.id };
    },
  };
}

export type FakeTaxRates = Record<string, { rate: number; exemptCodes?: string[] }>;
export type FakeTaxCall =
  | { kind: "calculate"; input: TaxCalculationInput }
  | { kind: "transaction"; input: TaxTransactionInput }
  | { kind: "reversal"; input: TaxReversalInput };

export type FakeTaxReversal = { id: string; transactionId: string; reference: string; plan: TaxReversalPlan };

/**
 * Deterministic stand-in for Stripe Tax: per-state rates, per-code exemptions, each line rounded half
 * up. With no rates it collects nothing and checks no address, which is what tests and E2E use
 * unless they install rates.
 */
export function fakeTaxCalculator(rates: FakeTaxRates = {}): TaxCalculator & { calls: FakeTaxCall[]; reversals: FakeTaxReversal[] } {
  const calls: FakeTaxCall[] = [];
  const reversals: FakeTaxReversal[] = [];
  const transactions = new Map<string, string>();
  type Left = Map<string, { amount: number; tax: number }>;
  // Each calculation and transaction lives on the account that made it: the store's when it is liable, else the platform's.
  const calculations = new Map<string, { account: string | null; lines: Left }>();
  const recorded = new Map<string, { account: string | null; left: Left; reversed: boolean }>();
  const account = (input: { liableParty: TaxLiableParty; stripeAccount: string | null }) => (input.liableParty === "store" ? input.stripeAccount : null);
  let next = 0;
  const collecting = Object.keys(rates).length > 0;
  return {
    calls,
    reversals,
    async calculate(input) {
      calls.push({ kind: "calculate", input });
      if (collecting && !completeAddress(input.address)) throw new TaxLocationError();
      const state = input.address.state?.trim().toUpperCase() ?? "";
      const rule = rates[state];
      const lines = input.lines.map((line) => {
        const exempt = !rule || (line.taxCode != null && rule.exemptCodes?.includes(line.taxCode));
        const amount = exempt ? 0 : Math.round(line.amountCents * rule.rate);
        return {
          amount,
          rate: exempt ? "0" : String(rule.rate * 100),
          jurisdiction: state || "US",
          taxabilityReason: !rule ? "not_collecting" : exempt ? "product_exempt" : "standard_rated",
        };
      });
      next += 1;
      const id = `taxcalc_fake_${next}`;
      calculations.set(id, {
        account: account(input),
        lines: new Map(input.lines.map((line, index) => [line.reference, { amount: line.amountCents, tax: lines[index].amount }])),
      });
      const lineTaxes = input.lines.map((line, index) => ({ reference: line.reference, taxCents: lines[index].amount }));
      return { id, taxCents: lines.reduce((sum, line) => sum + line.amount, 0), lines, lineTaxes };
    },
    async recordTransaction(input) {
      calls.push({ kind: "transaction", input });
      const calculation = calculations.get(input.calculationId);
      if (!calculation || calculation.account !== account(input)) {
        throw new Error(`No such tax calculation: '${input.calculationId}'`);
      }
      const existing = transactions.get(input.reference);
      if (existing) return { id: existing };
      const id = `tax_txn_fake_${transactions.size + 1}`;
      transactions.set(input.reference, id);
      recorded.set(id, { account: calculation.account, left: new Map([...calculation.lines].map(([ref, line]) => [ref, { ...line }])), reversed: false });
      return { id };
    },
    async reverseTransaction(input) {
      calls.push({ kind: "reversal", input });
      const transaction = recorded.get(input.transactionId);
      if (!transaction || transaction.account !== account(input)) throw new Error(`No such transaction: '${input.transactionId}'`);
      const existing = reversals.find((reversal) => reversal.reference === input.reference);
      if (existing) return { id: existing.id };
      const lines = [...transaction.left.values()];
      const leftCents = lines.reduce((sum, line) => sum + line.amount + line.tax, 0);
      if (input.plan.mode === "full") {
        if (transaction.reversed) throw new Error("A full reversal is not allowed after a partial reversal");
        for (const line of lines) Object.assign(line, { amount: 0, tax: 0 });
      } else if (input.plan.mode === "flat") {
        if (input.plan.totalCents > leftCents) throw new Error("The flat amount exceeds what the transaction has left");
        // Stripe spreads a flat amount across the lines in proportion; the fake takes it off in line order.
        let take = input.plan.totalCents;
        for (const line of lines) {
          for (const part of ["amount", "tax"] as const) {
            const cut = Math.min(take, line[part]);
            line[part] -= cut;
            take -= cut;
          }
        }
      } else {
        for (const reversed of input.plan.lines) {
          const line = transaction.left.get(reversed.reference);
          if (!line || reversed.amountCents > line.amount || reversed.taxCents > line.tax) {
            throw new Error(`The reversal of line '${reversed.reference}' exceeds what it has left`);
          }
        }
        for (const reversed of input.plan.lines) {
          const line = transaction.left.get(reversed.reference)!;
          line.amount -= reversed.amountCents;
          line.tax -= reversed.taxCents;
        }
      }
      transaction.reversed = true;
      const id = `tax_txn_fake_rev_${reversals.length + 1}`;
      reversals.push({ id, transactionId: input.transactionId, reference: input.reference, plan: input.plan });
      return { id };
    },
  };
}

let override: TaxCalculator | null = null;
const offFake = fakeTaxCalculator();

/** Tests install a calculator here; null restores the default. */
export function setTaxCalculatorForTests(calculator: TaxCalculator | null): void {
  override = calculator;
}

export function getTaxCalculator(): TaxCalculator {
  if (override) return override;
  if (checkoutPaymentsUseFake() || process.env.NODE_ENV === "test") return offFake;
  return stripeTaxCalculator();
}
