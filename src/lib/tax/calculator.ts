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

export type TaxCalculation = { id: string | null; taxCents: number; lines: TaxLine[] };

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

export interface TaxCalculator {
  calculate(input: TaxCalculationInput): Promise<TaxCalculation>;
  recordTransaction(input: TaxTransactionInput): Promise<{ id: string }>;
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
          };
        }
        throw new TaxUnavailableError(error);
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
      };
    },
    async recordTransaction(input) {
      const transaction = await client().tax.transactions.createFromCalculation(
        { calculation: input.calculationId, reference: input.reference },
        { ...accountOption(input.liableParty, input.stripeAccount), idempotencyKey: `tax-transaction:${input.reference}` },
      );
      return { id: transaction.id };
    },
  };
}

export type FakeTaxRates = Record<string, { rate: number; exemptCodes?: string[] }>;
export type FakeTaxCall =
  | { kind: "calculate"; input: TaxCalculationInput }
  | { kind: "transaction"; input: TaxTransactionInput };

/**
 * Deterministic stand-in for Stripe Tax: per-state rates, per-code exemptions, each line rounded half
 * up. With no rates it collects nothing and checks no address, which is what tests and E2E use
 * unless they install rates.
 */
export function fakeTaxCalculator(rates: FakeTaxRates = {}): TaxCalculator & { calls: FakeTaxCall[] } {
  const calls: FakeTaxCall[] = [];
  const transactions = new Map<string, string>();
  let next = 0;
  const collecting = Object.keys(rates).length > 0;
  return {
    calls,
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
      return { id: `taxcalc_fake_${next}`, taxCents: lines.reduce((sum, line) => sum + line.amount, 0), lines };
    },
    async recordTransaction(input) {
      calls.push({ kind: "transaction", input });
      const existing = transactions.get(input.reference);
      if (existing) return { id: existing };
      const id = `tax_txn_fake_${transactions.size + 1}`;
      transactions.set(input.reference, id);
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
