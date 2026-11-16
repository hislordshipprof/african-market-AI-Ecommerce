import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { platform, storeScoped, type StoreScopedClient } from "../db";
import { allocateLineDiscounts } from "../coupon/discount";
import { PREPARED_FOOD_TAX_CODE } from "../listing/prepared";
import type { Fulfillment } from "../customer-flow/contracts";
import {
  getTaxCalculator,
  TaxLocationError,
  TaxUnavailableError,
  type TaxAddress,
  type TaxLiableParty,
  type TaxLine,
  type TaxLineInput,
} from "./calculator";

/**
 * The tax a checkout charges (#65): one Stripe Tax calculation per basket, address and liable party,
 * pinned on the cart like the courier quote, so a quote refresh never calls Stripe again and placement
 * charges exactly what the hold was sized on.
 */

export type CheckoutTax = {
  calculationId: string | null;
  taxCents: number;
  lines: TaxLine[];
  liableParty: TaxLiableParty;
  key: string;
};

export type TaxedLine = { variantId: string; qty: number; price: number };

type ScopedTx = Pick<StoreScopedClient, "listingVariant" | "cart">;

/**
 * Each variant's tax code: prepared food's (#570), else its category's, else the parent category's,
 * else null (the account preset).
 */
export async function variantTaxCodes(db: ScopedTx, variantIds: string[]): Promise<Map<string, string | null>> {
  const variants = await db.listingVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      listing: {
        select: {
          prepared: true,
          masterProduct: { select: { category: { select: { taxCode: true, parent: { select: { taxCode: true } } } } } },
        },
      },
    },
  });
  return new Map(variants.map((variant) => {
    if (variant.listing.prepared != null) return [variant.id, PREPARED_FOOD_TAX_CODE];
    const category = variant.listing.masterProduct?.category;
    return [variant.id, category?.taxCode ?? category?.parent?.taxCode ?? null];
  }));
}

export type DeliveryAddressFields = {
  deliveryLine1: string | null;
  deliveryLine2: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryZip: string | null;
};

/** Pickup is taxed where the shopper takes the goods, the store; delivery at the delivery address. */
export function taxAddress(
  fulfillment: Fulfillment,
  store: { addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; zip: string | null },
  cart: DeliveryAddressFields,
): TaxAddress {
  if (fulfillment !== "pickup" && cart.deliveryLine1) {
    return { line1: cart.deliveryLine1, line2: cart.deliveryLine2, city: cart.deliveryCity, state: cart.deliveryState, postalCode: cart.deliveryZip };
  }
  return { line1: store.addressLine1, line2: store.addressLine2, city: store.city, state: store.state, postalCode: store.zip };
}

/** Goods per line after the coupon's discount, the amounts Stripe taxes; by variant, so the read order never changes the key. */
export function taxLineInputs(lines: TaxedLine[], discountCents: number, codes: Map<string, string | null>): TaxLineInput[] {
  const sorted = [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
  const charges = sorted.map((line) => line.price * line.qty);
  const discounts = allocateLineDiscounts(charges, discountCents);
  return sorted.map((line, index) => ({
    reference: line.variantId,
    amountCents: charges[index] - discounts[index],
    taxCode: codes.get(line.variantId) ?? null,
  }));
}

async function checkoutTaxInputs(
  db: ScopedTx,
  storeId: string,
  cartId: string,
  lines: TaxedLine[],
  discountCents: number,
  fulfillment: Fulfillment,
  delivery: DeliveryAddressFields | null = null,
) {
  const [store, cart, codes] = await Promise.all([
    platform.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { addressLine1: true, addressLine2: true, city: true, state: true, zip: true, taxLiableParty: true, stripeAccountId: true },
    }),
    db.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: {
        deliveryLine1: true, deliveryLine2: true, deliveryCity: true, deliveryState: true, deliveryZip: true,
        taxCents: true, taxLines: true, taxLiableParty: true, taxCalculationId: true, taxQuoteKey: true,
      },
    }),
    variantTaxCodes(db, lines.map((line) => line.variantId)),
  ]);
  const address = taxAddress(fulfillment, store, delivery ?? cart);
  const liableParty: TaxLiableParty = store.taxLiableParty === "store" ? "store" : "platform";
  const taxLines = taxLineInputs(lines, discountCents, codes);
  const key = JSON.stringify({ address, liableParty, lines: taxLines });
  return { store, cart, address, liableParty, taxLines, key };
}

function pinned(cart: { taxCents: number | null; taxLines: unknown; taxLiableParty: string | null; taxCalculationId: string | null; taxQuoteKey: string | null }, key: string): CheckoutTax | null {
  if (cart.taxQuoteKey !== key || cart.taxCents == null) return null;
  return {
    calculationId: cart.taxCalculationId,
    taxCents: cart.taxCents,
    lines: (cart.taxLines ?? []) as TaxLine[],
    liableParty: cart.taxLiableParty === "store" ? "store" : "platform",
    key,
  };
}

/**
 * The quote's tax: the pinned calculation when the basket and address are unchanged, else a new one.
 * `delivery` is the confirmed address in the request, which the cart saves only after the hold.
 */
export async function quoteCheckoutTax(
  storeId: string,
  cartId: string,
  lines: TaxedLine[],
  discountCents: number,
  fulfillment: Fulfillment,
  delivery: DeliveryAddressFields | null = null,
): Promise<CheckoutTax> {
  const db = storeScoped(storeId);
  const inputs = await checkoutTaxInputs(db, storeId, cartId, lines, discountCents, fulfillment, delivery);
  const kept = pinned(inputs.cart, inputs.key);
  if (kept) return kept;
  if (lines.length === 0) return { calculationId: null, taxCents: 0, lines: [], liableParty: inputs.liableParty, key: inputs.key };
  const calculation = await getTaxCalculator().calculate({
    address: inputs.address,
    lines: inputs.taxLines,
    liableParty: inputs.liableParty,
    stripeAccount: inputs.store.stripeAccountId,
    idempotencyKey: `tax-calculation:${cartId}:${createHash("sha256").update(inputs.key).digest("hex").slice(0, 32)}`,
  });
  if (calculation.lines.reduce((sum, line) => sum + line.amount, 0) !== calculation.taxCents && calculation.lines.length > 0) {
    throw new TaxUnavailableError(new Error("Tax lines do not sum to the tax total"));
  }
  await db.cart.update({
    where: { id: cartId },
    data: {
      taxCents: calculation.taxCents,
      taxLines: calculation.lines as unknown as Prisma.InputJsonValue,
      taxLiableParty: inputs.liableParty,
      taxCalculationId: calculation.id,
      taxQuoteKey: inputs.key,
    },
  });
  return { calculationId: calculation.id, taxCents: calculation.taxCents, lines: calculation.lines, liableParty: inputs.liableParty, key: inputs.key };
}

/** Placement charges the tax the hold was sized on and never calls Stripe; null means the basket changed since. */
export async function pinnedCheckoutTax(
  db: ScopedTx,
  storeId: string,
  cartId: string,
  lines: TaxedLine[],
  discountCents: number,
  fulfillment: Fulfillment,
): Promise<CheckoutTax | null> {
  const inputs = await checkoutTaxInputs(db, storeId, cartId, lines, discountCents, fulfillment);
  return pinned(inputs.cart, inputs.key);
}

export { TaxLocationError, TaxUnavailableError };
