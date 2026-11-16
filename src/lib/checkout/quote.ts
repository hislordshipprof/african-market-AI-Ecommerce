import { validPhone } from "../customer-account/phone";
import { money } from "../format";
import { serviceFeeCents, type ServiceFeeSettings } from "../order/platform-fee";
import { goodsDiscountCents, type CouponTerms } from "../coupon/discount";
import type { CheckoutQuote, Contact, FlowProblem, Fulfillment } from "../customer-flow/contracts";

/** The pure checkout quote. Stripe-free, so the assistant can draw a Review card from it (#247). */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export interface StoreDeliveryQuote {
  enabled: boolean;
  feeCents: number;
  radiusMi: number;
  hasCoordinates: boolean;
  /** Null until Census has confirmed the address. Distance is not stored here. */
  confirmed: { withinRadius: boolean } | null;
  leaveAtDoor: boolean;
}

/** A Starter store does not offer courier delivery (ADR-0021). */
/** #570: hot food is handed over, never left at the door. */
export const HOT_FOOD_HANDOFF = "Hot food is handed to you, not left at the door. Turn off Leave at door.";

export const COURIER_NOT_OFFERED = "This store does not offer courier delivery.";

/** The cheapest live courier quote (#140 selection), or why courier delivery is unavailable. */
export type CourierQuoteInput =
  | { ok: true; feeCents: number; provider: "Uber Direct" | "DoorDash Drive"; leaveAtDoor: boolean; changed?: boolean }
  | { ok: false; problem: FlowProblem };

/** The cart's code, with the coupon it names when the store accepts it here, or why not (#557). */
export type QuoteCouponInput =
  | { code: string; coupon: CouponTerms & { id: string; minGoodsCents: number } }
  | { code: string; refusal: string };

/** The discount on goods only; shortfalls under the code's minimum get no discount and a note, never a block. */
function couponDiscount(goodsCents: number, input: QuoteCouponInput): { discountCents: number; message?: string } {
  if ("refusal" in input) return { discountCents: 0, message: input.refusal };
  if (goodsCents < input.coupon.minGoodsCents) {
    return { discountCents: 0, message: `Add ${money(input.coupon.minGoodsCents - goodsCents)} more to use ${input.code}.` };
  }
  return { discountCents: goodsDiscountCents(goodsCents, input.coupon) };
}

/** The coupon an order records: the one the quote applied, even when it rounded to no discount. */
export function appliedCouponId(input: QuoteCouponInput | null | undefined, quote: CheckoutQuote): string | null {
  return input && "coupon" in input && quote.coupon && !quote.coupon.message ? input.coupon.id : null;
}

/** 10% of goods and tax, capped at $20 (#64, #65). */
function holdBufferCents(goodsCents: number, taxCents: number): number {
  return Math.min(Math.round((goodsCents + taxCents) * 0.1), 2000);
}

/** The quote with Stripe Tax's amount added, on the same formula as computeQuote. */
export function withTax(quote: CheckoutQuote, taxCents: number): CheckoutQuote {
  const goodsCents = quote.subtotalCents - quote.discountCents;
  const totalCents = quote.totalCents - quote.taxCents + taxCents;
  const bufferCents = holdBufferCents(goodsCents, taxCents);
  return { ...quote, taxCents, totalCents, bufferCents, holdCents: totalCents + bufferCents };
}

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null; frozen?: boolean; perishable?: boolean; hot?: boolean }>,
  contact: Contact,
  fulfillment: Fulfillment,
  serviceFee: ServiceFeeSettings,
  delivery?: StoreDeliveryQuote | null,
  courier?: CourierQuoteInput | null,
  coupon?: QuoteCouponInput | null,
  taxCents = 0,
): CheckoutQuote {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of cartLines) {
    if (
      !Number.isInteger(line.qty) ||
      line.qty < 1
    ) {
      problems.push({ code: "max-quantity", message: "Check item quantity." });
      continue;
    }
    if (line.maxPerOrder !== null && line.qty > line.maxPerOrder) {
      problems.push({
        code: "max-quantity",
        message: `Maximum ${line.maxPerOrder} per order for this item.`,
      });
    }
    subtotalCents += line.price * line.qty;
  }

  if (!cartLines.length || subtotalCents < minimumOrderCents) {
    problems.push({
      code: "minimum-order",
      message: `Minimum order is $${(minimumOrderCents / 100).toFixed(2)}.`,
    });
  }

  if (
    !contact.name.trim() ||
    !validEmail(contact.email) ||
    !validPhone(contact.phone)
  ) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  let deliveryFeeCents = 0;
  let courierFeeCents = 0;
  let courierProvider: CheckoutQuote["courierProvider"];
  if (fulfillment === "courier") {
    if (!courier) {
      problems.push({ code: "ineligible", message: "Only pickup is available for this store." });
    } else if (!courier.ok) {
      problems.push(courier.problem);
    } else {
      // The provider's quote, no markup (ADR-0006).
      courierFeeCents = courier.feeCents;
      courierProvider = courier.provider;
      if (courier.changed) {
        problems.push({ code: "quote-changed", message: `The courier fee is now ${money(courier.feeCents)}. Check your new total, then place your order.` });
      }
      if (courier.leaveAtDoor && cartLines.some((line) => line.frozen || line.perishable)) {
        problems.push({ code: "ineligible", message: "Frozen and perishable items need a hand-to-hand delivery. Turn off Leave at door." });
      } else if (courier.leaveAtDoor && cartLines.some((line) => line.hot)) {
        problems.push({ code: "ineligible", message: HOT_FOOD_HANDOFF });
      }
    }
  } else if (fulfillment === "store-delivery") {
    // The fee stays in the hold when delivery is switched off or the radius
    // shrinks, so those refusals are visible as problems rather than a new total.
    deliveryFeeCents = Math.max(0, delivery?.feeCents ?? 0);
    if (!delivery || !delivery.enabled || !delivery.hasCoordinates || delivery.radiusMi <= 0) {
      problems.push({
        code: "ineligible",
        message: "Only pickup is available for this store.",
      });
    } else if (!delivery.confirmed) {
      problems.push({
        code: "ineligible",
        message: "We couldn't find that address",
      });
    } else if (!delivery.confirmed.withinRadius) {
      problems.push({
        code: "outside-radius",
        message: "That address is outside the delivery area",
      });
    }
    if (delivery?.leaveAtDoor && cartLines.some((line) => line.frozen)) {
      problems.push({
        code: "ineligible",
        message: "Frozen items require handoff.",
      });
    } else if (delivery?.leaveAtDoor && cartLines.some((line) => line.hot)) {
      problems.push({ code: "ineligible", message: HOT_FOOD_HANDOFF });
    }
  }

  const tipCents = 0;
  const applied = coupon ? couponDiscount(subtotalCents, coupon) : null;
  const discountCents = applied?.discountCents ?? 0;
  const goodsCents = subtotalCents - discountCents;
  const serviceFeeCentsQuoted = serviceFeeCents(goodsCents, serviceFee);
  const totalCents = goodsCents + taxCents + serviceFeeCentsQuoted + tipCents + deliveryFeeCents + courierFeeCents;
  const bufferCents = holdBufferCents(goodsCents, taxCents);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents,
    courierFeeCents,
    ...(courierProvider ? { courierProvider } : {}),
    serviceFeeCents: serviceFeeCentsQuoted,
    taxCents,
    tipCents,
    discountCents,
    ...(coupon && applied
      ? { coupon: { code: coupon.code, discountCents, ...(applied.message ? { message: applied.message } : {}) } }
      : {}),
    totalCents,
    bufferCents,
    holdCents,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    problems,
  };
}

